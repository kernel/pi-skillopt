# hello-harbor (example)

The smallest end-to-end shape of a `pi-skillopt` session. It optimizes a toy
`format-answer` skill that should answer a question by writing the value wrapped
in `<answer></answer>` to a file.

What's here:

- `skills/format-answer/SKILL.md` — the skill under optimization (deliberately a
  little underspecified, so there's something to optimize).
- `skillopt.config.json` — the run config, including the **rollout env**: backend
  `docker`, agent `claude-code`, a model, and the `ANTHROPIC_API_KEY` secret to
  pass through. Splits are pinned.
- `tasks/<id>/` — 6 real Harbor tasks. Each one is a standard Harbor task dir:
  - `task.toml` — task metadata (schema 1.3).
  - `instruction.md` — the prompt the agent sees.
  - `environment/Dockerfile` — the container image (python3 for the verifier,
    tmux/asciinema for terminal agents — all pre-baked, nothing installed at run
    time).
  - `tests/test.sh` + `tests/expected.txt` — the verifier. Writes two rewards
    (`outcome`, `adherence`) to `/logs/verifier/reward.json`.
  - `solution/solve.sh` — the reference solution (used by the `oracle` agent).
- `tasks/SPLITS.md` — the splits and what the two rewards mean.

## Run it

You need the Harbor CLI (`uv tool install harbor`) and a working `docker`
backend. From a pi session in this directory:

```
/skill:skillopt-create     # point it at ./skills/format-answer/SKILL.md and ./tasks
```

### Smoke-test the pipeline for free (no model, no API key)

Set the agent to `oracle` in `skillopt.config.json` (`"agent": "oracle"`). The
oracle agent runs each task's `solution/solve.sh` instead of a model, so every
task should score 1.0 — proving the whole rollout → verify → reward → gate
pipeline works end to end before you spend a cent. There's no learning to do in
that mode (the solution is always perfect); switch the agent back to
`claude-code` (or `codex`, `pi`, …) for a real optimization run.

This is a hand-written pack for illustration. `skillopt-taskpack` is how you turn
a real skill into a proper ~12–30 task pack.
