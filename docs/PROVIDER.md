# Provider configuration

RSI uses Pi's provider registry and, unless explicitly overridden, inherits the
**current Pi session's selected provider, model and thinking level**. It does not
force `opencode-go`, Flash or `low` thinking. The container configuration below
is one explicit startup preference; Pi's built-in `opencode-go` catalogue needs
no additional `models.json` entry.

## What was copied

| Item | Host | Container |
|---|---|---|
| API key | `~/.pi/agent/auth.json` → `opencode-go.key` | `container/.env` → `OPENCODE_API_KEY` (mode 600, gitignored) |
| Full auth | `~/.pi/agent/auth.json` | `container/pi-home/auth.json` (mode 600, gitignored) via `./container/up.sh auth` |
| Provider id | `opencode-go` | same |
| Container startup preference | — | `container/pi-home/settings.json` → `deepseek-v4.1-flash` (RSI follows the active session) |
| Catalogue | built into Pi | built into Pi |

The host proxy is copied too. Inside the Kiri VM, `127.0.0.1` is the container,
not the Mac, so `sync-credentials.sh` rewrites a host-loopback proxy to
`host.docker.internal:7890`. Pi and npm both read `HTTP_PROXY`/`HTTPS_PROXY`:

```dotenv
CONTAINER_HTTP_PROXY=http://host.docker.internal:7890
CONTAINER_HTTPS_PROXY=http://host.docker.internal:7890
CONTAINER_NO_PROXY=localhost,127.0.0.1,.local,host.kiri.internal
```

The key is injected by compose:

```yaml
environment:
  OPENCODE_API_KEY: ${OPENCODE_API_KEY:?set OPENCODE_API_KEY in container/.env}
```

Pi's `opencode-go` provider reads `OPENCODE_API_KEY` automatically. The
credential's SHA-256 prefix inside the container matches the host's
`auth.json`, so this is the same subscription, not a new key.

## Example startup settings (container)

`container/pi-home/settings.json` is bind-mounted to `/root/.pi/agent/settings.json`:

```json
{
  "defaultProvider": "opencode-go",
  "defaultModel": "deepseek-v4.1-flash",
  "defaultThinkingLevel": "high",
  "defaultProjectTrust": "always",
  "packages": []
}
```

## Refresh or change the credential

```bash
./container/sync-auth.sh                        # copy the full auth.json
./container/sync-credentials.sh                 # re-copy the opencode-go key into .env
OPENCODE_API_KEY=sk-... ./container/sync-credentials.sh
./container/up.sh down && ./container/up.sh run # compose re-reads .env
```

`auth.json` contains OAuth refresh tokens. If both the host and the container
refresh the same OAuth provider, one side can invalidate the other; prefer the
API-key providers (`opencode-go`) for container runs, or run `/login` inside the
container and keep the copies separate.

Or edit `container/.env` directly, then restart the container.

## Choose another model

Selection starts with the active Pi session (`/model` and `/thinking`). Container
startup settings only select initial preferences, not a fixed RSI route.
Explicit user overrides remain available:

1. **Pi startup preference** — edit `container/pi-home/settings.json`
   (`defaultProvider` / `defaultModel` / `defaultThinkingLevel`), then restart Pi.
2. **RSI route preferences** — explicit environment overrides read by the extension:
   ```bash
   RSI_MODEL=glm-5.3-flash
   RSI_CODING_MODEL=kimi-k3      # coding / ablation / rebuttal / draft_enhancer
   ```
3. **Per run** — tool arguments or the slash command:
   ```text
   rsi_research { problem: "...", provider: "opencode-go", model: "glm-5.3-flash", coding_model: "kimi-k3" }
   /rsi run tests/fixtures/ood_frozen_encoder.json --provider opencode-go --model glm-5.3-flash
   ```

`opencode-go` models include `deepseek-v4.1-flash`, `deepseek-v4-pro`,
`glm-5.3-flash`, `kimi-k3`, `gpt-6-luna`, `qwen3.8-flash`, `minimax-m3.1-flash`.
List the authenticated catalogue with:

```bash
./container/up.sh exec pi --list-models | grep opencode-go
```

## How the extension calls models

