---
name: skillopt-taskpack
description: Generate a Harbor task pack (tasks + verifiers + split manifest) from just a SKILL.md, so the skill can be scored by rollouts. Derives representative tasks from what the skill teaches, defines objective verifiers (outcome + skill-adherence), and emits reviewable Harbor task files. Use when optimizing a skill that has no eval yet, or when asked to "build tasks for this skill" / "make a task pack".
---

# skillopt — taskpack

A skill can only be optimized against a measurable task distribution. This skill turns **one `SKILL.md`** into a **Harbor task pack**: a set of tasks an agent performs *using the skill*, each with **objective verifiers** that score the run. No human-labeled dataset required — the skill itself tells you what to test.

> The task pack is the most important artifact in the whole loop. A noisy or gameable verifier produces a skill optimized to cheat. Spend real effort here, and **always have a human review the generated pack before training.**

## Method

### 1. Read the skill and extract what it claims
Read the `SKILL.md` end to end. Pull out, as a list:
- **Capabilities** — the concrete things an agent should be able to *do* with it.
- **Prescribed behaviors / rules** — the "do X", "always Y", "use Z" instructions.
- **Gotchas / failure modes** — the "common mistakes" or "don't do X" sections. These are gold: each gotcha is a behavior you can check for.
- **Required environment** — tools/CLIs/credentials the skill assumes (these must exist in the rollout env's preloads).

### 2. Derive tasks
For each capability, write **1–3 concrete tasks** an agent would do with the skill. A good task:
- has a **single, checkable goal** (a value to produce, a state to reach, an action to perform);
- is **realistic** — the kind of thing the skill exists to help with;
- is **runnable in the configured rollout env** (don't invent tools the container won't have);
- **varies** along the axes the skill cares about (e.g. single-step vs multi-step, simple vs edge-case), so the pack exercises the gotchas, not just the happy path.

Aim for ~12–30 tasks total for a first pack — enough to split 60/20/20 and still have a meaningful selection set.

### 3. Define verifiers (the reward)
Each task gets one or more verifiers. Two kinds, and you want both:

- **Outcome verifiers** — did the agent achieve the goal? (output matches, file exists, endpoint returns expected state, exit code, etc.) Objective and scriptable.
- **Skill-adherence verifiers** — did the agent follow the behaviors the skill prescribes? Derive these *directly from the skill's own gotchas/rules*. (e.g. if the skill says "always tear down the session" or "set X before Y", check the transcript/state for exactly that.) These are what make the optimization improve *the skill's behavior*, not just task accuracy.

Rules for verifiers:
- **Objective only.** Prefer scripted checks over an LLM judge. If a judgment is unavoidable, make it a `soft` (0–1) reward and run the gate in `soft`/`mixed` mode.
- **No leakage.** A verifier must not hand the agent the answer.
- **Cheap + deterministic.** They run on every rollout, many times.

### 4. Emit Harbor task files
Lay the pack out one directory per task (the extension treats each subdir name as a task id):

```
tasks/
  <task-id>/
    task.yaml         # instruction, env/container, timeout (Harbor task schema)
    verify/           # verifier scripts (outcome + adherence), each emitting a 0..1 reward
  <task-id>/...
  SPLITS.md           # proposed train/selection/test grouping + rationale
```

Follow Harbor's task + `multi-reward` schema (see the Harbor cookbook `multi-reward` and `skills` recipes). Each verifier emits its own score; the extension averages them into `soft` and treats "all required verifiers passed" as `hard`. Confirm the exact Harbor task fields against the installed Harbor version — generate, then `harbor run` a single task locally to validate before scaling up.

### 5. Sanity-check and hand off for review
Before declaring the pack done:
- Every task is runnable in the rollout env (preloads cover its tools/creds).
- Every verifier is objective and un-gameable by a generic strong agent **without** the skill — i.e. a baseline run (no skill, or the seed skill) should *not* trivially pass everything. If it does, the task is too easy to show skill value.
- Tasks are diverse enough to cover the skill's gotchas.

Then **show the user the task list + verifiers and pause for approval.** Once approved, point `skillopt.config.json → taskPack` at `./tasks` and continue with `skillopt-create` step 3.

## Anti-patterns
- **One mega-task.** Split into many small checkable tasks so the gate has signal and the split is meaningful.
- **Outcome-only rewards.** Without adherence verifiers you optimize task accuracy, not the skill's prescribed behavior — and the skill barely changes.
- **LLM-judge everything.** Slow, noisy, and gameable. Reserve judges for genuinely unscriptable quality, as a soft reward.
- **Tasks the container can't run.** A task that needs a CLI or credential not in `rollout.setup` fails for the wrong reason and poisons the signal.
