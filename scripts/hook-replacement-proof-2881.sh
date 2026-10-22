#!/usr/bin/env bash
set -euo pipefail

task_root=$PWD
export HOME="$task_root/home" TMPDIR="$task_root/tmp"
export XDG_CACHE_HOME="$task_root/cache" npm_config_cache="$task_root/npm-cache"
export PNPM_HOME="$task_root/toolchain/bin" NODE_OPTIONS=--max-old-space-size=7168
mkdir -p "$HOME" "$TMPDIR" "$XDG_CACHE_HOME" "$PNPM_HOME"
task_head=f57389aa81eba4a0fd2820d1c4867ae20e723896
printf 'PROOF source=%s cpu_max=3 memory_max=10GiB work_volume=12GB gpu=none model=none\n' "$task_head"
task_gateway_pid=
cleanup() {
  local task_status=$?
  if [[ "$task_status" -ne 0 ]]; then
    df -B1 "$task_root"
    du -sh "$task_root"/* 2>/dev/null || true
    if [[ -f "$task_root/gateway.log" ]]; then tail -100 "$task_root/gateway.log"; fi
  fi
  if [[ -n "$task_gateway_pid" ]]; then kill "$task_gateway_pid" 2>/dev/null || true; fi
}
trap cleanup EXIT
node --version
git init -q source
git -C source fetch -q --depth=1 https://github.com/openclaw/openclaw.git "$task_head"
git -C source checkout -q --detach FETCH_HEAD
test "$(git -C source rev-parse HEAD)" = "$task_head"
npm install --prefix "$task_root/toolchain" --ignore-scripts --no-audit --no-fund pnpm@12.10.1
export PATH="$task_root/toolchain/node_modules/.bin:$PATH"
cd source
pnpm install --frozen-lockfile --store-dir "$task_root/pnpm-store"
pnpm openclaw --version
export OPENCLAW_STATE_DIR="$task_root/state" OPENCLAW_CONFIG_PATH="$task_root/state/openclaw.json"
python3 "$task_root/hook-replacement-proof-2881.py" configure
pnpm openclaw plugins install --link "$task_root/reload-probe" --force --accept-capabilities
pnpm openclaw plugins enable reload-probe --accept-capabilities
pnpm openclaw gateway run --port 18792 --allow-unconfigured > "$task_root/gateway.log" 2>&1 &
task_gateway_pid=$!
for task_try in {1..120}; do
  if pnpm openclaw gateway call health --json > "$task_root/health.json" 2> /dev/null; then break; fi
  kill -0 "$task_gateway_pid"
  sleep 2
done
pnpm openclaw gateway call health --json > "$task_root/health.json"
python3 "$task_root/hook-replacement-proof-2881.py" run
