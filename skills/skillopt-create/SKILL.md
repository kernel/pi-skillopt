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

## Step 1 — gather inputs

Ask (or infer from context). The first two are about *what* to optimize; the rest define *how rollouts run* — this is the part people forget, so be explicit.

**The skill**
1. **Skill file** — path to the `SKILL.md` to optimize (the only file the loop edits).
2. **What good looks like** — what should an agent reliably accomplish with this skill? Any behaviors/gotchas the skill is trying to enforce?

**The rollout environment** (this becomes `skillopt.config.json → rollout`)
3. **Container backend** — where each task runs: `docker` (local), `daytona`, `e2b`, `runloop`, `modal`, … Pick what Harbor is configured for.
4. **Agent** — the harness that executes tasks: `claude-code`, `codex`, `pi`, `opencode`, …
5. **Model** — e.g. `anthropic/claude-opus-4-7`, `openai/gpt-5.5`.
6. **Base image** — container image or Dockerfile the rollout starts from.
7. **Preloads** — everything the agent needs *before* it works a task:
   - **other skills** it depends on (paths / repo refs / registry ids),
   - **npm / apt / pip** packages and **CLIs** to install,
   - **env vars / secrets** to pass through (names only — values come from the backend's secret store, never a session file),
   - arbitrary **setup commands**.
8. **Splits** — train/selection/test ratio (default `60:20:20`).
9. **Gate metric** — `hard` (exact pass, default), `soft` (partial credit; use for tiny selection sets), or `mixed`.
10. **Budget** — `edit_budget` (max edits/step, default 4, cosine-decays), `maxSteps`.

Write these to `skillopt.config.json` (schema in the repo README). Example:

```json
{
  "name": "optimize my-skill",
  "skillUnderTest": "./skills/my-skill/SKILL.md",
  "taskPack": "./tasks",
  "rollout": {
    "backend": "e2b",
    "agent": "claude-code",
    "model": "anthropic/claude-opus-4-7",
    "image": "ubuntu:24.04",
    "setup": {
      "skills": ["./skills/dep-skill/SKILL.md"],
      "npm": ["some-cli"],
      "apt": ["jq"],
      "env": ["SOME_API_KEY"],
      "commands": ["curl -fsSL https://example.com/install.sh | sh"]
    }
  },
  "splits": { "train": [], "selection": [], "test": [] },
  "editBudget": 4,
  "gateMetric": "hard",
  "maxSteps": 40
}
```

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
