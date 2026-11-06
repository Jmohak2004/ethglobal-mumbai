import { describe, expect, it } from "bun:test";
import { decodeFunctionData, erc20Abi, verifyTypedData } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  PERMIT2_ADDRESS,
  approvalRequirements,
  buildApprovalTx,
  localSigner,
  normalizeTypedData,
  signFlashOrder,
} from "./signing.ts";
import { USDC, WETH, orderTypedDataString, quoteFixture } from "./test-helpers.ts";

describe("normalizeTypedData", () => {
  it("drops EIP712Domain from types, makes chainId a number, and makes uint fields bigint", () => {
    const td = normalizeTypedData(orderTypedDataString);
    expect(Object.keys(td.types)).toEqual(["Order"]);
    expect(td.domain.chainId).toBe(8453);
    expect(td.primaryType).toBe("Order");
    expect(td.message.amount).toBe(1000000n);
    expect(td.message.deadline).toBe(1900000000n);
    expect(td.message.maker).toBe("0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045");
  });

  it("accepts an already-parsed object and rejects an unknown primaryType", () => {
    const parsed = JSON.parse(orderTypedDataString) as Record<string, unknown>;
    expect(normalizeTypedData(parsed).primaryType).toBe("Order");
    expect(() => normalizeTypedData({ ...parsed, primaryType: "Nope" })).toThrow(/not in types/);
  });

  it("converts nested struct and array fields", () => {
    const td = normalizeTypedData({
      domain: { chainId: 8453 },
      types: {
        Leg: [{ name: "qty", type: "uint128" }],
        Order: [
          { name: "legs", type: "Leg[]" },
          { name: "nonce", type: "uint256" },
        ],
      },
      primaryType: "Order",
      message: { legs: [{ qty: "5" }, { qty: 7 }], nonce: "0x10" },
    });
    expect(td.message.legs).toEqual([{ qty: 5n }, { qty: 7n }]);
    expect(td.message.nonce).toBe(16n);
  });

  it("rejects an unsafe JS number for an integer field instead of silently losing precision", () => {
    expect(() =>
      normalizeTypedData({
        domain: { chainId: 8453 },
        types: { Order: [{ name: "amount", type: "uint256" }] },
        primaryType: "Order",
        message: { amount: 2 ** 60 },
      }),
    ).toThrow(/unsafe integer/);
  });
});

describe("localSigner and signFlashOrder", () => {
  it("produces a signature that verifies against the funder address for the normalized payload", async () => {
    const key = generatePrivateKey();
    const signer = localSigner(key);
    expect(signer.address).toBe(privateKeyToAccount(key).address);

    const sig = await signFlashOrder(orderTypedDataString, signer);
    expect(sig).toMatch(/^0x[0-9a-f]{130}$/i);

    const td = normalizeTypedData(orderTypedDataString);
    const ok = await verifyTypedData({
      address: signer.address,
      domain: td.domain,
      types: td.types,
      primaryType: td.primaryType,
      message: td.message,
      signature: sig,
    });
    expect(ok).toBe(true);
  });

  it("uses a custom signer as long as it implements signTypedData", async () => {
    const seen: unknown[] = [];
    const sig = await signFlashOrder(orderTypedDataString, {
      address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
      signTypedData: async (td) => {
        seen.push(td);
        return "0x01";
      },
    });
    expect(sig).toBe("0x01");
    expect(seen).toHaveLength(1);
  });
});

describe("approvalRequirements", () => {
  it("nothing needed: only the order signature", () => {
    const r = approvalRequirements(quoteFixture());
    expect(r.requiresOnchainTx).toBe(false);
    expect(r.requiresPermitSignature).toBe(false);
    expect(r.permit2Address).toBeNull();
  });

  it("ERC-20 approveTx must be sent onchain before the order", () => {
    const r = approvalRequirements(
      quoteFixture({ evm: { approveTx: { to: USDC, data: "0x095ea7b3" }, permitTypedData: null, orderTypedData: orderTypedDataString } }),
    );
    expect(r.requiresOnchainTx).toBe(true);
    expect(r.approveTx).toEqual({ to: USDC, data: "0x095ea7b3" });
  });

  it("Permit2 path: permitTypedData must be signed, spender is the canonical Permit2 address", () => {
    const r = approvalRequirements(
      quoteFixture({ evm: { approveTx: null, permitTypedData: "{}", orderTypedData: orderTypedDataString } }),
    );
    expect(r.requiresPermitSignature).toBe(true);
    expect(r.requiresOnchainTx).toBe(false);
    expect(r.permit2Address).toBe(PERMIT2_ADDRESS);
  });

  it("setupTxs and wrap transactions count as onchain steps", () => {
    const r = approvalRequirements(
      quoteFixture({
        setupTxs: ["0xdeadbeef"],
        wrap: {
          nativeAsset: "ETH",
          wrappedAsset: WETH,
          evmTx: { to: WETH, data: "0xd0e30db0", value: "1" },
          svmInstructions: null,
        },
      }),
    );
    expect(r.requiresOnchainTx).toBe(true);
    expect(r.setupTxs).toEqual(["0xdeadbeef"]);
    expect(r.wrapTx?.to).toBe(WETH);
  });
});

describe("buildApprovalTx", () => {
  it("encodes ERC-20 approve(spender, amount) and does not send anything", () => {
    const spender = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
    const tx = buildApprovalTx(USDC, spender, 5_000_000n);
    expect(tx.to).toBe(USDC);
    expect(tx.data.startsWith("0x095ea7b3")).toBe(true);
    const decoded = decodeFunctionData({ abi: erc20Abi, data: tx.data });
    expect(decoded.functionName).toBe("approve");
    expect(decoded.args).toEqual([spender, 5_000_000n]);
  });

  it("rejects a negative amount", () => {
    expect(() => buildApprovalTx(USDC, USDC, -1n)).toThrow(RangeError);
  });
});
