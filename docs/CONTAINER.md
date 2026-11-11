# Using pi-agent in the container

The container is a Debian slim image with Node 24, `pi` (pi-agent), Python 3,
git, ripgrep, and this repository bind-mounted at `/workspace/RSI`. Pi's config
lives in `container/pi-home/` on the host and is mounted at
`/root/.pi/agent/`.

## Prerequisites

- Kiri is running and its VM is started (open the Kiri window → Start).
- Docker CLI points at Kiri. `container/up.sh` sets
  `DOCKER_CONFIG=container/.docker` and
  `DOCKER_HOST=unix://$HOME/.kiri/run/docker.sock`, so the host's
  `credsStore: desktop` cannot break pulls.

## First start

```bash
cd "/Users/liuxiaoyan/workspace/RSI "

./container/up.sh creds     # copy ~/.pi/agent/auth.json opencode-go key → container/.env
./container/up.sh build     # build pi-agent:local (node + pi 1.5.2)
./container/up.sh run       # start container pi-agent-rsi
```

`container/.env` and `container/pi-home/auth.json` are mode 600 and gitignored.
`auth` copies all host Pi providers (`openai-codex`, `openrouter`, `opencode`,
`opencode-go`, `openai`); `creds` is the narrower opencode-go/env path. Pi reads
`auth.json` at startup, so open a new session after refreshing it.

`container/.env` also receives the host proxy,
translated for the VM (`127.0.0.1:7890` → `host.docker.internal:7890`), because
the Kiri guest cannot reach the Mac's loopback. Re-run `creds` whenever the host
subscription or proxy changes, then restart
(`./container/up.sh down && ./container/up.sh run`).

## Open a shell

```bash
./container/up.sh shell
```

Inside:

```bash
pwd                 # /workspace/RSI
pi --version        # 1.5.2
pi auth check --provider opencode-go
pi --list-models | grep opencode-go
```

## Start pi interactively

```bash
./container/up.sh shell
pi
```

`container/pi-home/settings.json` declares the local package
`"/workspace/RSI"`, so the RSI extension loads automatically in every Pi
session started from this container. The default provider/model is
`opencode-go/deepseek-v4.1-flash`.

Useful commands inside Pi:

```text
/rsi help
/rsi list
/rsi models opencode-go
/rsi run tests/fixtures/ood_frozen_encoder.json --mock
/rsi run tests/fixtures/ood_frozen_encoder.json --provider opencode-go --model deepseek-v4.1-flash --thinking low
/rsi inspect ood-frozen-encoder-s7
/rsi replay ood-frozen-encoder-s7
```

The first `--mock` run is free and deterministic. A provider run spends real
model calls; `/rsi run` asks for confirmation first.

## Use the tools from a prompt

The agent can drive the loop directly:

```text
Call rsi_research with problem tests/fixtures/ood_frozen_encoder.json, mode mock,
out runs, seed 7. Then call rsi_inspect on the returned run_id and report the
decision path.
```

Or non-interactive from the host:

```bash
./container/up.sh exec bash -lc 'cd /workspace/RSI && pi -p --no-session \
  --tools rsi_research,rsi_inspect \
  "Call rsi_research with problem tests/fixtures/ood_frozen_encoder.json, mode mock, out /tmp/rsi-check"'
```

Extension tools available in the session:

| Tool | Use |
|---|---|
| `rsi_research` | full loop; `mode=mock` or `mode=provider` |
| `rsi_inspect` | read an exported run |
| `rsi_replay` | verify the decision path from traces only |

## Run without Pi (CLI)

```bash
./container/up.sh exec bash -lc 'cd /workspace/RSI && node src/rsi/cli.ts run \
  tests/fixtures/ood_frozen_encoder.json --mock --out runs'
./container/up.sh exec bash -lc 'cd /workspace/RSI && node src/rsi/cli.ts replay \
  ood-frozen-encoder-s7 --out runs'
```

