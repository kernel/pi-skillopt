#!/usr/bin/env bash
# Adherence verifier: did the agent follow the skill's prescribed behavior
# (wrap the value in <answer></answer>)? Derived straight from the skill's gotcha.
# This is what makes optimization improve the skill's BEHAVIOR, not just accuracy.
set -euo pipefail

out="$(cat "${AGENT_OUTPUT:-/work/output.txt}" || true)"
if echo "$out" | grep -q "<answer>" && echo "$out" | grep -q "</answer>"; then
  echo "REWARD 1"
else
  echo "REWARD 0"
fi
