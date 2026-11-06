import { describe, expect, test } from "bun:test";
import { createSendQueue } from "./sendQueue.ts";

function fakeClock() {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

describe("createSendQueue", () => {
  test("caps global throughput at 25 messages per rolling second", async () => {
    const clock = fakeClock();
    const sent: { at: number; chat: string }[] = [];
    const queue = createSendQueue({
      send: async (chat) => {
        sent.push({ at: clock.now(), chat });
      },
      now: clock.now,
      sleep: clock.sleep,
    });
    for (let i = 0; i < 30; i++) queue.enqueue(`chat-${i}`, "x");
    await queue.drain();

    expect(sent).toHaveLength(30);
    expect(sent.filter((s) => s.at === 0)).toHaveLength(25);
    expect(sent.filter((s) => s.at >= 1000)).toHaveLength(5);
    expect(Math.max(...sent.map((s) => s.at))).toBe(1000);
  });

  test("allows at most one message per second to the same chat", async () => {
    const clock = fakeClock();
    const sent: { at: number; chat: string }[] = [];
    const queue = createSendQueue({
      send: async (chat) => {
        sent.push({ at: clock.now(), chat });
      },
      now: clock.now,
      sleep: clock.sleep,
    });
    queue.enqueue("A", "1");
    queue.enqueue("A", "2");
    queue.enqueue("A", "3");
    queue.enqueue("B", "4");
    await queue.drain();

    const timesFor = (chat: string) => sent.filter((s) => s.chat === chat).map((s) => s.at);
    expect(timesFor("A")).toEqual([0, 1000, 2000]);
    expect(timesFor("B")).toEqual([0]);
  });

  test("a 429 pauses the queue for retry_after and re-sends the message", async () => {
    const clock = fakeClock();
    const attempts: number[] = [];
    let failed = false;
    const queue = createSendQueue({
      send: async () => {
        attempts.push(clock.now());
        if (!failed) {
          failed = true;
          throw Object.assign(new Error("Too Many Requests"), { error_code: 429, parameters: { retry_after: 3 } });
        }
      },
      now: clock.now,
      sleep: clock.sleep,
      log: () => undefined,
    });
    queue.enqueue("A", "x");
    await queue.drain();
    expect(attempts).toEqual([0, 3000]);
  });

  test("drops messages rejected with 403 without retrying", async () => {
    const clock = fakeClock();
    let calls = 0;
    const queue = createSendQueue({
      send: async () => {
        calls++;
        throw Object.assign(new Error("Forbidden: bot was blocked"), { error_code: 403 });
      },
      now: clock.now,
      sleep: clock.sleep,
      log: () => undefined,
    });
    queue.enqueue("A", "x");
    await queue.drain();
    expect(calls).toBe(1);
    expect(queue.pending()).toBe(0);
  });
});
