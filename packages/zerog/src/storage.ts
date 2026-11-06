import { createHash } from "node:crypto";
import { Indexer, MemData } from "@0gfoundation/0g-storage-ts-sdk";
import { JsonRpcProvider, Wallet } from "ethers";

export interface PutJsonResult {
  rootHash: string;
  txHash?: string;
  /** True when the root is a local pseudo-hash, not a real 0G Storage root. */
  local?: boolean;
}

/** Where episode and reflection batches are written. Lessons keep the returned root in `zgStorageRoot`. */
export interface MemoryStore {
  putJson(obj: unknown): Promise<PutJsonResult>;
}

export interface ZeroGStorageOptions {
  /** 0G chain RPC used to submit the storage transaction (Galileo testnet or 0G mainnet). */
  rpcUrl: string;
  /** Storage indexer, e.g. https://indexer-storage-testnet-turbo.0g.ai on testnet. */
  indexerUrl: string;
  /** Signer that pays for the storage transaction. Never log this. */
  privateKey: string;
}

export const TESTNET_TURBO_INDEXER_URL = "https://indexer-storage-testnet-turbo.0g.ai";

/** Uploads JSON to 0G Storage with the official TS SDK. Exercised manually only (needs a funded key). */
export class ZeroGStorage implements MemoryStore {
  private readonly rpcUrl: string;
  private readonly indexerUrl: string;
  private readonly privateKey: string;

  constructor(opts: ZeroGStorageOptions) {
    this.rpcUrl = opts.rpcUrl;
    this.indexerUrl = opts.indexerUrl;
    this.privateKey = opts.privateKey;
  }

  async putJson(obj: unknown): Promise<PutJsonResult> {
    const bytes = new TextEncoder().encode(JSON.stringify(obj));
    const file = new MemData(bytes);

    const [, treeErr] = await file.merkleTree();
    if (treeErr !== null) throw new Error(`0G Storage merkle tree failed: ${treeErr.message}`);

    const provider = new JsonRpcProvider(this.rpcUrl);
    const signer = new Wallet(this.privateKey, provider);
    const indexer = new Indexer(this.indexerUrl);

    const [tx, uploadErr] = await indexer.upload(file, this.rpcUrl, signer);
    if (uploadErr !== null) throw new Error(`0G Storage upload failed: ${uploadErr.message}`);

    if (!("rootHash" in tx)) {
      throw new Error("0G Storage returned a fragmented upload; memory batches are expected to be single-file");
    }
    return { rootHash: tx.rootHash, txHash: tx.txHash };
  }
}

/** Local stand-in for development and tests. Roots are sha256 digests prefixed with `local:` and flagged `local: true`. */
export class NoopMemoryStore implements MemoryStore {
  async putJson(obj: unknown): Promise<PutJsonResult> {
    const digest = createHash("sha256").update(JSON.stringify(obj)).digest("hex");
    return { rootHash: `local:sha256:${digest}`, local: true };
  }
}
