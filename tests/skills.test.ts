import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { repoRoot } from "./helpers.ts";

const skills = path.join(repoRoot, "skills");

test("RSI has one canonical research skill and no duplicate superagent skill", () => {
  assert.ok(fs.existsSync(path.join(skills, "rsi-research", "SKILL.md")));
  assert.ok(!fs.existsSync(path.join(skills, "rsi-superagent")));
  assert.ok(!fs.existsSync(path.join(skills, "rsi", "SKILL.md")));

  const skill = fs.readFileSync(
    path.join(skills, "rsi-research", "SKILL.md"),
    "utf8",
  );
  assert.match(skill, /^---\nname: rsi-research\n/m);
  assert.match(skill, /## Routing a run \(superagent protocol\)/);
  assert.match(skill, /action=policy/);
  assert.match(skill, /## Minimal problem JSON/);
});
