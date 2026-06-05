# pi-skillopt

### Optimize any agent `SKILL.md` against a Harbor eval substrate — the [SkillOpt](https://github.com/microsoft/SkillOpt) way

*Bring a skill. The plugin generates the task pack, rolls the skill out on real tasks via [Harbor](https://github.com/harbor-framework/harbor), reflects on failures, applies bounded edits, and keeps an edit only if it strictly improves a held-out score.*

A plugin for **[pi](https://pi.dev/)**. Inspired in structure by [pi-autoresearch](https://github.com/davebcn87/pi-autoresearch): a domain-agnostic **extension** provides the machinery, **skills** encode the workflow. Here the optimization target is a single skill document, the benchmark is a Harbor rollout, and "keep/revert" is SkillOpt's validation gate.

> **Status: v0.** The loop/gate/splits/Harbor-seam/jsonl logic is real and unit-testable; the **skills are usable today** (they're just instructions an agent follows). The **Harbor seam is validated end-to-end against a live Harbor run on the e2b backend** — `run_rollout` builds the `JobConfig`, runs `harbor run --config`, and reads each trial's rewards from its `result.json`, producing correct `hard`/`soft` scores. Proven on `examples/hello-harbor` with both the `oracle` agent and a real **`claude-code`** agent (Opus 4.8) that installs itself in the sandbox, registers the injected skill, and uses it (outcome + adherence both 1.0). What's left: the extension's **pi event wiring** is shaped from upstream and needs a reconciliation pass against a live pi build — search the code for `RECONCILE:`.

---

## Why

[SkillOpt](https://arxiv.org/abs/2605.23904) showed you can "train" a frozen agent's `SKILL.md` like weights — propose edits from scored rollouts, accept only edits that beat a held-out selection score. But its repo is a research harness: to use it on *your* skill you must implement a dataset + rollout + scorer. Harbor already *is* that layer — it runs agents (Claude Code, Codex, …) in containers and returns verifier rewards. `pi-skillopt` is the glue, wrapped as a plugin you install instead of a framework you fork.

## Install

No npm publish required — pi installs packages straight from git or a local path:

```bash
# from GitHub — private repo, so SSH (uses your configured keys):
pi install git:git@github.com:kernel/pi-skillopt@main
# HTTPS works too (needs a git credential for the private repo):
pi install git:github.com/kernel/pi-skillopt@main

# from a local checkout — best for development, no copy:
git clone git@github.com:kernel/pi-skillopt && pi install ./pi-skillopt

# try it for a single run without installing:
pi -e git:git@github.com:kernel/pi-skillopt
```

The git ref pins to a tag/commit/branch; `pi update` reconciles it. To share with a
team, `pi install -l …` writes it to project settings (`.pi/settings.json`) and pi
auto-installs on startup once the project is trusted. (`pi install npm:pi-skillopt`
also works if it's ever published.)

Requires the Harbor CLI for rollouts: `uv tool install harbor`. For a remote
backend (recommended — and the one this seam is validated against), install the
extra and export your key, e.g. e2b: `uv tool install 'harbor[e2b]'` +
`export E2B_API_KEY=…`.

> **e2b gotchas (Harbor 0.13.x):** Harbor's e2b adapter hard-codes a 24-hour
> sandbox lifetime, which the e2b **hobby tier rejects** (1-hour cap) with
> `400: Timeout cannot be greater than 1 hours` — use a Pro-tier key, or cap
> `timeout` in `harbor/environments/e2b.py`. Also, e2b's Dockerfile parser warns
> `Unsupported instruction: COMMENT` on `#` comment lines — harmless, the
> template still builds.

## Use it

You arrive with just a skill.

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
`extensions/pi-skillopt/harbor.ts` is the only file that knows Harbor. From the rollout env it builds a Harbor `JobConfig` (the candidate skill injected via `agents[].skills`, the split's tasks listed in `tasks[]`), runs `harbor run --config`, then reads each trial's verifier rewards from the job's `result.json` and aggregates them into `hard`/`soft` scores. Swapping eval substrates later = rewriting one file.

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
- reconcile the pi event wiring (idle auto-loop, compaction-resume, before-agent-start) against a live pi build (the Harbor seam is already pinned to Harbor 0.13.x)
- slow-update / meta-skill (epoch-boundary guidance into a protected region)
- autonomous edit-budget control; parallel rollouts; a live `/skillopt export` dashboard
- a separate optimizer model option (default keeps pi itself as the optimizer)

## License
MIT
