---
name: jq-surgeon
description: Query and transform JSON with the jq CLI so the result is both correct and consumable by the next step. Covers raw vs encoded output, missing-key and error semantics, safe value injection with --arg/--argjson, multi-input handling, and the core transform vocabulary, so JSON pipelines stop relying on grep/sed or hand-rolled parsing.
---

# jq-surgeon

When data is JSON in and JSON or scalar values out, use jq. It parses the
structure once and lets you select, reshape, and aggregate without guessing at
whitespace or key order. Do not reach for grep/sed/awk on JSON text, and do not
hand-roll a parser in python for what a one-line filter does.

The job is not just a correct filter — it is output the next step can actually
consume. Decide up front where the result goes (a shell variable, a file,
another tool, a human) and pick the flags that match.

## Output: raw vs encoded

jq emits JSON-encoded values by default, so strings come back with their
quotes. That is right when the output is itself JSON. It is wrong when the
value flows into a shell variable, a filename, a URL, or another tool that
wants the bare string.

- Use `-r` / `--raw-output` whenever you extract a scalar for downstream use:
  `name=$(jq -r '.user.name' u.json)`. Without it you get `"alice"`, quotes and
  all, and everything downstream breaks subtly.
- Keep the default (no `-r`) when you are producing JSON to pipe into more jq or
  store as JSON.

## Missing keys and error semantics

Traversing a key that does not exist yields `null` — it does not error. A
pipeline that assumes "missing key fails loudly" will instead carry `null`
forward silently.

- Provide defaults with `//`: `.timeout // 30`.
- Suppress errors in a path with `?` when an element may be the wrong type:
  `.items[]?.id`.
- Use `-e` / `--exit-status` so a script can branch on the result: jq exits
  non-zero when the last output is `null` or `false` (and when there is no
  output). `if jq -e '.enabled' cfg.json >/dev/null; then ...` distinguishes a
  real value from an empty/false/null result. Without `-e` the command succeeds
  regardless and the script cannot tell the difference.

## Inject values, do not interpolate

Never splice a shell variable into the filter text. Quotes, spaces, and `$( )`
in the data turn into broken programs or injected code.

- Strings: `--arg name "$VALUE"` binds `$name` as a string inside the filter.
- JSON (numbers, booleans, arrays, objects): `--argjson n "$NUM"` parses the
  value as JSON first.
- This is also the correctness fix for numeric comparison: `--arg n 5` makes
  `$n` the string `"5"`, so `.count == $n` is false against the number `5`. Use
  `--argjson n 5` when the value should be a number, array, or object.

## Multiple inputs

- `-s` / `--slurp` reads a whole stream of JSON values into a single array, so
  you can `add`, `group_by`, or index across them.
- `-n` with the `inputs` builtin gives full control over consuming the stream
  yourself (for example, streaming reduce without slurping everything).
- Format output safely with the encoders: `@csv`, `@tsv`, `@json`, `@base64`.
  Pair them with `-r` so the encoded line is written raw, not re-quoted.

## Transform vocabulary

Name and use these rather than reinventing them:

- `map(f)` / `.[] | f` to transform each element.
- `select(cond)` to filter a stream.
- `group_by(.k)` then `map(...)` to aggregate by a key.
- `add` to sum numbers or concatenate arrays/strings.
- `reduce .[] as $x (init; step)` for custom folds.
- `to_entries` / `from_entries` to treat an object as key/value pairs and back.
- `has("k")`, `contains(x)` for membership tests.

## Gotchas

- Forgetting `-r` when the value goes into a shell variable, a file, or another
  tool — the downstream consumer ends up with a quoted `"value"`, quotes baked
  in, instead of the bare string.
- Interpolating a shell variable into the filter text instead of binding it with
  `--arg` / `--argjson` — breaks on quotes and special characters and is an
  injection risk.
- Assuming a missing key errors; it yields `null`, which then flows downstream
  unnoticed. Use `//` for a default or `?` to suppress a path error on the wrong
  type.
- Omitting `-e` in a script that checks a value — the command exits 0 whether
  the result is real or empty/false/null, so the script cannot branch on it.
- Using a format encoder like `@csv` or `@tsv` without `-r` — the encoded line
  comes back as a quoted JSON string instead of a bare row, which defeats the
  encoder and breaks the file or tool that reads it.
- Falling back to grep/sed/awk on the JSON text (or a one-off python parser)
  instead of staying inside jq — fragile against whitespace and key ordering.
- Using `--arg` for a number, boolean, or array — it arrives as a string, so
  numeric and structural comparisons silently fail. Use `--argjson`.
