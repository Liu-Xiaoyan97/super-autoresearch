import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

import rsiExtension from "../extensions/rsi.ts";
import { fixture, repoRoot, tempDir } from "./helpers.ts";

function fakeApi(messages: Array<{ message: any; options: any }> = []) {
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const api = {
    on: () => () => {},
    registerTool: (definition: any) => tools.set(definition.name, definition),
    registerCommand: (name: string, options: any) => commands.set(name, options),
    sendMessage: (message: any, options: any) => messages.push({ message, options }),
  };
  rsiExtension(api as any);
  return { tools, commands, messages };
}

async function until(predicate: () => boolean, timeoutMs = 10000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("condition not reached");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function fakeContext(
  _out: string,
  notes: Array<{ message: string; level?: string }> = [],
  statuses: Array<{ key: string; text?: string }> = [],
  widgets: Array<{ key: string; lines?: string[]; placement?: string }> = [],
) {
  return {
    cwd: repoRoot,
    ui: {
      notify: (message: string, level?: string) => notes.push({ message, level }),
      confirm: async () => true,
      select: async () => undefined,
      input: async () => undefined,
      setStatus: (key: string, text?: string) => statuses.push({ key, text }),
      setWidget: (key: string, lines?: string[], options?: { placement?: string }) =>
        widgets.push({ key, lines, placement: options?.placement }),
    },
    modelRegistry: {},
    model: null,
    sessionManager: { getSessionId: () => "test-session", getBranch: () => [] },
  } as any;
}

test("the extension registers the RSI tools and command without side effects", () => {
  const { tools, commands } = fakeApi();
  assert.deepEqual([...tools.keys()], ["rsi_research", "rsi_job_submit", "rsi_job_status", "rsi_job_wait", "rsi_job_cancel", "rsi_job_list", "rsi_adapter_smoke", "rsi_iteration", "rsi_superagent", "rsi_inspect", "rsi_replay"]);
  assert.deepEqual([...commands.keys()], ["rsi"]);
  assert.ok([...tools.values()].every((tool) => tool.description.length > 40));
});

test("a live run writes the TUI status and clears it when the run ends", async () => {
  const { tools } = fakeApi();
  const out = tempDir("rsi-tui-");
  const statuses: Array<{ key: string; text?: string }> = [];
  const widgets: Array<{ key: string; lines?: string[]; placement?: string }> = [];
  const ctx = fakeContext(out, [], statuses, widgets);
  const research = await tools.get("rsi_research").execute(
    "call-tui",
    { problem: fixture("ood_frozen_encoder"), mode: "mock", out, seed: 7, wait: true, script: fixture("good_ablation") },
    undefined,
    undefined,
    ctx,
  );
  assert.equal(research.details.final.aborted, false);
  const live = widgets.find((entry) => entry.lines?.length === 2);
  assert.ok(live, JSON.stringify(widgets));
  assert.equal(live.placement, "belowEditor");
  assert.match(live.lines![0], /^[^ ]+ · run-/);
  assert.ok(live.lines![1].length > 0);
  assert.ok(
    widgets.some((entry) => entry.lines?.some((line) => line.includes("Super Agent:"))),
    JSON.stringify(widgets),
  );
  assert.ok(!statuses.some((entry) => entry.text?.startsWith("RSI ")), "footer does not duplicate the widget");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(statuses.at(-1)?.text, undefined, "status cleared after the run ends");
  assert.equal(widgets.at(-1)?.lines, undefined, "widget cleared after the run ends");
});

test("rsi_research and rsi_inspect work through the extension tool surface", async () => {
  const { tools } = fakeApi();
  const out = tempDir("rsi-tool-");
  const ctx = fakeContext(out);
  const research = await tools.get("rsi_research").execute(
    "call-1",
    { problem: fixture("ood_frozen_encoder"), mode: "mock", out, seed: 7, wait: true, script: fixture("good_ablation") },
    undefined,
    undefined,
    ctx,
  );
  assert.match(research.content[0].text, /RSI run/);
  assert.ok(research.details.run_id);
  assert.equal(research.details.final.aborted, false);
  assert.ok(fs.existsSync(String(research.details.artifacts.protocol)));

  const status = await tools.get("rsi_superagent").execute(
    "call-status",
    { action: "status", run_id: research.details.run_id },
    undefined,
    undefined,
    ctx,
  );
  assert.match(status.content[0].text, /run /);
  assert.equal(status.details.status.ended.outcome, "completed");
  assert.ok(status.details.status.tickets.length > 0);

  const inspect = await tools.get("rsi_inspect").execute(
    "call-2",
    { run_id: research.details.run_id, out },
    undefined,
    undefined,
    ctx,
  );
  assert.match(inspect.content[0].text, /h_best:/);
  assert.equal(inspect.details.decision_path.length > 0, true);

  const replay = await tools.get("rsi_replay").execute(
    "call-3",
    { run_id: research.details.run_id, out },
    undefined,
    undefined,
    ctx,
  );
  assert.match(replay.content[0].text, /replay matches/);
  assert.equal(replay.details.match, true);
});

for (const explicit of [false, true]) {
  test(`research dispatch inherits Pi model/thinking and forwards only explicit role caps (${explicit})`, async () => {
    const { tools } = fakeApi();
    const out = tempDir("rsi-session-inheritance-");
    const ctx = fakeContext(out);
    ctx.model = { provider: "configured-provider", id: "configured-deepseek", contextWindow: 1000000, maxTokens: 384000 };
    ctx.thinkingLevel = "xhigh";
    const response = await tools.get("rsi_research").execute("inherit-session", {
      problem: fixture("ood_frozen_encoder"), mode: "mock", out, wait: true, max_llm_calls: 3,
      ...(explicit ? { max_tokens: 384000, coding_max_tokens: 8192 } : {}),
    }, undefined, undefined, ctx);
    const root = String(response.details.root);
    const config = JSON.parse(fs.readFileSync(`${root}/state.json`, "utf8")).config;
    assert.equal(config.modelRoutes.default.provider, "configured-provider");
    assert.equal(config.modelRoutes.default.model, "configured-deepseek");
    assert.equal(config.modelRoutes.default.maxTokens, explicit ? 384000 : undefined);
    assert.equal(config.modelRoutes.coding.maxTokens, explicit ? 8192 : undefined);
    assert.match(fs.readFileSync(`${root}/superagent/state.json`, "utf8"), /"thinking":\s*"xhigh"/);
    assert.equal(ctx.model.contextWindow, 1000000);
    assert.equal(ctx.model.maxTokens, 384000);
  });
}

test("/rsi run rejects malformed explicit caps instead of silently inheriting", async () => {
  const { commands } = fakeApi();
  const notes: Array<{ message: string; level?: string }> = [];
  const ctx = fakeContext(repoRoot, notes);
  for (const flags of ["--max-tokens", "--max-tokens nope", "--max-tokens 0", "--max-tokens 1.5", "--max-tokens 8192 --max-tokens 384000", "--coding-max-tokens -1", "--coding-max-tokens Infinity"]) {
    await commands.get("rsi").handler(`run ${fixture("ood_frozen_encoder")} --mock ${flags}`, ctx);
    assert.equal(notes.at(-1)?.level, "warning", flags);
    assert.match(notes.at(-1)!.message, /positive|integer|safe/);
  }
});

test("/rsi list and unknown subcommands report through the UI", async () => {
  const { commands } = fakeApi();
  const notes: Array<{ message: string; level?: string }> = [];
  const command = commands.get("rsi");
  await command.handler("list --out /tmp/does-not-exist-rsi", fakeContext(repoRoot, notes));
  assert.match(notes.at(-1)!.message, /no runs under/);
  await command.handler("bogus", fakeContext(repoRoot, notes));
  assert.match(notes.at(-1)!.message, /unknown \/rsi subcommand/);
});

test("a dispatched run reports to the foreground session without blocking", async () => {
  const messages: Array<{ message: any; options: any }> = [];
  const { tools } = fakeApi(messages);
  const out = tempDir("rsi-dispatch-");
  const ctx = fakeContext(out);
  const dispatched = await tools.get("rsi_research").execute(
    "call-dispatch",
    { problem: fixture("ood_frozen_encoder"), mode: "mock", out, seed: 11 },
    undefined,
    undefined,
    ctx,
  );
  assert.match(dispatched.content[0].text, /accepted|already running/);
  assert.equal(String(dispatched.details.ticket_id).startsWith("run-"), true);
  assert.equal(dispatched.details.final, undefined);

  await until(() => messages.some((item) => String(item.message.content).includes("RSI run finished")));
  const result = messages.find((item) => String(item.message.content).includes("RSI run finished"));
  assert.ok(result, `expected a result notice, got ${JSON.stringify(messages.map((item) => item.message.content))}`);
  assert.equal(result!.message.customType, "rsi-superagent");
  assert.equal(result!.options.triggerTurn, true);
  assert.equal(result!.options.deliverAs, "followUp");
});
