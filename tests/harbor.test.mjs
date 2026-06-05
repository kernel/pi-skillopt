import assert from "node:assert/strict";
import test from "node:test";

import { buildJobConfig, serializeJobConfig, parseTrialResults } from "../extensions/pi-skillopt/harbor.ts";

const req = (model) => ({
  taskPack: "/pack",
  skillPath: "/pack/skills/fa/SKILL.md",
  taskIds: ["t1", "t2"],
  split: "selection",
  jobsDir: "/jobs",
  jobName: "j1",
  env: {
    backend: "local",
    agent: "claude-code",
    model,
    setup: { skills: ["/pack/skills/dep/SKILL.md"], env: ["ANTHROPIC_API_KEY"], apt: ["jq"] },
  },
});

test("buildJobConfig maps backend, injects skill dir + companions, templates secrets, lists tasks", () => {
  const cfg = buildJobConfig(req("anthropic/claude-opus-4-8"), "/pack/skills/fa");
  assert.equal(cfg.environment.type, "docker"); // local -> docker
  assert.equal(cfg.agents[0].name, "claude-code");
  assert.equal(cfg.agents[0].model_name, "anthropic/claude-opus-4-8");
  assert.deepEqual(cfg.agents[0].skills, ["/pack/skills/fa", "/pack/skills/dep/SKILL.md"]);
  assert.deepEqual(cfg.agents[0].env, { ANTHROPIC_API_KEY: "${ANTHROPIC_API_KEY}" });
  assert.deepEqual(cfg.tasks, [{ path: "/pack/t1" }, { path: "/pack/t2" }]);
  // preloads (apt/npm/pip) are build-time (task Dockerfiles), never in the job config
  assert.ok(!JSON.stringify(cfg).includes("jq"));
  JSON.parse(serializeJobConfig(cfg)); // emits valid JSON
});

test("buildJobConfig omits model_name for a model-less agent (oracle)", () => {
  const cfg = buildJobConfig(req(""), "/pack/skills/fa");
  assert.ok(!("model_name" in cfg.agents[0]));
});

test("parseTrialResults reads per-trial rewards in the real Harbor shape", () => {
  const trials = [
    { task_name: "skillopt-hello/t1", trial_name: "t1__a", task_id: { path: "/pack/t1" }, verifier_result: { rewards: { outcome: 1, adherence: 1 } } },
    { task_name: "skillopt-hello/t2", trial_name: "t2__b", task_id: { path: "/pack/t2" }, verifier_result: { rewards: { outcome: 1, adherence: 0 } } },
    { task_name: "skillopt-hello/t3", trial_name: "t3__c", task_id: { path: "/pack/t3" }, exception_info: { exception_type: "AgentTimeoutError" } },
  ];
  const pt = parseTrialResults(trials, { jobDir: "/jobs/j1", passThreshold: 1 });
  assert.equal(pt[0].taskId, "t1"); // split id derived from task_id.path basename, not task_name
  assert.deepEqual([pt[0].hard, pt[0].soft], [1, 1]);
  assert.deepEqual([pt[1].hard, pt[1].soft], [0, 0.5]); // adherence fails -> not hard
  assert.deepEqual([pt[2].hard, pt[2].soft], [0, 0]); // errored trial
  assert.equal(pt[0].trajectory, "/jobs/j1/t1__a");
});

test("primaryReward lets a task pass on its primary axis", () => {
  const trials = [
    { task_name: "x", trial_name: "x__a", task_id: { path: "/p/x" }, verifier_result: { rewards: { outcome: 1, adherence: 0 } } },
  ];
  const pt = parseTrialResults(trials, { jobDir: "/j", passThreshold: 1, primaryReward: "outcome" });
  assert.equal(pt[0].hard, 1);
});
