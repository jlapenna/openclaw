"""Temporary real-model/native-cron proof, with isolated state and no credentials."""
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys

ROOT = Path(os.environ["OPENCLAW_STATE_DIR"]).parent
STATE = ROOT / "state"
MARKER = "COLLECTOR_PROOF_2409_COMPLETE"


def cli(*args, check=True):
    result = subprocess.run(
        ["bash", "-c", 'exec pnpm openclaw "$@"', "collector-proof-cli", *args],
        cwd=ROOT / "source",
        text=True, capture_output=True, timeout=1140,
    )
    text = result.stdout
    start = text.find("{\n")
    if start < 0:
        raise RuntimeError(f"CLI did not return JSON: {text[-1500:]} {result.stderr[-1500:]}")
    value = json.JSONDecoder().raw_decode(text[start:])[0]
    if check and result.returncode:
        raise RuntimeError(f"CLI failed: {json.dumps(value)}")
    return value


def configure():
    STATE.mkdir(parents=True)
    for name in ("parent", "collector"):
        work = ROOT / "workspaces" / name
        work.mkdir(parents=True)
        (work / "AGENTS.md").write_text(
            "This is an isolated verification workspace. Follow the current task exactly. "
            "No external actions. No exec, browsing, or messages.\n"
        )
    model = {"id": "proof-cpu", "name": "Public CPU proof model", "reasoning": False,
             "input": ["text"], "contextWindow": 16384, "maxTokens": 2048,
             "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0}}
    config = {
        "gateway": {"mode": "local", "bind": "loopback", "port": 18791,
                    "auth": {"mode": "token", "token": "isolated-public-proof-not-a-secret"}},
        "models": {"providers": {"proof": {"baseUrl": "http://127.0.0.1:18801/v1",
                    "apiKey": "public-local-model-no-secret", "api": "openai-completions",
                    "models": [model]}}},
        "plugins": {"slots": {"memory": "none"}},
        "agents": {"ownership": "explicit", "defaults": {"model": "proof/proof-cpu"}, "entries": {
            "parent": {"workspace": str(ROOT / "workspaces/parent"),
                       "subagents": {"allowAgents": ["collector"]},
                       "tools": {"profile": "minimal", "alsoAllow": ["sessions_spawn", "agents_wait", "write"]}},
            "collector": {"workspace": str(ROOT / "workspaces/collector"),
                          "tools": {"profile": "minimal"}},
        }},
    }
    (STATE / "openclaw.json").write_text(json.dumps(config))


def run():
    task = (
        "Execute this exact sequence using dispatch_action. The action IDs below are already known; "
        "do not search for or describe sessions_spawn. "
        "STEP A, ONCE ONLY: dispatch_action id='openclaw:core:sessions_spawn', "
        "args={agentId:'collector',mode:'run',collect:true,"
        "task:'Reply with exactly COLLECTOR_CHILD_2409_OK and nothing else'}. "
        "Do not set completionTarget. When status is accepted, spawning is FINISHED. "
        "Never call sessions_spawn again. Save the returned runId and move to STEP B. "
        "STEP B: dispatch_action id='openclaw:core:agents_wait', "
        "args={ids:[the actual runId from STEP A],timeoutSeconds:180}. "
        "If pending remains, repeat only STEP B with the SAME runId. "
        "STEP C: after completed contains that run with status done and result containing "
        "COLLECTOR_CHILD_2409_OK, dispatch_action id='openclaw:core:write', "
        "args={path:'proof-marker.txt',content:'" + MARKER + "'}. "
        "STEP D: finish with exactly NO_REPLY. No explanations. "
        "Only one collector is permitted. Do not repeat completed steps."
    )
    added = cli("cron", "add", "--name", "temporary-collector-proof-2409",
                "--agent", "parent", "--session", "isolated", "--at", "1h",
                "--message", task, "--model", "proof/proof-cpu@proof:manual",
                "--thinking", "off", "--light-context",
                "--tools", "sessions_spawn,agents_wait,write", "--timeout-seconds", "900",
                "--announce", "--channel", "last", "--to", "isolated-proof-target", "--json")
    job_id = added.get("id") or added.get("job", {}).get("id")
    assert job_id, added
    result = cli("cron", "run", job_id, "--wait", "--wait-timeout", "17m",
                 "--poll-interval", "5s", "--json", check=False)
    print("NATIVE_CRON_RESULT " + json.dumps(result), flush=True)
    record = result.get("run", {})
    sid = record.get("sessionId")
    assert sid, result
    db = sqlite3.connect("file:" + str(STATE / "agents/parent/agent/openclaw-agent.sqlite") + "?mode=ro", uri=True)
    accepted, completed, pending, finals, spawns = set(), set(), None, [], []
    for text, compressed in db.execute(
        "select event_json,event_zstd from transcript_events where session_id=? order by seq", (sid,)
    ):
        if not text and compressed:
            text = subprocess.run(["zstd", "-dc"], input=compressed, capture_output=True, check=True).stdout
        event = json.loads(text)
        message = event.get("message") or {}
        print("TRANSCRIPT_EVENT " + json.dumps({"role": message.get("role"),
              "toolName": message.get("toolName"), "stopReason": message.get("stopReason"),
              "content": message.get("content")})[:2200], flush=True)
        content = message.get("content") or []
        if isinstance(content, str):
            content = [{"type": "text", "text": content}]
        if message.get("role") == "assistant" and message.get("stopReason") == "stop":
            finals.append("".join(c.get("text", "") for c in content if c.get("type") == "text").strip())
        for block in content:
            if block.get("type") != "toolCall":
                continue
            name, args = block.get("name"), block.get("arguments") or {}
            if name == "dispatch_action":
                name, args = args.get("id", "").rsplit(":", 1)[-1], args.get("args") or {}
            if name == "sessions_spawn":
                spawns.append({"collect": args.get("collect"), "completionTarget": args.get("completionTarget")})
        if message.get("role") != "toolResult":
            continue
        for block in content:
            try:
                value = json.loads(block.get("text", ""))
                if not isinstance(value, dict):
                    continue
                if "result" in value and isinstance(value["result"], dict):
                    value = json.loads(value["result"]["content"][0]["text"])
                if not isinstance(value, dict):
                    continue
                if value.get("status") == "accepted":
                    accepted.add(value["runId"])
                for child in value.get("completed", []):
                    if child.get("status") == "done" and "COLLECTOR_CHILD_2409_OK" in str(child.get("result", "")):
                        completed.add(child["runId"])
                if "pending" in value:
                    pending = value["pending"]
            except (ValueError, KeyError, TypeError):
                continue
    proof = {"source": "a725a65fa2f4f95477df79dbf571e07ad0bf42db",
             "accepted_collectors": len(accepted), "collected_successfully": len(completed),
             "spawn_shapes": spawns,
             "pending": pending, "final": finals[-1] if finals else None,
             "marker": (ROOT / "workspaces/parent/proof-marker.txt").read_text().strip()
                       if (ROOT / "workspaces/parent/proof-marker.txt").exists() else None,
             "cron_status": record.get("status"), "completion_status": record.get("completionStatus"),
             "delivered": record.get("delivered"), "delivery_status": record.get("deliveryStatus"),
             "error": record.get("error"), "duration_ms": record.get("durationMs")}
    print("PROOF_RESULT " + json.dumps(proof), flush=True)
    assert len(accepted) == 1 and accepted == completed and pending == [], proof
    assert spawns == [{"collect": True, "completionTarget": None}], proof
    assert proof["final"] == "NO_REPLY" and proof["marker"] == MARKER, proof
    assert proof["cron_status"] == "ok" and not proof["error"], proof
    assert proof["completion_status"] == "succeeded" and proof["delivered"] is False, proof
    (ROOT / "result.json").write_text(json.dumps(proof))


if __name__ == "__main__":
    {"configure": configure, "run": run}[sys.argv[1]]()
