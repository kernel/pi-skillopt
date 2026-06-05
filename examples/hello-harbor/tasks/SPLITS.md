# Splits (hello-harbor)

This pack ships 6 tasks so a real train / selection / test split exists. The
example config (`../skillopt.config.json`) pins them explicitly:

```json
"splits": {
  "train":     ["capital-france", "ceo-acme", "founded-globex"],
  "selection": ["capital-japan", "mascot-pip"],
  "test":      ["capital-spain"]
}
```

When `splits` is left empty, `init_optimization` derives a 60/20/20 split
automatically — but with only 6 tasks the floor-rounded selection set is thin,
so the example pins them. A real pack wants ~12–30 tasks; `skillopt-taskpack`
generates one from a single skill.

Rule: the three lists must be disjoint. The loop only ever rolls out `train` and
`selection`; `test` is scored once, by `skillopt-finalize`.

## What each task checks

Every task gives the agent a fact and asks it to write the answer to
`/app/answer.txt`. The verifier (`<task>/tests/test.sh`) writes two independent
rewards to `/logs/verifier/reward.json`:

- `outcome` — the value between `<answer>...</answer>` is correct.
- `adherence` — the file is *exactly* `<answer>value</answer>` and nothing else
  (the format the skill is supposed to teach).

The two come apart on purpose: an agent can get the value right but the format
wrong (`outcome` 1, `adherence` 0). That gap is what the optimizer closes by
tightening the skill — the whole reason to optimize a skill rather than just a
prompt.
