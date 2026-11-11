import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

import rsiExtension from "../extensions/rsi.ts";
import { repoRoot, tempDir } from "./helpers.ts";

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

function fakeContext(_out: string, notes: Array<{ message: string; level?: string }> = []) {
  return {
    cwd: repoRoot,
    ui: {
      notify: (message: string, level?: string) => notes.push({ message, level }),
      confirm: async () => true,
      select: async () => undefined,
      input: async () => undefined,
      setStatus: () => {},
      setWidget: () => {},
    },
    modelRegistry: {},
    model: null,
    sessionManager: { getSessionId: () => "test-session", getBranch: () => [] },
  } as any;
}

test("the extension registers the RSI tools and command without side effects", () => {
  const { tools, commands } = fakeApi();
  assert.deepEqual([...tools.keys()], ["rsi_research", "rsi_superagent", "rsi_inspect", "rsi_replay"]);
  assert.deepEqual([...commands.keys()], ["rsi"]);
  assert.ok([...tools.values()].every((tool) => tool.description.length > 40));
});

test("rsi_research and rsi_inspect work through the extension tool surface", async () => {
  const { tools } = fakeApi();
  const out = tempDir("rsi-tool-");
  const ctx = fakeContext(out);
  const research = await tools.get("rsi_research").execute(
    "call-1",
    { problem: "examples/ood_frozen_encoder.json", mode: "mock", out, seed: 7, wait: true },
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
    { problem: "examples/ood_frozen_encoder.json", mode: "mock", out, seed: 11 },
    undefined,
    undefined,
    ctx,
  );
  assert.match(dispatched.content[0].text, /accepted|already running/);
  assert.equal(String(dispatched.details.ticket_id).startsWith("run-"), true);
  assert.equal(dispatched.details.final, undefined);

  await until(() => messages.length > 0);
  const result = messages.find((item) => String(item.message.content).includes("RSI run finished"));
  assert.ok(result, `expected a result notice, got ${JSON.stringify(messages.map((item) => item.message.content))}`);
  assert.equal(result!.message.customType, "rsi-superagent");
  assert.equal(result!.options.triggerTurn, true);
  assert.equal(result!.options.deliverAs, "followUp");
});
