import assert from "node:assert/strict";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test from "node:test";

import { buildSkilloptCompactionSummary, skilloptSummaryPathsFor } from "../extensions/pi-skillopt/compaction.ts";

function withWorkDir(fn) {
  const d = fs.mkdtempSync(path.join(tmpdir(), "skillopt-compact-"));
  try {
    fn(d);
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
}

test("summary carries objective, step tally, recent steps, and the session doc", () => {
  withWorkDir((d) => {
    fs.writeFileSync(path.join(d, "skillopt.md"), "# Rules\nNever hardcode answers.");
    fs.writeFileSync(
      path.join(d, "skillopt.jsonl"),
      [
        JSON.stringify({ type: "config", timestamp: 1, name: "tighten fmt", skill_under_test: "./s/SKILL.md", task_pack: "./tasks", gate_metric: "hard", splits: { train: 3, selection: 2, test: 1 } }),
        JSON.stringify({ type: "step", step: 1, segment: 0, timestamp: 2, edit: "baseline", sel_hard: 0.5, sel_soft: 0.5, gate_metric: "hard", action: "accept_new_best", current_score: 0.5, best_score: 0.5, edit_budget: 4, confidence: null }),
        JSON.stringify({ type: "step", step: 2, segment: 0, timestamp: 3, edit: "add no-trailing-newline rule", sel_hard: 0.8, sel_soft: 0.8, gate_metric: "hard", action: "accept_new_best", current_score: 0.8, best_score: 0.8, edit_budget: 3, confidence: null }),
      ].join("\n") + "\n",
    );

    const summary = buildSkilloptCompactionSummary(skilloptSummaryPathsFor(d));
    assert.match(summary, /# SkillOpt Compaction Summary/);
    assert.match(summary, /Objective: tighten fmt/);
    assert.match(summary, /Steps so far: 2 \(2 accepted · 0 rejected\)/);
    assert.match(summary, /Best selection score: 80\.0%/);
    assert.match(summary, /add no-trailing-newline rule/);
    assert.match(summary, /Never hardcode answers\./);
  });
});

test("summary is safe when no session files exist", () => {
  withWorkDir((d) => {
    const summary = buildSkilloptCompactionSummary(skilloptSummaryPathsFor(d));
    assert.match(summary, /# SkillOpt Compaction Summary/);
  });
});
