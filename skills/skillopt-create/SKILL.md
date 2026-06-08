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

## Orient the user first

Before asking anything, give a 1–2 sentence plain-language orientation — don't assume the user knows the moving parts (especially **Harbor**):

> "This optimizes your `SKILL.md` by repeatedly running an agent on a set of tasks *with your skill loaded*, scoring each run, and keeping only the edits that improve the score on a held-out set. **Harbor** is the eval substrate that does the running and scoring — it launches a sandbox (the *backend* you'll pick), runs the chosen *agent* on each task, and grades the result with the task's verifiers. Your skill is what gets optimized; the task pack + Harbor are how each version gets measured."

Adapt the wording, but make sure the user understands Harbor's role before they answer questions about backends, agents, or task packs.

## A run is self-contained in the working directory

The working directory is wherever pi was launched (`ctx.cwd`). **All run state lives there** — session files (`skillopt.md`, `skillopt.jsonl`, `skillopt.jobs/`, snapshots), and `best_skill.md`. The seed skill and task pack are **inputs**: `init_optimization` copies any that live outside the working dir *into* it (`./skills/<name>/`, `./tasks/`) and rewrites the config to the local copies, so the loop edits those copies and **never mutates the user's source files**. The deliverable is `best_skill.md` + a diff (`skillopt-finalize`) the user applies back to the source themselves.

Therefore: write `skillopt.config.json` in the working dir, and **do not set `workingDir` to the skill's source location** — that would make the run operate on the originals. If the user points at a skill or pack elsewhere, that's fine; staging handles it.

## Step 1 — gather inputs (one question at a time, confirm once at the end)

**Do NOT dump the whole config and ask the user to fill in the blanks.** Ask **one thing at a time**, carry a sensible default into every question so most answers are a quick "yes", and infer from context before asking. Only after you have everything do you show the **assembled config once** for a single confirmation — that's the one time the user sees the full picture.

**Exactly one question per turn** — emit a single `?` and wait for the answer before the next. Don't bundle two into one message (e.g. *what does good look like* together with *which backend/agent/model*), even when you think you can shortcut.

