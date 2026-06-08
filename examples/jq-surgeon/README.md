# jq-surgeon (example)

Optimizes a `jq-surgeon` skill: querying and transforming JSON with the `jq` CLI
so the result is both correct and consumable by the next step — raw vs encoded
output, missing-key and error semantics, safe value injection, multi-input
handling, and the core transform vocabulary.

This example **deliberately ships without a task pack**. There is no `tasks/`
dir — you build one by running `skillopt-taskpack`, which derives the tasks and
verifiers from the skill.

What's here:

- `skills/jq-surgeon/SKILL.md` — the skill under optimization.
- `skillopt.config.json` — the run config: backend `docker`, agent
  `claude-code`, a model, and the `ANTHROPIC_API_KEY` secret to pass through.
  The splits are empty; task creation fills them in.

## Run it

You need the Harbor CLI (`uv tool install harbor`) and a working `docker`
backend. From a pi session in this directory:

```
/skill:skillopt-create     # set up the run — with no task pack yet, it leads into skillopt-taskpack
```

`skillopt-create` walks you through the run config, then — because this example
ships without a `tasks/` dir — hands off to `skillopt-taskpack` to derive the
tasks and verifiers from the skill. Once the pack exists with `solution/solve.sh`
files, you can smoke-test the pipeline for free by setting `"agent": "oracle"` in
`skillopt.config.json` — the oracle agent runs each task's solution instead of a
model, so every task scores 1.0 and you can confirm the whole pipeline works
before spending any model tokens. Switch the agent back to `claude-code` for a
real run.
