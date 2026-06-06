---
name: skillopt-create
description: Set up and run a SkillOpt-style optimization loop for a single agent SKILL.md, scored by Harbor rollouts. Gathers the skill, the rollout environment (backend, agent, model, preloads), generates a task pack if none exists, then starts the loop. Use when asked to "optimize this skill", "skillopt this SKILL.md", "train my skill", or "improve my agent skill against evals".
---

# skillopt — create

Optimize one `SKILL.md` the way SkillOpt optimizes a skill: roll the skill out on real tasks via Harbor, reflect on failures, apply bounded edits, and keep an edit only if it strictly improves a held-out selection score.

You usually arrive with **just a skill**. Your job in this step: pin down *how to score it*, generate a task pack, write the session files, run a baseline, and start looping.

## Tools (available once the session is active)

- **`init_optimization`** — derive splits, write the jsonl header, snapshot the starting skill.
- **`run_rollout`** — run the configured agent over a split (train / selection / test) with the current skill mounted; returns hard/soft scores + failing trajectories.
- **`log_step`** — submit your edited skill to the validation gate. Accept → snapshot + `best_skill.md`. Reject → revert. A tie is rejected.

## Step 1 — gather inputs (one question at a time, confirm once at the end)

**Do NOT dump the whole config and ask the user to fill in the blanks.** Ask **one thing at a time**, carry a sensible default into every question so most answers are a quick "yes", and infer from context before asking. Only after you have everything do you show the **assembled config once** for a single confirmation — that's the one time the user sees the full picture.

Ask in this order, waiting for each answer before the next:

1. **Which skill?** The path to the `SKILL.md` to optimize (the only file the loop edits). Look in the cwd first; if there's one obvious candidate, propose it — otherwise ask. Don't grab an unrelated SKILL.md just because it's nearby.
2. **What does good look like?** What an agent should reliably accomplish with it, and any behaviors/gotchas the skill is meant to enforce.
3. **Where do rollouts run?** The backend — default `docker`; alternatives `e2b`, `daytona`, `runloop`, `modal`. (One question, with the default offered.)
4. **Which agent + model?** Default `claude-code` on a current model (e.g. `anthropic/claude-opus-4-8`). Other agents: `codex`, `pi`, `opencode`.
5. **Credentials** — once you know the backend + agent, name the keys that must be set and confirm they're present. **Never ask for or print a key value — only confirm it's exported.**
   - **Backend key** (read by the Harbor CLI on the host, *not* injected into the sandbox, so it does NOT go in the config): `e2b` → `E2B_API_KEY`, `daytona` → `DAYTONA_API_KEY`, `runloop` → `RUNLOOP_API_KEY`, `modal` → `MODAL_TOKEN`. `docker`/local → none. Ask e.g. "is `E2B_API_KEY` exported in the shell you're running pi from?"
   - **Model-provider key** (passed *into* the sandbox for the rollout agent → add its name to `rollout.setup.env`): Anthropic / `claude-code` → `ANTHROPIC_API_KEY`; OpenAI / `codex` → `OPENAI_API_KEY`; etc. Confirm it's set in the host env too.
   
   Don't move on to rollouts until the required keys are confirmed.
