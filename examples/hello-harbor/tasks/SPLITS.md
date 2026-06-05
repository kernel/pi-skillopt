# Splits (hello-harbor)

This toy pack ships a single task (`title-basic`) to show the file shape. A real
pack needs ~12–30 tasks so a 60/20/20 split leaves a meaningful selection set.

`init_optimization` derives splits automatically when `skillopt.config.json`'s
`splits` are empty. To pin them by hand, list task ids per split:

```json
"splits": {
  "train":     ["title-basic", "..."],
  "selection": ["..."],
  "test":      ["..."]
}
```

Rule: the three lists must be disjoint. The loop only ever rolls out `train` and
`selection`; `test` is scored once, by `skillopt-finalize`.
