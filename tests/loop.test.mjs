import assert from "node:assert/strict";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test from "node:test";

import { reconstruct } from "../extensions/pi-skillopt/jsonl.ts";
import { evaluateGate } from "../extensions/pi-skillopt/gate.ts";
import { stepsSinceNewBest } from "../extensions/pi-skillopt/index.ts";

function withJsonl(lines, fn) {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "skillopt-loop-"));
  try {
    fs.writeFileSync(path.join(dir, "skillopt.jsonl"), lines.join("\n") + "\n");
    fn(path.join(dir, "skillopt.jsonl"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const config = JSON.stringify({ type: "config", timestamp: 1, name: "demo", skill_under_test: "./s/SKILL.md", task_pack: "./tasks", gate_metric: "hard", splits: { train: 3, selection: 2, test: 1 } });
const step = (s, action, hard) =>
  JSON.stringify({ type: "step", step: s, segment: 0, timestamp: s, edit: "e", sel_hard: hard, sel_soft: hard, gate_metric: "hard", action, current_score: hard, best_score: hard, edit_budget: 3, confidence: null, skill_version: action === "reject" ? undefined : `skill_v000${s}.md` });

// The runaway bug: gating against the PERSISTED log (not in-memory state that
// resets across turns) must reject a second 100% step instead of calling it a
// new best — otherwise every additive edit is kept and the skill balloons.
test("a second consecutive 100% step rejects when gated against the persisted log", () => {
  withJsonl([config, step(1, "accept_new_best", 1.0)], (jsonlPath) => {
    const persisted = reconstruct(jsonlPath);
    assert.equal(persisted.bestScore, 1.0);
    const outcome = evaluateGate({
      candidateSkill: "x",
      candHard: 1.0,
      metric: "hard",
      current: { currentSkill: "x", currentScore: persisted.currentScore, bestSkill: "x", bestScore: persisted.bestScore, bestStep: 1 },
      step: 2,
    });
    assert.equal(outcome.action, "reject"); // 1.0 is not > 1.0
  });
});

test("a genuine improvement over the persisted best is accepted", () => {
  withJsonl([config, step(1, "accept_new_best", 0.5)], (jsonlPath) => {
    const persisted = reconstruct(jsonlPath);
    const outcome = evaluateGate({
      candidateSkill: "x",
      candHard: 0.8,
      metric: "hard",
      current: { currentSkill: "x", currentScore: persisted.currentScore, bestSkill: "x", bestScore: persisted.bestScore, bestStep: 1 },
      step: 2,
    });
    assert.equal(outcome.action, "accept_new_best");
    assert.equal(outcome.bestScore, 0.8);
  });
});

test("stepsSinceNewBest counts steps since the last new best", () => {
  const mk = (action) => ({ action });
  assert.equal(stepsSinceNewBest([]), 0);
  assert.equal(stepsSinceNewBest([mk("accept_new_best")]), 0);
  assert.equal(stepsSinceNewBest([mk("accept_new_best"), mk("reject"), mk("reject")]), 2);
  assert.equal(stepsSinceNewBest([mk("reject"), mk("reject")]), 2); // never improved
});
