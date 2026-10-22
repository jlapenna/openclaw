#!/usr/bin/env bash
set -euo pipefail

# Temporary proof consumed by homelab#2409 / OpenClaw PR164949 review.
# All contributor code executes only in a secretless, disposable hosted VM.
task_root=$PWD
export HOME="$task_root/home" TMPDIR="$task_root/tmp"
export XDG_CACHE_HOME="$task_root/cache" npm_config_cache="$task_root/npm-cache"
export PNPM_HOME="$task_root/toolchain/bin"
export NODE_OPTIONS=--max-old-space-size=7168
mkdir -p "$HOME" "$TMPDIR" "$XDG_CACHE_HOME" "$PNPM_HOME"
task_head=eeb921936223874e20c3c5a2c0cd6104373e92fe
printf 'PROOF source=%s cpu_max=3 memory_max=10GiB work_volume=12GB gpu=none\n' "$task_head"
trap 'df -B1 "$task_root"; du -sh "$task_root"/* 2>/dev/null || true' ERR
node --version
git init -q source
git -C source fetch -q --depth=1 https://github.com/openclaw/openclaw.git "$task_head"
git -C source checkout -q --detach FETCH_HEAD
test "$(git -C source rev-parse HEAD)" = "$task_head"
npm install --prefix "$task_root/toolchain" --ignore-scripts --no-audit --no-fund pnpm@12.10.1
export PATH="$task_root/toolchain/node_modules/.bin:$PATH"
cd source
pnpm install --frozen-lockfile --store-dir "$task_root/pnpm-store"
# The supported source CLI builds the real Gateway without an unrelated
# publishable-package declaration-generation lane.
pnpm openclaw --version

cd "$task_root"
curl -fsSL -o llama.tar.gz https://github.com/ggml-org/llama.cpp/releases/download/b11803/llama-b11803-bin-ubuntu-x64.tar.gz
echo '2c718373086c9eda54d1e994cd5197aa079a4247e3dc4ec9edee8254cee08746  llama.tar.gz' | sha256sum -c -
mkdir llama
tar -xzf llama.tar.gz -C llama
# Admit model bytes plus 512 MiB runtime growth before producing them.
task_free_bytes=$(df --output=avail -B1 "$task_root" | tail -1 | tr -d ' ')
test "$task_free_bytes" -ge "$((1834426016 + 536870912))"
printf 'PROOF storage_available=%s model_bytes=1834426016 runtime_growth_reserve=536870912\n' "$task_free_bytes"
curl -fsSL -o model.gguf https://huggingface.co/Qwen/Qwen3-1.7B-GGUF/resolve/90862c4b9d2787eaed51d12237eafdfe7c5f6077/Qwen3-1.7B-Q8_0.gguf
echo '061b54daade076b5d3362dac252678d17da8c68f07560be70818cace6590cb1a  model.gguf' | sha256sum -c -
task_server=$(find "$task_root/llama" -type f -name llama-server -print -quit)
test -n "$task_server"
export LD_LIBRARY_PATH="$(dirname "$task_server")${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
"$task_server" -m "$task_root/model.gguf" --alias proof-cpu --host 127.0.0.1 \
  --port 18801 --ctx-size 32768 --parallel 1 --n-gpu-layers 0 --threads 3 \
  --threads-batch 3 --jinja --chat-template-kwargs '{"enable_thinking":false}' \
  > "$task_root/model.log" 2>&1 &
task_model_pid=$!
task_gateway_pid=
cleanup() {
  local task_status=$?
  if [[ "$task_status" -ne 0 ]]; then
    for task_log in "$task_root/gateway.log" "$task_root/model.log"; do
      if [[ -f "$task_log" ]]; then
        grep -Ei 'invalid|error|failed|fatal|exception' "$task_log" | tail -10 || true
      fi
    done
  fi
  if [[ -n "$task_gateway_pid" ]]; then kill "$task_gateway_pid" 2>/dev/null || true; fi
  kill "$task_model_pid" 2>/dev/null || true
}
trap cleanup EXIT
export OPENCLAW_STATE_DIR="$task_root/state" OPENCLAW_CONFIG_PATH="$task_root/state/openclaw.json"
python3 "$task_root/collector-proof-2409.py" configure
for task_try in {1..90}; do
  if curl -fsS http://127.0.0.1:18801/health > /dev/null; then break; fi
  kill -0 "$task_model_pid"
  sleep 2
done
curl -fsS http://127.0.0.1:18801/health > /dev/null
printf 'PROOF model=Qwen3-1.7B-Q8_0 revision=90862c4b9d2787eaed51d12237eafdfe7c5f6077 server=b11803 ready=true\n'
cd "$task_root/source"
pnpm openclaw gateway run --port 18791 --allow-unconfigured > "$task_root/gateway.log" 2>&1 &
task_gateway_pid=$!
for task_try in {1..120}; do
  if pnpm openclaw gateway call health --json > "$task_root/health.json" 2> /dev/null; then break; fi
  kill -0 "$task_gateway_pid"
  sleep 2
done
pnpm openclaw gateway call health --json > "$task_root/health.json"
python3 "$task_root/collector-proof-2409.py" run
