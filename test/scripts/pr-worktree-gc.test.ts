import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

describe("PR worktree cleanup", () => {
  let scratch: string;
  let root: string;
  let checkout: string;
  let head: string;
  let metadata: Record<string, unknown>;
  let env: NodeJS.ProcessEnv;

  function git(cwd: string, ...args: string[]) {
    return execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-C", cwd, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  }

  function gc(...args: string[]) {
    return spawnSync("bash", [path.join(root, "scripts/pr"), "gc", ...args], {
      cwd: root,
      env,
      encoding: "utf8",
      timeout: 60_000,
    });
  }

  beforeEach(() => {
    scratch = mkdtempSync(path.join(tmpdir(), "pr-gc-"));
    root = path.join(scratch, "primary with spaces");
    checkout = path.join(root, ".worktrees/pr-123");
    mkdirSync(root);
    git(root, "init", "-b", "main");
    git(root, "config", "user.name", "Fixture");
    git(root, "config", "user.email", "fixture@example.com");
    writeFileSync(path.join(root, ".gitignore"), ".local/\nnode_modules/\n.worktrees/\n");
    writeFileSync(path.join(root, "file"), "base\n");
    git(root, "add", ".");
    git(root, "commit", "-m", "base");
    git(root, "worktree", "add", "-b", "temp/pr-123", checkout);
    writeFileSync(path.join(checkout, "file"), "reviewed PR head\n");
    git(checkout, "commit", "-am", "PR head");
    head = git(checkout, "rev-parse", "HEAD");
    git(root, "merge", "--squash", "temp/pr-123");
    git(root, "commit", "-m", "squash merge");
    git(root, "update-ref", "refs/remotes/origin/main", git(root, "rev-parse", "HEAD"));
    metadata = {
      number: 123,
      url: "https://github.com/upstream/project/pull/123",
      state: "MERGED",
      baseRefName: "main",
      headRefName: "fork-feature",
      headRefOid: head,
      mergeCommit: { oid: git(root, "rev-parse", "HEAD") },
    };
    mkdirSync(path.join(checkout, ".local"));
    writeFileSync(path.join(checkout, ".local/pr-meta.json"), JSON.stringify(metadata));
    writeFileSync(path.join(scratch, "pr.json"), JSON.stringify(metadata));
    mkdirSync(path.join(root, "scripts"));
    cpSync(path.resolve("scripts/pr"), path.join(root, "scripts/pr"));
    cpSync(path.resolve("scripts/pr-lib"), path.join(root, "scripts/pr-lib"), { recursive: true });
    mkdirSync(path.join(root, "node_modules/.bin"), { recursive: true });
    symlinkSync(
      path.resolve("node_modules/.bin/repo-prune-merged-worktrees"),
      path.join(root, "node_modules/.bin/repo-prune-merged-worktrees"),
    );
    mkdirSync(path.join(scratch, "bin"));
    writeFileSync(
      path.join(scratch, "bin/gh"),
      "#!/usr/bin/env bash\n" +
        "[[ ${GH_UNAVAILABLE:-false} != true ]] || exit 1\n" +
        'if [[ $1 == api ]]; then echo "[[]]"; elif [[ $2 == list ]]; then echo "[]"; else cat "$PR_JSON"; fi\n',
      { mode: 0o755 },
    );
    env = {
      ...process.env,
      PATH: `${scratch}/bin:${process.env.PATH}`,
      PR_JSON: `${scratch}/pr.json`,
    };
  });

  afterEach(() => rmSync(scratch, { recursive: true, force: true }));

  it("audits by default and deletes only the exact merged temporary head", () => {
    expect(gc().stdout).toContain("SAFE\t");
    expect(git(checkout, "rev-parse", "HEAD")).toBe(head);
    git(root, "branch", "pr-123-prep");
    const result = gc("--delete");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("REMOVED\t");
    expect(git(root, "branch", "--list", "temp/pr-123")).toBe("");
    expect(git(root, "branch", "--list", "pr-123-prep")).toContain("pr-123-prep");
  }, 120_000);

  it("keeps closed unmerged PRs and unavailable GitHub evidence", () => {
    writeFileSync(path.join(scratch, "pr.json"), JSON.stringify({ ...metadata, state: "CLOSED" }));
    expect(gc("--delete").stdout).toContain("KEEP\t");
    env.GH_UNAVAILABLE = "true";
    expect(gc("--delete").stdout).toContain("KEEP\t");
    expect(git(checkout, "rev-parse", "HEAD")).toBe(head);
  }, 120_000);

  it("keeps user edits, changed heads, and missing metadata", () => {
    writeFileSync(path.join(checkout, "file"), "user edit\n");
    expect(gc("--delete").stdout).toContain("dirty:");
    expect(execFileSync("cat", [path.join(checkout, "file")], { encoding: "utf8" })).toBe(
      "user edit\n",
    );
    git(checkout, "commit", "-am", "unmerged edit");
    expect(gc("--delete").stdout).toContain("unverified:pr-metadata");
    rmSync(path.join(checkout, ".local/pr-meta.json"));
    expect(gc("--delete").stdout).toContain("unverified:pr-metadata");
    expect(git(checkout, "rev-parse", "HEAD")).not.toBe(head);
  }, 120_000);

  it("rejects old and unknown deletion flags", () => {
    expect(gc("--dry-run").status).toBe(2);
    expect(gc("--force").status).toBe(2);
    expect(gc("--delete", "extra").status).toBe(2);
    expect(git(checkout, "rev-parse", "HEAD")).toBe(head);
  });
});
