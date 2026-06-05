# hello-harbor (example)

The smallest end-to-end shape of a `pi-skillopt` session, with **no external
infra required to read it**. It optimizes a toy `format-answer` skill that should
return a file field wrapped in `<answer></answer>`.

What's here:

- `skills/format-answer/SKILL.md` — the skill under optimization.
- `skillopt.config.json` — the run config, including the **rollout env** (backend
  `docker`, agent `claude-code`, a model, and `apt: [jq]` as a preload).
- `tasks/title-basic/` — one Harbor task with two verifiers:
  - `verify/outcome.sh` — did it return the right title?
  - `verify/adherence.sh` — did it wrap the answer in `<answer></answer>` (the
    skill's prescribed behavior)?
- `tasks/SPLITS.md` — how splits work.

To actually run it you need the Harbor CLI (`uv tool install harbor`) and the
`docker` backend available; then from a pi session in this directory:

```
/skill:skillopt-create     # point it at ./skills/format-answer/SKILL.md and ./tasks
```

This pack has one task for illustration. `skillopt-taskpack` is how you turn a
real skill into a proper ~12–30 task pack.
