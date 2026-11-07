#!/usr/bin/env bash
# Writes the ABI array of each main contract to abi/<Contract>.json.
# Runs `forge build` first. Requires jq.
set -euo pipefail

cd "$(dirname "$0")"

command -v jq >/dev/null 2>&1 || { echo "jq is required" >&2; exit 1; }

forge build

mkdir -p abi
for contract in AgentRegistry StrategyMarketplace PerformanceRegistry AgentTreasury RiskOracle TradeJournal; do
  jq '.abi' "out/${contract}.sol/${contract}.json" > "abi/${contract}.json"
  echo "wrote abi/${contract}.json"
done
