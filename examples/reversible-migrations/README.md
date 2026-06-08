# reversible-migrations (example)

Optimizes a `reversible-migrations` skill: authoring SQL schema migrations as
reversible up/down pairs against a SQLite database that already has rows, applied
with the `sqlite3` CLI. Each change is a pair `NNNN_name.up.sql` /
`NNNN_name.down.sql`, and the down has to return the database to its exact
pre-up state — including the data, not just the structure.

This example **deliberately ships without a task pack**. There is no `tasks/`
dir on purpose, so you have to derive the tasks and reward verifiers from the
skill itself.

What's here:

- `skills/reversible-migrations/SKILL.md` — the skill under optimization. Its
  `## Gotchas` section enumerates the concrete failure modes (empty downs,
  constraint-before-backfill, in-place renames, downs that lose rows).
- `skillopt.config.json` — the run config: backend `docker`, agent
  `claude-code`, a model, and the `ANTHROPIC_API_KEY` secret to pass through.
  The splits are empty — they get filled in once the task pack exists.

## Run it

From a pi session in this directory:

```
/skill:skillopt-taskpack   # derive tasks + reward verifiers from the skill
/skill:skillopt-create     # then run the optimization loop
```

`skillopt-taskpack` reads the SKILL.md and generates tasks with automated
verifiers from the failure modes in the `## Gotchas` section. Once the task
pack has `solution/solve.sh` files, set `"agent": "oracle"` in
`skillopt.config.json` to do a dry run before using a real model.
