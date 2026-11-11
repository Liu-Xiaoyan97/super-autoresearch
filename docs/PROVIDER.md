# Provider configuration

The container uses Pi's **built-in `opencode-go` provider** with
`deepseek-v4.1-flash` as the default model. No `models.json` entry is needed:
the provider catalogue and request routing ship with Pi.

## What was copied

| Item | Host | Container |
|---|---|---|
| API key | `~/.pi/agent/auth.json` → `opencode-go.key` | `container/.env` → `OPENCODE_API_KEY` (mode 600, gitignored) |
| Full auth | `~/.pi/agent/auth.json` | `container/pi-home/auth.json` (mode 600, gitignored) via `./container/up.sh auth` |
| Provider id | `opencode-go` | same |
| Default model | — | `container/pi-home/settings.json` → `deepseek-v4.1-flash` |
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

## Default settings (container)

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

Three equivalent layers, from broadest to narrowest:

1. **Container default** — edit `container/pi-home/settings.json`
   (`defaultProvider` / `defaultModel`), then restart Pi.
2. **RSI routes** — environment variables read by the extension:
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
* Provider id, model, thinking level, and tool access are per run.
* `opencode-go` requires the `x-opencode-session` header; the extension passes
  Pi's session id on every nested call and subagent session.

## Web search model

`pi-web-search` is installed and uses a dedicated provider-native search model,
so the conversation model can stay `deepseek-v4.1-flash`:

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