* `agents=subagent` (default): each RSI agent runs in its own Pi subagent
  session via `createAgentSession`, with a per-agent system prompt and an
  in-memory history. Model and credential resolution stay inside Pi.
* `agents=inline`: nested `ctx.modelRegistry.complete()` calls with no subagent
  session (faster startup, shared context budget).
* Provider id, model and thinking inherit the current session unless overridden.
  Tool access remains task-specific; model inheritance grants no blanket shell,
  GPU or experiment rights.
* `opencode-go` requires the `x-opencode-session` header; the extension passes
  Pi's session id on every nested call and subagent session.

## Output capacity and explicit caps

`rsi_research` and `rsi_iteration` accept optional positive-integer `max_tokens`
(all-role output cap) and `coding_max_tokens` (more specific coding-role override).
The native Pi commands `/rsi run` and `/rsi iterate` expose `--max-tokens N` and
`--coding-max-tokens N`. Omit them to use **the same Pi native request policy and
model capability as ordinary Pi**: RSI adds neither an 8192 default cap nor a
fixed 131072 coding ceiling. `0` / `null` are not “use the maximum” settings.

For the user's DeepSeek configuration, 1M context and `maxTokens=384000` remain
unchanged on the inherited model object. This metadata is capability, not a
required output length. The audited Pi 1.5.2 SDK defaults to model.maxTokens,
then fits output to remaining context. This model therefore allows 384000 on a
short request; less context room can lower it, and generation may end early.
Other models retain their own configured limits, not a global 384000 override. An explicit `8192` or `384000` cap is honored within the selected model's
output capability, never used to expand that capability or change its context.

The old inline/bounded request path imposed 8k; the actual `PiWorker` child
previously ignored that payload cap. Do not describe that as an 8k ceiling on all
workers. Explicit caps now apply consistently to native workers and inline calls;
without a cap the inherited model object is left unaltered.

Task history isolation, selective source loading, protected evaluation/training
protocols, tool allowlists, model-call/wall-clock budgets and spending/experiment
authority remain intact. A two-step GPU training budget is independent of LLM
capacity. See `docs/SPEC.md` for regression expectations; these are not claims
that a new real DeepSeek/GPU verification has already passed.

## Web search model

`pi-web-search` is installed and uses a dedicated provider-native search model,
independently of the active conversation model:

```json
// container/pi-home/web-search.json
{ "provider": "opencode-go", "model": "gpt-5.6-luna" }
```

Only `ideas.novelty` and `integrity.refs` subagents get the `web_search` tool;
the rest run without extensions or tools. Test it with:

```bash
./container/up.sh exec bash -lc 'cd /workspace/RSI && pi -p --no-session \
  --tools web_search --thinking low --model opencode-go/gpt-5.6-luna \
  "Use web_search for query: mamba state space model. Return the first result title."'
```

## Verify

```bash
./container/up.sh exec pi auth check --provider opencode-go
./container/up.sh exec pi --print --no-session --model opencode-go/deepseek-v4.1-flash "Reply with: OK"
./container/up.sh exec bash -lc 'cd /workspace/RSI && pi -ne -e ./extensions/rsi.ts -nbt --tools rsi_research -p --no-session \
  "Call rsi_research with problem tests/fixtures/ood_frozen_encoder.json, mode mock, out /tmp/rsi-check"'
```

Expected: `ready`, `OK`, and a completed offline run (no model cost).

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `no credential for opencode-go` | `.env` missing or container not restarted | `./container/sync-credentials.sh && ./container/up.sh down && ./container/up.sh run` |
| `MissingSessionID` / 400 | nested call did not pass a session id | use this extension's `PiLLMProvider`/`PiWorker`; both pass `sessionId` |
| `model '...' is not available` | typo or provider mismatch | `pi --list-models`, then use `provider/model` |
| Provider works in Pi but not in the CLI | CLI has no Pi model registry | use `--mock`, or set `OPENCODE_API_KEY` and run `--provider opencode` (OpenAI-compatible transport) |
| `fetch failed` / timeout in the container | Kiri VM cannot reach the host loopback proxy | `./container/up.sh creds` (rewrites to `host.docker.internal:7890`), then `down`/`run` |
