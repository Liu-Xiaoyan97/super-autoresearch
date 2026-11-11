import test from "node:test";
import assert from "node:assert/strict";

import rsiExtension from "../extensions/rsi.ts";
import { repoRoot, tempDir } from "./helpers.ts";

function fakeApi() {
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const api = {
    on: () => () => {},
    registerTool: (definition: any) => tools.set(definition.name, definition),
    registerCommand: (name: string, options: any) => commands.set(name, options),
  };
  rsiExtension(api as any);
  return { tools, commands };
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
  assert.deepEqual([...tools.keys()], ["rsi_research", "rsi_inspect", "rsi_replay"]);
  assert.deepEqual([...commands.keys()], ["rsi"]);
  assert.ok([...tools.values()].every((tool) => tool.description.length > 40));
});

test("rsi_research and rsi_inspect work through the extension tool surface", async () => {
  const { tools } = fakeApi();
  const out = tempDir("rsi-tool-");
  const ctx = fakeContext(out);
  const research = await tools.get("rsi_research").execute(
    "call-1",
    { problem: "examples/ood_frozen_encoder.json", mode: "mock", out, seed: 7 },
    undefined,
    undefined,
    ctx,
  );
  assert.match(research.content[0].text, /RSI run/);
  assert.ok(research.details.run_id);
  assert.equal(research.details.final.aborted, false);

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
