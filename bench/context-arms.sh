#!/bin/sh
# Runs the classifier arms for the context comparison over one suite: each model with the command
# alone, with the chat model's session view sent as its own `context` key, and with that session
# folded into the command text. Results land in bench/results/<stages>-<thresholds>-<model>[-ctx<char><mode>].
# Score them with: node bench/score-arms.mjs
# Usage: sh bench/context-arms.sh [suite] [context-chars]
set -e
cd "$(dirname "$0")/.."
suite=${1:-mix100}
chars=${2:-1200}
for m in kev lancet jev; do
  for mode in baseline state command; do
    echo "=== $m / $mode"
    if [ "$mode" = baseline ]; then
      node bench/run.mjs --config bench/config.$m.json --stages classifier --suites "$suite" --arm "$m"
    else
      node bench/run.mjs --config bench/config.$m.json --stages classifier --suites "$suite" --arm "$m" --context-chars "$chars" --context-in "$mode"
    fi
  done
done
