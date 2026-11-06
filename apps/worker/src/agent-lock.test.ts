import { describe, expect, test } from "bun:test";
import { AgentLock } from "./agent-lock.ts";

describe("AgentLock", () => {
  test("calls for one agent run one after another, in order", async () => {
    const lock = new AgentLock();
    const events: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const first = lock.run("agent-a", async () => {
      events.push("a1-start");
      await gate;
      events.push("a1-end");
    });
    const second = lock.run("agent-a", async () => {
      events.push("a2");
    });
    await lock.run("agent-b", async () => {
      events.push("b");
    });
    expect(events).toEqual(["a1-start", "b"]); // another agent is not blocked

    release();
    await Promise.all([first, second]);
    expect(events).toEqual(["a1-start", "b", "a1-end", "a2"]);
  });

  test("a failed call does not block the next one", async () => {
    const lock = new AgentLock();
    await expect(
      lock.run("agent-a", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await lock.run("agent-a", async () => 7)).toBe(7);
  });
});
