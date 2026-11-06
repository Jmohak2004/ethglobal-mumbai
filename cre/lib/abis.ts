// Minimal ABIs used by the CRE workflows (human-readable JSON form, as const for viem typing).

/** AgentRegistry (Base). Only the read paths the attestor needs. */
export const AGENT_REGISTRY_ABI = [
  {
    type: "function",
    name: "listActive",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bytes32[]" }],
  },
  {
    type: "function",
    name: "getAgent",
    stateMutability: "view",
    inputs: [{ name: "agentId", type: "bytes32" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "owner", type: "address" },
          { name: "tradingWallet", type: "address" },
          { name: "operator", type: "address" },
          { name: "zgWallet", type: "address" },
          { name: "creator", type: "address" },
          { name: "configHash", type: "bytes32" },
          { name: "forkedFrom", type: "bytes32" },
          { name: "template", type: "uint8" },
          { name: "commissionBps", type: "uint16" },
          { name: "forkPriceUsd6", type: "uint256" },
          { name: "forkable", type: "bool" },
          { name: "active", type: "bool" },
        ],
      },
    ],
  },
] as const;

/** Chainlink AggregatorV3Interface (Data Feeds). */
export const AGGREGATOR_V3_ABI = [
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
  {
    type: "function",
    name: "latestRoundData",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "roundId", type: "uint80" },
      { name: "answer", type: "int256" },
      { name: "startedAt", type: "uint256" },
      { name: "updatedAt", type: "uint256" },
      { name: "answeredInRound", type: "uint80" },
    ],
  },
  {
    type: "function",
    name: "getRoundData",
    stateMutability: "view",
    inputs: [{ name: "_roundId", type: "uint80" }],
    outputs: [
      { name: "roundId", type: "uint80" },
      { name: "answer", type: "int256" },
      { name: "startedAt", type: "uint256" },
      { name: "updatedAt", type: "uint256" },
      { name: "answeredInRound", type: "uint80" },
    ],
  },
] as const;
