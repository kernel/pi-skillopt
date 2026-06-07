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
- **Required environment** — tools/CLIs/credentials the skill assumes. These must be **pre-baked into each task's `environment/Dockerfile`** (see step 4).

### 2. Derive tasks
For each capability, write **1–3 concrete tasks** an agent would do with the skill. A good task:
- has a **single, checkable goal** (a value to produce, a state to reach, an action to perform);
- is **realistic** — the kind of thing the skill exists to help with;
- is **runnable in the configured rollout env** (don't invent tools the container won't have);
- **varies** along the axes the skill cares about (e.g. single-step vs multi-step, simple vs edge-case), so the pack exercises the gotchas, not just the happy path.

Aim for ~12–30 tasks total for a first pack — enough to split 60/20/20 and still have a meaningful selection set.

### 3. Define verifiers (the reward)
Each task is scored by its `tests/test.sh`, which writes one or more rewards. You want two kinds:

- **Outcome rewards** — did the agent achieve the goal? (output matches, file exists, endpoint returns expected state, exit code, etc.) Objective and scriptable.
- **Skill-adherence rewards** — did the agent follow the behaviors the skill prescribes? Derive these *directly from the skill's own gotchas/rules*, and check the **observable end-state** the behavior produces (a file written in the prescribed format, a session torn down, a config left in place). This is what makes the optimization improve *the skill's behavior*, not just task accuracy.

Rules for verifiers:
- **Objective only.** Prefer scripted checks over an LLM judge. If a judgment is unavoidable, make it a `soft` (0–1) reward and run the gate in `soft`/`mixed` mode.
- **Check what the verifier can see.** `test.sh` runs *inside the task container* after the agent finishes, so it can inspect the filesystem and any state the agent left — not the agent's reasoning. Make adherence checks land on observable artifacts.
- **No leakage.** A verifier must not hand the agent the answer.
- **Cheap + deterministic.** They run on every rollout, many times.

### 4. Emit Harbor task files
Each task is a standard Harbor task directory (Harbor 0.13.x). The extension treats each subdir name as the task id used in splits.

```
tasks/
  <task-id>/
    task.toml              # task metadata, schema_version = "1.3"
    instruction.md         # the prompt the agent sees
    environment/
      Dockerfile           # the container image — PRE-BAKE every tool/CLI/dep here
    tests/
      test.sh              # the verifier; writes the reward (see below)
      ...                  # any fixtures test.sh reads (e.g. expected.txt)
    solution/
      solve.sh             # reference solution — lets the `oracle` agent smoke-test the pipeline
  SPLITS.md                # proposed train/selection/test grouping + rationale
```

Scaffold the canonical shape with `harbor init <org>/<task-id> -t` and fill it in. Key contracts:

- **`task.toml`** — `schema_version = "1.3"`, a `[task]` with `name = "<org>/<task-id>"` (the **`org/name` format is required**), `[environment]` with `os = "linux"`, and `[agent]` / `[verifier]` timeouts. Copy the shape from `harbor init` output or the `examples/hello-harbor` tasks. Use a stable, team-neutral `<org>` (e.g. `skillopt`). **Namespace gotcha:** an older Harbor on a team-scoped backend (e2b) can reject a run with "namespace `<org>` must match your team". Don't hand-edit `task.toml` for this — staging would overwrite it next run. Instead set `taskNamespace: "<your-team>"` in `skillopt.config.json` (staging rewrites every task's org to it), or upgrade Harbor to 0.13.x where the local-path flow folds the org away and this doesn't happen.
- **`environment/Dockerfile`** — bake in everything: the base image, the skill's required CLIs/packages, plus whatever the verifier needs (e.g. `python3`). **Do not install anything at run time** inside `test.sh` — runtime `apt-get`/`uv`/`pip` is flaky and is the single most common cause of "no reward file found". For tmux-driven agent harnesses (e.g. `terminus`), also bake in `tmux` + `asciinema`.
- **`tests/test.sh`** — Harbor copies `tests/` to `/tests/` and runs this script. It **must write the reward** to one of:
  - `/logs/verifier/reward.json` — a flat object of named rewards, e.g. `{"outcome": 1.0, "adherence": 0.0}` (use this for multi-reward outcome + adherence), or
  - `/logs/verifier/reward.txt` — a single float.
  
  The extension reads these back, averages the values into `soft`, and treats "all rewards ≥ the pass threshold" as `hard`. **Always write a reward file, even on internal error** — default to a `0` reward up front (or `trap`/fallback) so a crashing verifier scores 0 instead of producing "no reward file found", which errors the whole trial.
- **`solution/solve.sh`** — the reference solution. Not required, but if you provide it the `oracle` agent will run it instead of a model, which is how you validate the pack for free (step 5).

Do **not** put the skill being optimized into the task — it's injected separately by Harbor (the rollout env's `agents[].skills`), so the same pack scores any candidate version.

A minimal multi-reward `test.sh`:

```bash
#!/bin/bash
# python3 is pre-baked in environment/Dockerfile — nothing is installed here.
python3 - <<'PY'
import json, pathlib
# ... inspect /app state + read fixtures from /tests, compute rewards ...
pathlib.Path("/logs/verifier").mkdir(parents=True, exist_ok=True)
json.dump({"outcome": outcome, "adherence": adherence},
          open("/logs/verifier/reward.json", "w"))
PY
```

### 5. Validate, then hand off for review
Validate the wiring before scaling up — a malformed task wastes a whole training run:
- `harbor check <task-dir>` to lint a task against Harbor's quality rubric.
- Run one task locally with the **`oracle`** agent (it runs `solution/solve.sh`, so no model/API key/cost) and confirm it produces a reward and scores 1.0. That proves the build → solve → verify → reward path end to end. A `JobConfig` for this is just `{agents: [{name: "oracle"}], environment: {type: "docker"}, tasks: [{path: "tasks/<id>"}]}` run via `harbor run --config`.

Then sanity-check the pack:
- Every task is runnable in the rollout env (the Dockerfile bakes in its tools/creds).
- Every verifier is objective and un-gameable by a generic strong agent **without** the skill — i.e. a baseline run (no skill, or the seed skill) should *not* trivially pass everything. If it does, the task is too easy to show skill value.
- Tasks are diverse enough to cover the skill's gotchas.

Then **show the user the task list + verifiers and pause for approval.** Once approved, point `skillopt.config.json → taskPack` at `./tasks` and continue with `skillopt-create` step 3.

## Anti-patterns
- **One mega-task.** Split into many small checkable tasks so the gate has signal and the split is meaningful.
- **Outcome-only rewards.** Without adherence rewards you optimize task accuracy, not the skill's prescribed behavior — and the skill barely changes.
- **LLM-judge everything.** Slow, noisy, and gameable. Reserve judges for genuinely unscriptable quality, as a soft reward.
- **Runtime installs in `test.sh`.** Bake deps into `environment/Dockerfile`. A flaky `apt-get`/`pip` mid-verifier writes no reward and the trial errors out.
- **Tasks the container can't run.** A task that needs a CLI or credential not baked into the Dockerfile fails for the wrong reason and poisons the signal.
