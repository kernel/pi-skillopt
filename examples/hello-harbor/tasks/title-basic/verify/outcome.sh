#!/usr/bin/env bash
# Outcome verifier: did the agent return the correct title?
# Emits a reward in [0,1] on stdout as `REWARD <n>` (illustrative — match your
# Harbor version's verifier contract).
set -euo pipefail

answer="$(grep -oP '(?<=<answer>).*?(?=</answer>)' "${AGENT_OUTPUT:-/work/output.txt}" | tail -1 || true)"
if [ "$answer" = "Hello Harbor" ]; then
  echo "REWARD 1"
else
  echo "REWARD 0"
fi
