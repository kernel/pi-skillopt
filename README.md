<div align="center">

# pi-skillopt
### Autonomous [SkillOpt](https://github.com/microsoft/SkillOpt) loop for pi
**[Why](#why)** · **[Install](#install)** · **[Usage](#usage)** · **[How it works](#how-it-works)**

</div>

*Bring a skill. pi-skillopt generates the task pack, rolls the skill out on real tasks via [Harbor](https://github.com/harbor-framework/harbor), reflects on failures, applies bounded edits, and keeps an edit only if it strictly improves a held-out score.*

An extension for **[pi](https://pi.dev/)**. Inspired in structure by [pi-autoresearch](https://github.com/davebcn87/pi-autoresearch): a domain-agnostic **extension** provides the machinery, **skills** encode the workflow. The optimization target is a single skill document, the benchmark is a Harbor rollout, and "keep/revert" is SkillOpt's validation gate.

---

## Why

[SkillOpt](https://arxiv.org/abs/2605.23904) showed you can "train" a frozen agent's `SKILL.md` like weights — propose edits from scored rollouts, accept only edits that beat a held-out selection score. But its repo is a research harness: to use it on *your* skill you must implement a dataset + rollout + scorer. Harbor already *is* that layer — it runs agents (Claude Code, Codex, …) in containers and returns verifier rewards. `pi-skillopt` is the glue — an extension you install, not a framework you fork.

## Install

```bash
pi install git:git@github.com:kernel/pi-skillopt@main
```

Rollouts run through the [Harbor](https://github.com/harbor-framework/harbor) CLI: `uv tool install harbor` (add a backend extra for a remote sandbox, e.g. `uv tool install 'harbor[e2b]'` + `export E2B_API_KEY=…`).

## Usage

```
/skill:skillopt-create
```

The agent walks you through:

1. **The skill** — which `SKILL.md` to optimize.
2. **The rollout env** — *how rollouts run*:
   - **backend**: `docker` · `daytona` · `e2b` · `runloop` · `modal` · …
   - **agent**: `claude-code` · `codex` · `pi` · `opencode` · …
   - **model**: e.g. `anthropic/claude-opus-4-8`
   - **preloads**: other skills, npm/apt/pip packages, CLIs, env/secrets (names only), setup commands
3. **Task pack** — if you don't have one, `/skill:skillopt-taskpack` generates it *from the skill itself* (derives tasks + objective verifiers), then pauses for your review.
4. **Baseline + loop** — `run_rollout` → reflect on failures → edit → `log_step` (gate) → repeat.
5. **Finish** — `/skill:skillopt-finalize` → `best_skill.md` + the held-out **test** number + a clean diff.

## How it works

```
┌────────────────────────────┐      ┌───────────────────────────────┐
│  Extension (generic infra) │      │  Skills (the workflow)        │
│                            │      │                               │
│  init_optimization         │◄─────│  skillopt-create   (set up)   │
│  run_rollout  ── harbor ──►│      │  skillopt-taskpack (make eval)│
│  log_step  ── gate ──►keep │      │  skillopt-finalize (ship)     │
│  widget · /skillopt · jsonl│      │                               │
└────────────────────────────┘      └───────────────────────────────┘
```

- **`run_rollout(split)`** runs the configured agent in the rollout env with the *current* skill mounted, over a split's tasks, and returns `hard`/`soft` scores + failing trajectories (the "gradient").
- **`log_step`** submits your edited skill to the **gate** (`gate.ts`, ported from SkillOpt): accept only if the **selection** split strictly improves → snapshot + update `best_skill.md`; otherwise revert. A tie is rejected. The agent never decides keep/revert — it's arithmetic.
- **Splits** (`splits.ts`) are enforced: you reflect on `train`, the gate scores `selection`, and `test` is touched once by finalize. This is what stops the skill overfitting the eval.

### The one integration seam
`extensions/pi-skillopt/harbor.ts` is the only file that knows Harbor. From the rollout env it builds a Harbor `JobConfig` (the candidate skill injected via `agents[].skills`, the split's tasks listed in `tasks[]`), runs `harbor run --config`, then reads each trial's verifier rewards from the job's `result.json` and aggregates them into `hard`/`soft` scores. Swapping eval substrates later = rewriting one file.

## Session files

A run is **self-contained in the working directory** (where pi was launched). `init_optimization` copies an external seed skill / task pack *into* the working dir and points the config at the local copies, so the loop edits copies and never mutates your source — the result is `best_skill.md` + a diff you apply back yourself.

| file | role |
|---|---|
| `skillopt.config.json` | the run: skill, task pack, **rollout env**, splits, edit budget, gate metric |
| `skillopt.jsonl` | append-only log of every step (edit, selection scores, gate action, confidence) — the resume source of truth |
| `skillopt.md` | living session doc (objective, rollout env, what's been tried) |
| `best_skill.md` | the deployable artifact (updated on every new best) |
| `skillopt.snapshots/` | `skill_vNNNN.md` per accepted step |

## What's deliberately generic
No assumptions about what the skill does. Skill, task pack, agent, model, backend, and verifiers are all user-supplied. `examples/hello-harbor/` runs the whole shape on a toy skill with zero domain code. `examples/reversible-migrations/` and `examples/jq-surgeon/` are harder skills that ship *without* a task pack, so they exercise `skillopt-taskpack` — deriving the tasks and verifiers from the skill itself.

## Roadmap
- slow-update / meta-skill (epoch-boundary guidance into a protected region)
- autonomous edit-budget control; parallel rollouts; a live `/skillopt export` dashboard
- a separate optimizer model option (default keeps pi itself as the optimizer)

## License
MIT
