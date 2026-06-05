---
name: format-answer
description: Toy skill used by the hello-harbor example. Teaches an agent to answer a question by writing the value, wrapped in <answer></answer> tags, to the file the task names.
---

# format-answer

When a task asks you to answer a question or extract a value:

1. Work out the value the task is asking for.
2. Write it to the output file the task names (for example `/app/answer.txt`).
3. Write the value wrapped in `<answer>` and `</answer>` tags.

## Gotchas
- Wrap the value in `<answer>...</answer>` — the grader reads what is between the tags.
- Write the value only — no prose, no explanation, no surrounding quotes.
