import { describe, expect, test } from "bun:test";
import { NoopMemoryStore } from "./storage.ts";

describe("NoopMemoryStore", () => {
  test("returns a deterministic sha256-based root flagged as local", async () => {
    const store = new NoopMemoryStore();
    const obj = { episode: "e1", pnlUsd: 1.5 };

    const a = await store.putJson(obj);
    const b = await store.putJson(obj);

    expect(a.local).toBe(true);
    expect(a.rootHash).toMatch(/^local:sha256:[0-9a-f]{64}$/);
    expect(b.rootHash).toBe(a.rootHash);
  });

  test("different content yields a different root", async () => {
    const store = new NoopMemoryStore();

    const a = await store.putJson({ n: 1 });
    const b = await store.putJson({ n: 2 });

    expect(a.rootHash).not.toBe(b.rootHash);
  });
});