6. **Anything else to preload?** One open question — *not* a checklist, and separate from the credentials above. Most skills need nothing beyond the base image. Only if they say yes, drill into: companion skills, apt/npm/pip packages, CLIs, other env var names, setup commands, and a non-default base image.
7. **Tuning** — offer the defaults, but explain each knob in a sentence so the choice is informed; don't just list values. Accept "defaults are fine":
   - **splits** (default `60:20:20`) — how the task pack is divided: **train** (the agent reflects on these failures to propose edits), **selection** (held-out set the gate scores every candidate against — never reflected on), **test** (scored once at the very end for the honest number). More tasks → a more reliable selection signal.
   - **gate metric** (default `hard`) — what "better" means at the gate: `hard` = pass rate (each task fully passes or it doesn't), `soft` = mean partial-credit reward in [0,1] (use when verifiers give graded scores, or the selection set is tiny), `mixed` = a blend of the two.
   - **edit budget** (default `4`) — the max number of bounded edits the agent may apply to the skill per step (its "learning rate"); it cosine-decays toward a floor as the run progresses.
   - **max steps** (default `40`) — how many iterations before the loop auto-stops.

Keep each turn to one short question. If the user says "just use defaults", assume the tuning defaults and skip ahead — but still confirm the credentials, since rollouts fail without them. Don't ask about preloads or tuning before you have the skill + the rollout basics.

### Then confirm once, and write

Assemble everything and show it **one time** for a single yes/no — this is the only full-form moment:

```json
{
  "name": "optimize my-skill",
  "skillUnderTest": "./skills/my-skill/SKILL.md",
  "taskPack": "./tasks",
  "rollout": {
    "backend": "docker",
    "agent": "claude-code",
    "model": "anthropic/claude-opus-4-8",
    "image": "ubuntu:24.04",
    "setup": { "env": ["ANTHROPIC_API_KEY"] }
  },
  "splits": { "train": [], "selection": [], "test": [] },
  "editBudget": 4,
  "gateMetric": "hard",
  "maxSteps": 40
}
```

On confirmation, write it to `skillopt.config.json`. (Full schema in the repo README; `rollout.setup` also takes `skills` / `apt` / `npm` / `pip` / `commands` when preloads are needed.)

> **Where preloads land:** Harbor has no run-time preload hook, so `skillopt-taskpack` bakes the base image + `apt`/`npm`/`pip`/`commands` into each task's `environment/Dockerfile` (run at *build* time). Only the **backend**, **agent**, **model**, **companion skills**, and **secret names** are applied per-rollout.

## Step 2 — get a task pack

If the user already has a Harbor task pack, point `taskPack` at it.

**If they don't (the common case), invoke `/skill:skillopt-taskpack`** to generate one from the skill. Do not skip this and do not invent tasks inline — a good, reviewed task pack is the difference between training and noise. Pause for the user to eyeball the generated tasks before training.

## Step 3 — initialize and baseline

1. `git checkout -b skillopt/<skill-name>-<date>` (so accepted snapshots are diffable).
2. Write `skillopt.md` (template below) — the living session doc.
3. `init_optimization` → `run_rollout('selection')` → `log_step` as the baseline (edit: "baseline").
4. Also `run_rollout('train')` once to see where the skill actually fails.

### `skillopt.md`

```markdown
# skillopt: <skill name>

## Objective
<What the skill is for; what an agent should reliably accomplish with it.>

## Rollout env
backend / agent / model / key preloads — and what each task costs to run.

## Splits
train N · selection N · test N  (test is OFF LIMITS until finalize)

## Edit rules
- Bounded edits only (append / insert_after / replace / delete a span).
- Generalize: never hardcode answers/ids/paths for specific tasks into the skill.
- Respect the <!-- SLOW_UPDATE_START/END --> region if present.

## What's been tried
<Accepted edits, dead ends, and which failure classes remain. Keep current.>
```

## Step 4 — loop

**Each iteration:**
1. Read the latest failing trajectories (from the last `run_rollout('train')` or `'selection'`).
2. Identify the **most common** failure pattern across them.
3. Apply **≤ edit_budget** bounded edits to the skill that fix that pattern — generalizable, not task-specific.
4. `run_rollout('selection')` → `log_step(edit, sel_hard, sel_soft?)`.
5. The gate keeps or reverts. Update `skillopt.md`'s "What's been tried".

**Loop rules**
- **The selection gate is law.** Don't argue with a reject — try a structurally different edit.
- **Never roll out `test`.** It exists only for the final honest number (`skillopt-finalize`).
- **Don't overfit.** If an edit names a specific task's answer, it's cheating — the held-out selection split will usually punish it, but don't write it in the first place.
- **Watch confidence.** Agent rollouts are noisy; after a few steps `log_step` reports best-vs-noise. If it's low, raise `selectionSamples` or distrust marginal gains.
- **Keep going** until `maxSteps`, the score plateaus across several edits, or the user stops you.

## Step 5 — finish

When the loop plateaus, run `/skill:skillopt-finalize` to produce `best_skill.md`, the held-out **test** number, and a clean diff against the original skill.
