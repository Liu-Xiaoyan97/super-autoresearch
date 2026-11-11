#!/usr/bin/env bash
# Prepare the dfm-ssm repository used by examples/dfm_ssm.json.
#
#   ./scripts/setup-dfm-ssm.sh
#   DFM_SSM_REPO=git@gitlab.com:... ./scripts/setup-dfm-ssm.sh
#
# The checkout lives under vendor/, which is gitignored. The container sees it
# at /workspace/RSI/vendor/dfm-ssm because the repository is bind-mounted.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_URL="${DFM_SSM_REPO:-git@gitlab.com:Liu-Xiaoyan97/dfm-ssm.git}"
TARGET="${DFM_SSM_DIR:-$ROOT/vendor/dfm-ssm}"

mkdir -p "$(dirname "$TARGET")"
if [[ -d "$TARGET/.git" ]]; then
  echo "==> updating $TARGET"
  git -C "$TARGET" pull --ff-only
else
  echo "==> cloning $REPO_URL -> $TARGET"
  git clone --depth 1 "$REPO_URL" "$TARGET"
fi

# The benchmark harness belongs to the target project, not to RSI core. Keep it
# on a dedicated ref so RSI can use it without touching the project's main line.
ref="HEAD"
if git -C "$TARGET" rev-parse --verify -q rsi-bench >/dev/null; then
  ref="rsi-bench"
fi
tmp="$(mktemp -d)"
git -C "$TARGET" worktree add --detach -q "$tmp" "$ref"
# JSONL file/directory support in the target mamba data loader.
jsonl_patch="$ROOT/integrations/dfm_ssm/mamba-jsonl.patch"
if [[ -f "$jsonl_patch" ]] && git -C "$tmp" apply --check "$jsonl_patch" >/dev/null 2>&1; then
  git -C "$tmp" apply "$jsonl_patch"
fi
mkdir -p "$tmp/bench"
cp "$ROOT/integrations/dfm_ssm/run_experiment.py" "$tmp/bench/rsi_dfm_train_eval.py"
cp "$ROOT/integrations/dfm_ssm/dfm_lm_eval.py" "$tmp/bench/dfm_lm_eval.py"
git -C "$tmp" rm --quiet --ignore-unmatch bench/rsi_dfm_cache.py || true
git -C "$tmp" add bench/rsi_dfm_train_eval.py bench/dfm_lm_eval.py
if ! git -C "$tmp" diff --cached --quiet; then
  git -C "$tmp" -c user.name=RSI -c user.email=rsi@local \
    commit -q -m "Update RSI benchmark harness"
fi
bench_commit="$(git -C "$tmp" rev-parse HEAD)"
git -C "$TARGET" branch -f rsi-bench "$bench_commit"
git -C "$TARGET" worktree remove --force "$tmp"

echo
echo "dfm-ssm ready at: $TARGET"
echo "fixture:          examples/dfm_ssm.json"
echo "benchmark ref:     rsi-bench (bench/rsi_dfm_train_eval.py)"
echo
echo "Smoke-test the benchmark (needs torch):"
echo "  git -C \"$TARGET\" worktree add --detach /tmp/dfm-check rsi-bench"
echo "  python3 /tmp/dfm-check/bench/rsi_dfm_train_eval.py --repo /tmp/dfm-check \\"
echo "    --scope subset --out /tmp/dfm-report.json"
echo
echo "Run through RSI (inside the container):"
echo "  /rsi run examples/dfm_ssm.json --mock"
echo "  /rsi run examples/dfm_ssm.json --provider opencode-go --model deepseek-v4.1-flash --thinking low"
