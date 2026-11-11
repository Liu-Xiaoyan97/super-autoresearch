#!/usr/bin/env bash
# Install the dfm-ssm-external-wikitext-ppl adapter onto the target repository's benchmark ref.
#
#   TARGET_REPO=/path/to/target ./setup.sh
#
# Optional:
#   RSI_BENCH_REF=rsi-bench     branch/ref that RSI checks out
#   RSI_BENCH_BASE=HEAD         base commit when the ref does not exist yet
#
# RSI never copies the target repository into itself. This script only commits
# the benchmark harness in the target repo, which is what the fixture's
# repo_ref points at.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET_REPO="${TARGET_REPO:-}"
REF="${RSI_BENCH_REF:-rsi-bench}"
BASE="${RSI_BENCH_BASE:-HEAD}"
ADAPTER_PATH="bench/rsi_dfm_train_eval.py"
HELPER_PATH="bench/dfm_lm_eval.py"

if [[ -z "$TARGET_REPO" ]]; then
  echo "error: set TARGET_REPO=/path/to/target" >&2
  exit 2
fi
if ! git -C "$TARGET_REPO" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "error: TARGET_REPO is not a git worktree: $TARGET_REPO" >&2
  exit 2
fi
for file in run_experiment.py dfm_lm_eval.py; do
  if [[ ! -f "$ROOT/$file" ]]; then
    echo "error: adapter file missing: $ROOT/$file" >&2
    exit 2
  fi
done

if git -C "$TARGET_REPO" rev-parse --verify -q "$REF" >/dev/null; then
  BASE="$REF"
fi
current_ref="$(git -C "$TARGET_REPO" symbolic-ref --short -q HEAD || true)"
if [[ "$current_ref" == "$REF" ]]; then
  echo "error: $REF is checked out in TARGET_REPO; switch to another branch first" >&2
  exit 2
fi
for path in "$ADAPTER_PATH" "$HELPER_PATH"; do
  case "$path" in
    /*|../*|*/../*) echo "error: unsafe adapter path: $path" >&2; exit 2 ;;
  esac
done

tmp="$(mktemp -d)"
cleanup() {
  git -C "$TARGET_REPO" worktree remove --force "$tmp" >/dev/null 2>&1 || true
  rm -rf "$tmp"
}
trap cleanup EXIT

git -C "$TARGET_REPO" worktree add --detach -q "$tmp" "$BASE"
mkdir -p "$(dirname "$tmp/$ADAPTER_PATH")"
cp "$ROOT/run_experiment.py" "$tmp/$ADAPTER_PATH"
cp "$ROOT/dfm_lm_eval.py" "$tmp/$HELPER_PATH"
chmod +x "$tmp/$ADAPTER_PATH"
git -C "$tmp" add "$ADAPTER_PATH" "$HELPER_PATH"
if git -C "$tmp" diff --cached --quiet; then
  echo "adapter already up to date on $REF"
else
  git -C "$tmp" -c user.name=RSI -c user.email=rsi@local \
    commit -q -m "Add/update RSI benchmark adapter for dfm-ssm-external-wikitext-ppl"
  commit="$(git -C "$tmp" rev-parse HEAD)"
  git -C "$TARGET_REPO" branch -f "$REF" "$commit"
  echo "updated $REF -> $commit"
fi

echo
echo "adapter:  $TARGET_REPO@$REF:$ADAPTER_PATH"
echo "helper:   $TARGET_REPO@$REF:$HELPER_PATH"
echo "fixture:  examples/dfm_ssm_external.json"
echo
echo "Smoke test:"
echo "  git -C \"$TARGET_REPO\" worktree add --detach /tmp/rsi-adapter-check $REF"
echo "  python3 /tmp/rsi-adapter-check/$ADAPTER_PATH --repo /tmp/rsi-adapter-check \\"
echo "    --scope subset --out /tmp/rsi-adapter-report.json"
