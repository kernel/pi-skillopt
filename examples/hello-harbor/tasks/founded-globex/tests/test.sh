#!/bin/bash
# Harbor copies this dir to /tests and runs this script. It must write the reward
# to /logs/verifier/reward.json. python3 is pre-baked into the image.
python3 - <<'PY'
import json, re, pathlib

answer = pathlib.Path("/app/answer.txt")
expected = pathlib.Path("/tests/expected.txt").read_text().strip()
content = answer.read_text() if answer.exists() else ""

m = re.search(r"<answer>(.*?)</answer>", content, re.DOTALL)
value = m.group(1).strip() if m else ""

outcome = 1.0 if value.lower() == expected.lower() else 0.0
adherence = 1.0 if re.fullmatch(r"<answer>.*?</answer>", content) else 0.0

pathlib.Path("/logs/verifier").mkdir(parents=True, exist_ok=True)
json.dump({"outcome": outcome, "adherence": adherence},
          open("/logs/verifier/reward.json", "w"))
print(f"outcome={outcome} adherence={adherence} value={value!r} expected={expected!r}")
PY
