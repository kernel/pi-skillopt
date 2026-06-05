# pi-skillopt

### Optimize any agent `SKILL.md` against a Harbor eval substrate — the [SkillOpt](https://github.com/microsoft/SkillOpt) way

*Bring a skill. The plugin generates the task pack, rolls the skill out on real tasks via [Harbor](https://github.com/harbor-framework/harbor), reflects on failures, applies bounded edits, and keeps an edit only if it strictly improves a held-out score.*

A plugin for **[pi](https://pi.dev/)**. Inspired in structure by [pi-autoresearch](https://github.com/davebcn87/pi-autoresearch): a domain-agnostic **extension** provides the machinery, **skills** encode the workflow. Here the optimization target is a single skill document, the benchmark is a Harbor rollout, and "keep/revert" is SkillOpt's validation gate.

> **Status: v0 scaffold.** The loop/gate/splits/Harbor-seam/jsonl logic is real and unit-testable; the **skills are usable today** (they're just instructions an agent follows). The extension's pi event wiring and the exact `harbor run` flags are shaped from upstream and need a reconciliation pass against a live pi + Harbor — search the code for `RECONCILE:` and `ADAPTER:`. Not yet runtime-validated end to end.

---

## Why

[SkillOpt](https://arxiv.org/abs/2605.23904) showed you can "train" a frozen agent's `SKILL.md` like weights — propose edits from scored rollouts, accept only edits that beat a held-out selection score. But its repo is a research harness: to use it on *your* skill you must implement a dataset + rollout + scorer. Harbor already *is* that layer — it runs agents (Claude Code, Codex, …) in containers and returns verifier rewards. `pi-skillopt` is the glue, wrapped as a plugin you install instead of a framework you fork.

## Install

```bash
pi install npm:pi-skillopt        # once published
```

Requires the Harbor CLI for rollouts: `uv tool install harbor`.

## Use it

You arrive with just a skill.

```
/skill:skillopt-create
```

The agent walks you through:

1. **The skill** — which `SKILL.md` to optimize.
2. **The rollout env** — *how rollouts run* (the part people forget):
   - **backend**: `docker` · `daytona` · `e2b` · `runloop` · `modal` · …
   - **agent**: `claude-code` · `codex` · `pi` · `opencode` · …
   - **model**: e.g. `anthropic/claude-opus-4-7`
   - **preloads**: other skills, npm/apt/pip packages, CLIs, env/secrets (names only), setup commands
3. **Task pack** — if you don't have one, `/skill:skillopt-taskpack` generates it *from the skill itself* (derives tasks + objective verifiers), then pauses for your review.
4. **Baseline + loop** — `run_rollout` → reflect on failures → edit → `log_step` (gate) → repeat.
5. **Finish** — `/skill:skillopt-finalize` → `best_skill.md` + the held-out **test** number + a clean diff.

## How it works

```
┌────────────────────────────┐      ┌──────────────────────────────┐
│  Extension (generic infra) │      │  Skills (the workflow)        │
│                            │      │                              │
│  init_optimization         │◄─────│  skillopt-create   (set up)  │
│  run_rollout  ── harbor ──►│      │  skillopt-taskpack (make eval)│
│  log_step  ── gate ──►keep │      │  skillopt-finalize (ship)    │
│  widget · /skillopt · jsonl│      │                              │
└────────────────────────────┘      └──────────────────────────────┘
```

- **`run_rollout(split)`** runs the configured agent in the rollout env with the *current* skill mounted, over a split's tasks, and returns `hard`/`soft` scores + failing trajectories (the "gradient").
- **`log_step`** submits your edited skill to the **gate** (`gate.ts`, ported from SkillOpt): accept only if the **selection** split strictly improves → snapshot + update `best_skill.md`; otherwise revert. A tie is rejected. The agent never decides keep/revert — it's arithmetic.
- **Splits** (`splits.ts`) are enforced: you reflect on `train`, the gate scores `selection`, and `test` is touched once by finalize. This is what stops the skill overfitting the eval.

### The one integration seam
`extensions/pi-skillopt/harbor.ts` is the only file that knows Harbor. It builds `harbor run` from the rollout env, runs it, and parses verifier rewards into scores. Swapping eval substrates later = rewriting one file.

## Session files

| file | role |
|---|---|
| `skillopt.config.json` | the run: skill, task pack, **rollout env**, splits, edit budget, gate metric |
| `skillopt.jsonl` | append-only log of every step (edit, selection scores, gate action, confidence) — the resume source of truth |
| `skillopt.md` | living session doc (objective, rollout env, what's been tried) |
| `best_skill.md` | the deployable artifact (updated on every new best) |
| `skillopt.snapshots/` | `skill_vNNNN.md` per accepted step |

## What's deliberately generic
No assumptions about what the skill does. Skill, task pack, agent, model, backend, and verifiers are all user-supplied. `examples/hello-harbor/` runs the whole shape on a toy skill with zero domain code.

## Roadmap (v1+)
- reconcile pi event wiring (idle auto-loop, compaction-resume, before-agent-start) and `harbor run` flags against live versions
- slow-update / meta-skill (epoch-boundary guidance into a protected region)
- autonomous edit-budget control; parallel rollouts; a live `/skillopt export` dashboard
- a separate optimizer model option (default keeps pi itself as the optimizer)

## License
MIT
