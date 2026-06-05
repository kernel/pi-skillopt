import assert from "node:assert/strict";
import test from "node:test";

import { evaluateGate, selectGateScore, editBudgetAt } from "../extensions/pi-skillopt/gate.ts";

const base = { currentSkill: "s", currentScore: 0.5, bestSkill: "b", bestScore: 0.5, bestStep: 1 };

test("selectGateScore picks the metric", () => {
  assert.equal(selectGateScore(1, 0.4, "hard"), 1);
  assert.equal(selectGateScore(1, 0.4, "soft"), 0.4);
  assert.equal(selectGateScore(1, 0, "mixed", 0.5), 0.5);
});

test("strict improvement over current AND best -> accept_new_best", () => {
  const o = evaluateGate({ candidateSkill: "c", candHard: 0.8, metric: "hard", current: base, step: 2 });
  assert.equal(o.action, "accept_new_best");
  assert.equal(o.bestScore, 0.8);
  assert.equal(o.bestStep, 2);
  assert.equal(o.currentSkill, "c");
});

test("beats current but not best -> accept, best unchanged", () => {
  const cur = { currentSkill: "s", currentScore: 0.3, bestSkill: "b", bestScore: 0.9, bestStep: 1 };
  const o = evaluateGate({ candidateSkill: "c", candHard: 0.5, current: cur, step: 4 });
  assert.equal(o.action, "accept");
  assert.equal(o.currentScore, 0.5);
  assert.equal(o.bestScore, 0.9);
  assert.equal(o.bestStep, 1);
});

test("a tie is rejected (strict improvement only)", () => {
  const o = evaluateGate({ candidateSkill: "c", candHard: 0.5, current: base, step: 3 });
  assert.equal(o.action, "reject");
  assert.equal(o.currentScore, 0.5);
  assert.equal(o.bestStep, 1);
});

test("mixed metric blends hard and soft for the gate", () => {
  const o = evaluateGate({ candidateSkill: "c", candHard: 1, candSoft: 0, metric: "mixed", mixedWeight: 0.5, current: { ...base, currentScore: 0.4, bestScore: 0.4 }, step: 2 });
  assert.equal(o.action, "accept_new_best");
  assert.equal(o.currentScore, 0.5);
});

test("editBudgetAt decays base -> min and never drops below min", () => {
  assert.equal(editBudgetAt(0, 40, 4, 1, "cosine"), 4);
  assert.equal(editBudgetAt(40, 40, 4, 1, "cosine"), 1);
  assert.equal(editBudgetAt(5, 1, 4, 1, "constant"), 4);
  for (let s = 0; s <= 40; s++) assert.ok(editBudgetAt(s, 40, 4, 1, "cosine") >= 1);
});
