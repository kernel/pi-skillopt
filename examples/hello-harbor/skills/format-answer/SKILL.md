---
name: format-answer
description: Toy skill used by the hello-harbor example. Teaches an agent to read a file and return a requested field wrapped in <answer></answer> tags.
---

# format-answer

When asked to extract a value from a file:

1. Read the file at the path given in the task.
2. Find the requested field.
3. Return ONLY the value, wrapped in `<answer>` and `</answer>` tags.

## Gotchas
- Always wrap the value in `<answer>...</answer>` — graders look for the tag.
- Return the value only — no prose, no explanation, no surrounding quotes.