**If `skillopt.config.json` already exists** in the working dir (an example ships one, or you're re-running), do **not** silently adopt it. Summarize what it specifies — backend, agent, model, gate metric — and confirm it's what the user wants before continuing. Pay special attention to the **backend**: it sets which credentials and which tier you'll need, so if it changes (e.g. `docker` → `e2b`) the required keys change too. A pre-existing config is a starting point to confirm, not a settled answer — still walk the questions for anything they want to change, and still show the final assembled config once before writing.

Ask in this order, waiting for each answer before the next:

1. **Which skill?** The path to the `SKILL.md` to optimize (the only file the loop edits). Look in the cwd first; if there's one obvious candidate, propose it — otherwise ask. Don't grab an unrelated SKILL.md just because it's nearby.
2. **What does good look like?** What an agent should reliably accomplish with it, and any behaviors/gotchas the skill is meant to enforce.
3. **Where do rollouts run?** The backend — default `docker`; alternatives `e2b`, `daytona`, `runloop`, `modal`. (One question, with the default offered.)
4. **Which agent + model?** The agent is the CLI harness that runs each task in the sandbox with your skill loaded — **list the options for the user, don't just give the default**:
   - common coding agents: **`claude-code`** (default, Anthropic) · `codex` (OpenAI) · `gemini-cli` (Google) · `opencode` · `cursor-cli` · `aider` · `goose` · `openhands` · `copilot-cli` · `qwen-coder` · `pi`
   - **`oracle`** — runs each task's reference `solution/` instead of a model (free, no API key); use it to smoke-test the pipeline end-to-end before spending on a real agent.
   - Harbor supports more (`terminus-2`, `devin`, `kimi-cli`, `cline-cli`, …) — offer the common ones and accept any valid Harbor agent name the user prefers.
   
   Then pick the **model** as `<provider>/<exact-model-id>`. Harbor passes the id straight to the provider (it only strips the `<provider>/` prefix), so it must be a **real, current** provider model id — **never an approximation or stale alias** (`haiku`, `claude-3-5-haiku-latest`, "gpt5" all fail and every rollout errors out). If the user names a model loosely (e.g. "haiku"), resolve it to the exact id and show it in the confirm step. Current Anthropic ids: `anthropic/claude-opus-4-8`, `anthropic/claude-sonnet-4-6`, `anthropic/claude-haiku-4-5`; e.g. `openai/gpt-5.5`. If unsure of the exact id, ask the user rather than guess. (`oracle` needs no model.)
5. **Credentials** — once you know the backend + agent, work out which keys are required and **check them yourself** with a shell command — don't ask the user to confirm something you can verify. Check presence only, never print a value, e.g. `for k in E2B_API_KEY ANTHROPIC_API_KEY; do [ -n "${!k}" ] && echo "$k set" || echo "$k MISSING"; done`.
   - **Backend key** (read by the Harbor CLI on the host, *not* injected into the sandbox, so it does NOT go in the config): `e2b` → `E2B_API_KEY`, `daytona` → `DAYTONA_API_KEY`, `runloop` → `RUNLOOP_API_KEY`, `modal` → `MODAL_TOKEN`. `docker`/local → none.
   - **Model-provider key** (passed *into* the sandbox for the rollout agent → add its name to `rollout.setup.env`): Anthropic / `claude-code` → `ANTHROPIC_API_KEY`; OpenAI / `codex` → `OPENAI_API_KEY`; etc.
   
   Only **ask the user** for a key that your check shows is **missing** (ask them to `export` it in the shell running pi). Don't move on to rollouts until the required keys are present.

   **Team-scoped backends (e2b):** if a rollout later fails with "namespace `<org>` must match your team", set `taskNamespace: "<your-team>"` in `skillopt.config.json` once — staging rewrites every task's org to it on each run, so you never hand-edit `task.toml` (those edits get overwritten by the next stage anyway). Harbor 0.13.x handles this automatically for local-path tasks; this only bites older Harbor.
6. **Anything else to preload?** One open question — *not* a checklist, and separate from the credentials above. **The rollout agent itself (claude-code/codex/…) is installed by Harbor automatically — you don't preload it.** Preloads are for what your *tasks* need the agent to use (a CLI/SDK/companion skill the task exercises). Most skills need nothing beyond the base image; only if they say yes, drill into: companion skills, apt/npm/pip packages, CLIs, other env var names, setup commands, and a non-default base image.
7. **Tuning** — present these as a **bulleted list, one bullet per setting** — explanation first, default last. **Do NOT compress them into a single sentence with parenthetical labels** (that's what's confused users). The goal here is to *teach how skillopt works*, briefly. Lead in with one line — "a few knobs, all have sensible defaults" — then the bullets, then accept "defaults are fine". Use roughly this (adapt the wording, keep the substance):

   - **Splits — how your tasks get divided into three groups** (default 60/20/20: train/selection/test):
     - *train* — the tasks the agent studies each round to see what's failing and decide what to change in the skill.
     - *selection* — a separate, held-out group used only to **judge whether an edit helped**: a change is kept only if it scores higher on these. Keeping them apart from train is what stops the skill from being over-fit to specific tasks.
     - *test* — never touched during the loop; scored once at the very end, so the final "did it actually improve" number can't be gamed.
   - **Gate metric — how an edit is scored "better"** (default `hard`). ("The gate" is the automatic keep-or-revert decision made after every edit, using this metric.)
     - *hard* — pass rate: each task fully passes or fails, and an edit must raise the fraction that pass.
     - *soft* — average partial-credit score (0–1 per task); use when your verifiers give graded scores, or the selection group is small.
     - *mixed* — a blend of hard and soft.
   - **Edit budget — how many changes the agent may make to the skill per round** (default 4). Like a learning rate: keeps each round to a few focused edits, and it shrinks as the run goes on so later rounds make smaller, safer changes.
   - **Max steps — how many rounds before the loop stops on its own** (default 40). One round = reflect on failures → edit the skill → re-score → keep or revert.

Keep each turn to one short question. If the user says "just use defaults", assume the tuning defaults and skip ahead — but still confirm the credentials, since rollouts fail without them. Don't ask about preloads or tuning before you have the skill + the rollout basics.

### Then confirm once, and write

Assemble everything and show it **one time** for a single yes/no — this is the only full-form moment. Alongside the JSON, add one plain sentence of what it will do, e.g. "*claude-code* will attempt these *N* tasks in an *e2b* sandbox with your skill loaded, and the gate keeps edits that beat the held-out selection split":

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

The task pack defines what "better" *means*, so it is never a detail to assume. **Never silently adopt a pack just because you found one** next to the skill (e.g. a `./tasks` dir alongside it, or one named in an existing config) — that pack may test something unrelated to what the user wants.

- **If you find a candidate pack, confirm it before using it.** Show what it is and ask: "I found a task pack at `<path>` (N tasks: a, b, c…). Use this to score the skill, or build a fresh one?" Use it only on an explicit yes — and then **as-is** (`init_optimization` copies it into the working dir; don't rename or rewrite its `task.toml`).
- **If there's no pack, or the user declines it, construct one.** Invoke `/skill:skillopt-taskpack` to generate a pack from the skill into `./tasks`. Don't invent tasks inline — a good, reviewed pack is the difference between training and noise. **Solicit the guidance you need** (which capabilities and gotchas matter most, what counts as success, any edge cases) so the generated tasks are high quality, and pause for the user to review them before training.

## Step 3 — initialize and baseline

1. **Preflight the rollout tooling** (do this *before* any rollout so the first one doesn't fail): ensure the Harbor CLI **and the backend extra** are installed with `uv tool install 'harbor[<backend>]'` — idempotent, safe to run every session — e.g. `uv tool install 'harbor[e2b]'`. A missing backend extra is the classic "the first `run_rollout` errored" cause; this prevents it instead of probing after the fact.
   - **e2b tier gotcha:** Harbor's e2b adapter requests a 24-hour sandbox lifetime, which the e2b **hobby tier rejects** with `400: Timeout cannot be greater than 1 hours` — every rollout then errors. Use a Pro-tier `E2B_API_KEY`, or cap `timeout` in the installed `harbor/environments/e2b.py`. (The `Unsupported instruction: COMMENT` warnings e2b prints on Dockerfile `#` lines are harmless.)
2. Make accepted snapshots diffable with a branch — but the working dir is often a fresh, non-git folder, so guard for that: if `git rev-parse --git-dir` fails, `git init` first, then `git checkout -b skillopt/<skill-name>-<date>`. This is only a convenience for diffing; if git is unavailable or init fails, say so and continue — the loop doesn't depend on it.
3. Write `skillopt.md` (template below) — the living session doc.
4. `init_optimization` → `run_rollout('selection')` → `log_step` as the baseline (edit: "baseline").
5. Also `run_rollout('train')` once to see where the skill actually fails.

**Call `init_optimization` exactly once.** If a session already exists it *resumes* (it won't reset your baseline) — never re-init mid-run to "reset". To genuinely start over, run `/skillopt clear` first. And never `run_rollout('test')` during the loop — it's blocked unless `skillopt-finalize` passes `final: true`.

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
- Keep it tight: prefer replace/delete over append, merge redundant rules, cut guidance that didn't help. A shorter, sharper skill beats a longer one — the skill must not grow unboundedly across steps.
- Generalize: never hardcode answers/ids/paths for specific tasks into the skill.

## What's been tried
<Accepted edits, dead ends, and which failure classes remain. Keep current.>
```

## Step 4 — loop

**Each iteration:**
1. Read the latest failing trajectories (from the last `run_rollout('train')` or `'selection'`).
2. Identify the **most common** failure pattern across them.
3. Apply **≤ edit_budget** bounded edits to the skill that fix that pattern — generalizable, not task-specific.
4. `run_rollout('selection')` → `log_step(edit, sel_hard, sel_soft?)` — pass the **0–1 fractions** `run_rollout` returns (e.g. `1.0`, not `100`); percentages are rejected.
5. The gate keeps or reverts. Update `skillopt.md`'s "What's been tried".

**Loop rules**
- **The selection gate is law.** Don't argue with a reject — try a structurally different edit.
- **Keep the skill tight.** Prefer replace/delete over append, merge redundant rules, prune what didn't help. Don't let it balloon.
- **Stop at a plateau.** When the best hasn't improved for several steps, `log_step` returns a PLATEAU notice — stop and run `skillopt-finalize`. Don't keep editing an already-saturated skill; if you want more, widen/harden the task pack instead.
- **No headroom = don't loop.** If the baseline already scores ~max (nothing failing to learn from), there's nothing to optimize — say so and widen/harden the pack rather than grinding steps.
- **Never roll out `test`.** It exists only for the final honest number (`skillopt-finalize`); it's blocked unless finalize passes `final: true`.
- **Don't overfit.** If an edit names a specific task's answer, it's cheating — the held-out selection split will usually punish it, but don't write it in the first place.
- **Watch confidence.** Agent rollouts are noisy; after a few steps `log_step` reports best-vs-noise. If it's low, raise `selectionSamples` (re-rolls each selection task N times and averages; default 3) or distrust marginal gains.

## Step 5 — finish

When the loop plateaus, run `/skill:skillopt-finalize` to produce `best_skill.md`, the held-out **test** number, and a clean diff against the original skill.
