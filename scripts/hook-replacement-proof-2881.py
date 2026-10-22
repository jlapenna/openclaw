"""Real scheduled exec before/after supported plugin replacement, isolated state."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time

ROOT = Path(os.environ["OPENCLAW_STATE_DIR"]).parent
STATE = ROOT / "state"
SOURCE = "f57389aa81eba4a0fd2820d1c4867ae20e723896"
MARKER = "HOOK_EXEC_2881"


def cli(*args, check=True):
    result = subprocess.run(
        ["bash", "-c", 'exec pnpm openclaw "$@"', "hook-proof-cli", *args],
        cwd=ROOT / "source", text=True, capture_output=True, timeout=180,
    )
    start = result.stdout.find("{\n")
    if start < 0:
        raise RuntimeError(f"CLI JSON missing: {result.stdout[-1500:]} {result.stderr[-1500:]}")
    value = json.JSONDecoder().raw_decode(result.stdout[start:])[0]
    if check and result.returncode:
        raise RuntimeError(f"CLI failed: {json.dumps(value)}")
    return value


def configure():
    STATE.mkdir(parents=True)
    workspace = ROOT / "workspace"
    workspace.mkdir()
    config = {
        "gateway": {"mode": "local", "bind": "loopback", "port": 18792,
                    "auth": {"mode": "token", "token": "isolated-hook-proof-not-a-secret"}},
        "cron": {"enabled": True},
        "plugins": {"slots": {"memory": "none"}},
        "tools": {"exec": {"host": "gateway", "security": "full", "ask": "off"}},
        "agents": {"ownership": "explicit", "entries": {
            "main": {"workspace": str(workspace),
                     "tools": {"profile": "minimal", "alsoAllow": ["exec"]}},
        }},
    }
    (STATE / "openclaw.json").write_text(json.dumps(config))
    plugin = ROOT / "reload-probe"
    plugin.mkdir()
    (plugin / "package.json").write_text(json.dumps({
        "name": "reload-probe", "version": "1.0.0", "type": "module",
        "openclaw": {"extensions": ["./index.js"]},
    }))
    (plugin / "openclaw.plugin.json").write_text(json.dumps({
        "id": "reload-probe", "activation": {"onStartup": True},
        "configSchema": {"type": "object", "additionalProperties": False, "properties": {}},
    }))
    shutil.copyfile(ROOT / "hook-replacement-proof-2881.mjs", plugin / "index.js")
    (ROOT / "scheduled.js").write_text(
        "const r = await exec({command: 'printf HOOK_EXEC_2881', timeoutSeconds: 10, yieldMs: 1000});\n"
        "if (r.status !== 'completed' || r.exitCode !== 0 || r.aggregated.trim() !== 'HOOK_EXEC_2881') "
        "throw new Error('Actual exec failed: ' + JSON.stringify(r));\n"
        "const runs = (trigger.state?.runs ?? 0) + 1;\n"
        "return {notify: 'HOOK_EXEC_2881:' + runs, state: {runs}};\n"
    )


def observations():
    result = []
    for line in (ROOT / "gateway.log").read_text(errors="replace").splitlines():
        start = line.find('{"probe":"reload-probe"')
        if start >= 0:
            event = json.JSONDecoder().raw_decode(line[start:])[0]
            result.append(event)
    return result


def process_start_ticks(pid):
    # Linux stat starts with pid and parenthesized comm; starttime is field22.
    return (Path("/proc") / str(pid) / "stat").read_text().rsplit(")", 1)[1].split()[19]


def wait_scheduled(job_id, after_ms, build):
    deadline = time.monotonic() + 180
    while time.monotonic() < deadline:
        history = cli("cron", "runs", job_id, "--sort", "asc", "--limit", "20", "--json")
        entries = [e for e in history.get("entries", [])
                   if e.get("action") == "finished" and e.get("runAtMs", 0) >= after_ms]
        if entries:
            entry = entries[0]
            print("SCHEDULED_RUN " + json.dumps(entry), flush=True)
            assert entry.get("status") == "ok" and not entry.get("error"), entry
            assert MARKER in entry.get("summary", ""), entry
            hooks = [e for e in observations() if e.get("phase") == "hook"
                     and e.get("toolName") == "exec" and e.get("build") == build
                     and job_id in e.get("sessionKey", "")
                     and e.get("atMs", 0) >= entry["runAtMs"]]
            assert hooks, {"entry": entry, "observations": observations()}
            return entry, hooks[-1]
        time.sleep(3)
    raise TimeoutError(f"No scheduled {build} result within 180s: {observations()}")


def run():
    started_ms = int(time.time() * 1000)
    added = cli("cron", "add", "--name", "temporary-hook-replacement-proof-2881",
                "--agent", "main", "--session", "isolated", "--every", "1m",
                "--script", str(ROOT / "scheduled.js"), "--script-timeout-seconds", "30",
                "--script-tool-budget", "2", "--tools", "exec", "--no-deliver", "--json")
    job_id = added.get("id") or added.get("job", {}).get("id")
    assert job_id, added
    proof = None
    try:
        before, old_hook = wait_scheduled(job_id, started_ms, "A")
        pid, old_instance = old_hook["pid"], old_hook["instance"]
        original_start = process_start_ticks(pid)
        plugin = ROOT / "reload-probe/index.js"
        source = plugin.read_text()
        assert source.count('const build = "A";') == 1
        plugin.write_text(source.replace('const build = "A";', 'const build = "B";'))
        reload_result = cli("plugins", "reload", "reload-probe", "--json")
        print("PLUGIN_RELOAD " + json.dumps(reload_result), flush=True)
        assert reload_result.get("ok") is True and reload_result.get("restartRequired") is False, reload_result
        assert reload_result.get("runtime", {}).get("generation"), reload_result
        reloaded_ms = int(time.time() * 1000)
        after, new_hook = wait_scheduled(job_id, reloaded_ms, "B")
        events = observations()
        print("PLUGIN_OBSERVATIONS " + json.dumps(events), flush=True)
        after_hooks = [e for e in events if e.get("phase") == "hook"
                       and job_id in e.get("sessionKey", "")
                       and e.get("atMs", 0) >= after["runAtMs"]]
        assert after_hooks and all(e.get("instance") == new_hook["instance"]
                                   and e.get("build") == "B" for e in after_hooks), after_hooks
        disposed = [e for e in events if e.get("phase") == "dispose"
                    and e.get("instance") == old_instance and e.get("build") == "A"]
        registered = [e for e in events if e.get("phase") == "register"
                      and e.get("instance") == new_hook["instance"] and e.get("build") == "B"]
        assert disposed and registered, events
        assert disposed[-1]["atMs"] <= registered[0]["atMs"] <= new_hook["atMs"], events
        assert new_hook["instance"] != old_instance and new_hook["pid"] == pid, events
        assert all(e["pid"] == pid for e in disposed + registered), events
        assert process_start_ticks(pid) == original_start
        proof = {"source": SOURCE, "job_id": job_id, "before_status": before["status"],
                 "after_status": after["status"], "before_build": "A", "after_build": "B",
                 "before_run_at_ms": before["runAtMs"], "after_run_at_ms": after["runAtMs"],
                 "old_instance": old_instance, "new_instance": new_hook["instance"],
                 "old_instance_disposed": True, "old_instance_absent_after_reload": True,
                 "gateway_pid": pid,
                 "gateway_start_ticks": original_start, "same_gateway_process": True,
                 "restart_required": reload_result["restartRequired"],
                 "runtime_generation": reload_result["runtime"]["generation"],
                 "source_digests": reload_result["runtime"].get("sourceDigests"),
                 "selected_entries": reload_result["runtime"].get("selectedEntries")}
    finally:
        removed = cli("cron", "rm", job_id, "--json", check=False)
        print("JOB_REMOVAL " + json.dumps(removed), flush=True)
        assert removed.get("removed") is True, removed
    assert proof is not None
    proof["job_removed"] = True
    print("PROOF_RESULT " + json.dumps(proof), flush=True)
    (ROOT / "result.json").write_text(json.dumps(proof))


if __name__ == "__main__":
    {"configure": configure, "run": run}[sys.argv[1]]()