The CLI can also hit opencode-go directly through the OpenAI-compatible
transport (the extension itself always uses Pi's registry):

```bash
./container/up.sh exec bash -lc 'cd /workspace/RSI && node src/rsi/cli.ts run \
  tests/fixtures/ood_frozen_encoder.json --provider opencode --model deepseek-v4.1-flash \
  --max-llm-calls 40 --out runs'
```

## Bootstrap (automatic)

`container/bootstrap.sh` runs at container start and before
`./container/up.sh shell|exec|pi`:

- installs `openssh-client`, `rsync`, `socat` if missing (via the host proxy);
- ensures `/root/.ssh` has the config/keys mounted from `container/ssh`;
- is idempotent and does not block Pi if apt is unreachable.

Manual triggers:

```bash
./container/up.sh bootstrap
./container/up.sh ssh        # regenerate container/ssh from the host ~/.ssh
```

`container/ssh/` is gitignored. `./container/up.sh run` creates it from the host
`~/.ssh` if it is missing.

## External target repositories

Set the host workspace and container mount in `container/.env`:

```dotenv
RSI_EXTERNAL_ROOT=/Users/liuxiaoyan/workspace
RSI_TARGET_REPO=/repos/dfm-ssm
```

compose mounts `RSI_EXTERNAL_ROOT` at `/repos`. A fixture can then use
`"repo": "${RSI_TARGET_REPO}"`, `remote.worktree`, and `remote.out`; see
`examples/dfm_ssm_external.json` and `docs/REMOTE.md`.

## Tests and typecheck

The extension has no runtime npm dependencies; Pi supplies its host packages.
Only `typescript` and `@types/node` are dev dependencies. Install them on the
host (the container sees `node_modules/` through the bind mount), or inside the
container now that the proxy is configured:

```bash
npm install --registry=https://registry.npmmirror.com   # on the host
./container/up.sh exec bash -lc 'cd /workspace/RSI && npm test'
./container/up.sh exec bash -lc 'cd /workspace/RSI && npm run typecheck'
```

If `npm install` hangs, the only missing piece is the proxy; verify with
`curl -s -o /dev/null -w '%{http_code}' https://registry.npmmirror.com` inside
the container. It should print `200`.

## Web search and the dfm-ssm target

RSI can also run the benchmark on a GPU server: `Problem.remote` rsyncs the
local git worktree over SSH, selects GPUs with `CUDA_VISIBLE_DEVICES`, and
fetches the metrics JSON. See [`REMOTE.md`](REMOTE.md).

The container settings install `npm:pi-web-search` and use
`container/pi-home/web-search.json`:

```json
{ "provider": "opencode-go", "model": "gpt-5.6-luna" }
```

`web_search` is provider-native (no extra search key). RSI gives it only to the
novelty and reference-audit subagents; other agents are offline.

Prepare the real optimization target on the host (the container sees it through
the bind mount):

```bash
./scripts/setup-dfm-ssm.sh
python3 integrations/dfm_ssm/run_experiment.py --repo vendor/dfm-ssm \
  --scope subset --out /tmp/dfm-report.json
```

Then run `examples/dfm_ssm_external.json` with `runner="subprocess"` (needs `torch` in the
Python environment used by `run_experiment.py`).

## Git worktrees and cleanup

RSI targets an external git repository and creates one worktree per run at
`runs/<run_id>/worktree`. Candidate code lives in `rsi/<run_id>-<root-hash>/...`
branches in the target repository; the worktree path is only a checkout. To
inspect a candidate, use the `commit` recorded in `state.json` / `final.json`:

```bash
git -C vendor/dfm-ssm show <commit>:path/to/file
git -C vendor/dfm-ssm log --oneline --all --grep '^rsi:'
```

Removing `runs/` does not delete candidate commits. Clean stale worktree entries
with `git -C <target> worktree prune`; delete experiment branches with
`git -C <target> branch -D 'rsi/...'` when no longer needed.

## Artifacts are on the host

`/workspace/RSI` is the host repository. Runs written to `runs/` inside the
container appear at `./runs/` on the host:

```text
runs/<run_id>/
  state.json
  traces.jsonl
  final.json
  artifacts/
  worktree/        git worktree (one checkout for all candidates)
  patches/        per-candidate diffs + apply logs
```

## Stop / restart / logs

```bash
./container/up.sh logs
./container/up.sh down
./container/up.sh run
```

Rebuild only when `container/Dockerfile` or the Pi version changes.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Kiri is stopped` | Open Kiri and press Start; if it stays stopped, `rm ~/.kiri/stopped` and restart the Kiri daemon (see the provider doc). |
| `error getting credentials ... docker-credential-desktop` | Use `./container/up.sh` (it sets a clean `DOCKER_CONFIG`) instead of bare `docker`. |
| `no credential for opencode-go` | `./container/up.sh auth` and/or `./container/up.sh creds`, then start a new Pi session (or `down`/`run`). |
| `pi: command not found` | You are on the host, not in the container: `./container/up.sh shell`. |
| `ssh`/`rsync`/`socat` missing after a rebuild | `./container/up.sh bootstrap` (it installs via the host proxy). |
| Extension not loading | Check `container/pi-home/settings.json` has `"packages": ["/workspace/RSI", "npm:pi-web-search"]`, then `/reload` in Pi or start a new session. |
| `web_search` errors or returns nothing | Check `container/pi-home/web-search.json` uses a Responses model such as `opencode-go/gpt-5.6-luna`, and that the proxy is set. |
| Model missing | `pi --list-models`, pass `provider`/`model` explicitly; see `docs/PROVIDER.md`. |
| `fetch failed` / `ETIMEDOUT` inside the container | The Kiri VM cannot reach the Mac's loopback proxy. `./container/up.sh creds` writes `host.docker.internal:7890`; restart the container. Verify with `curl` above. |

## Security

The container mounts the repository read-write and receives
`OPENCODE_API_KEY`. It is a development sandbox, not a credential boundary.
Do not mount the host's `~/.pi/agent` or unrelated credentials.
