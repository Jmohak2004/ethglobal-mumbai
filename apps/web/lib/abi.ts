// Minimal ABIs for the calls the web app makes. Copied from contracts/abi/*.json (only the used entries).
// Client-safe.

export const ERC20_ABI = [
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

export const MARKETPLACE_ABI = [
  {
    type: "function",
    name: "fork",
    stateMutability: "nonpayable",
    inputs: [{ name: "agentId", type: "bytes32" }],
    outputs: [],
  },
  {
    type: "event",
    name: "Forked",
    anonymous: false,
    inputs: [
      { name: "agentId", type: "bytes32", indexed: true },
      { name: "buyer", type: "address", indexed: true },
      { name: "configHash", type: "bytes32", indexed: false },
      { name: "priceUsd6", type: "uint256", indexed: false },
      { name: "platformCut", type: "uint256", indexed: false },
    ],
  },
] as const;

export const TREASURY_ABI = [
  {
    type: "function",
    name: "withdraw",
    stateMutability: "nonpayable",
    inputs: [
      { name: "agentId", type: "bytes32" },
      { name: "amountUsd6", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "withdrawable",
    stateMutability: "view",
    inputs: [{ name: "agentId", type: "bytes32" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "getAccount",
    stateMutability: "view",
    inputs: [{ name: "agentId", type: "bytes32" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "balance", type: "uint256" },
          { name: "commissionPaid", type: "uint256" },
          { name: "reserveTarget", type: "uint256" },
          { name: "dailyTopUpCap", type: "uint256" },
          { name: "hasCustomDailyCap", type: "bool" },
          { name: "topUpDay", type: "uint256" },
          { name: "toppedUpToday", type: "uint256" },
          { name: "topUpNonce", type: "uint256" },
        ],
      },
    ],
  },
] as const;
