// Outbound Telegram queue honouring the Bot API limits: at most `maxPerSecond` messages across all
// chats per rolling second, and at most one message per second to the same chat. A 429 pauses the
// whole queue for retry_after seconds and re-queues the message.

export interface SendQueueOptions {
  send: (chatId: string, html: string) => Promise<void>;
  /** Global budget per rolling 1 s window. Default 25 (Telegram allows ~30). */
  maxPerSecond?: number;
  /** Minimum gap between messages to one chat. Default 1000 ms. */
  perChatGapMs?: number;
  /** Attempts for transient failures before the message is dropped. Default 3. */
  maxAttempts?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (msg: string) => void;
}

export interface SendQueue {
  enqueue(chatId: string, html: string): void;
  /** Resolves once everything queued so far has been attempted. */
  drain(): Promise<void>;
  pending(): number;
}

interface Item {
  chatId: string;
  html: string;
  attempts: number;
}

const WINDOW_MS = 1000;

export function createSendQueue(opts: SendQueueOptions): SendQueue {
  const maxPerSecond = opts.maxPerSecond ?? 25;
  const gap = opts.perChatGapMs ?? WINDOW_MS;
  const maxAttempts = opts.maxAttempts ?? 3;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const log = opts.log ?? ((msg: string) => console.warn(msg));

  const queue: Item[] = [];
  const sentAt: number[] = [];
  const lastByChat = new Map<string, number>();
  let pausedUntil = 0;
  let running: Promise<void> | null = null;

  function kick(): void {
    if (running) return;
    running = pump().finally(() => {
      running = null;
      // An enqueue may have landed between the last check and this callback.
      if (queue.length > 0) kick();
    });
  }

  async function pump(): Promise<void> {
    while (queue.length > 0) {
      const t = now();
      while (sentAt.length > 0 && sentAt[0]! <= t - WINDOW_MS) sentAt.shift();
      const globalReady = sentAt.length >= maxPerSecond ? sentAt[sentAt.length - maxPerSecond]! + WINDOW_MS : 0;
      const base = Math.max(pausedUntil, globalReady);

      let pick = -1;
      let nextAt = Number.POSITIVE_INFINITY;
      for (let i = 0; i < queue.length; i++) {
        const last = lastByChat.get(queue[i]!.chatId);
        const ready = Math.max(base, last === undefined ? 0 : last + gap);
        if (ready <= t) {
          pick = i;
          break;
        }
        nextAt = Math.min(nextAt, ready);
      }
      if (pick < 0) {
        await sleep(Math.max(1, nextAt - t));
        continue;
      }

      const [item] = queue.splice(pick, 1) as [Item];
      sentAt.push(t);
      lastByChat.set(item.chatId, t);
      try {
        await opts.send(item.chatId, item.html);
      } catch (err) {
        const e = err as { error_code?: number; parameters?: { retry_after?: number }; message?: string };
        if (e.error_code === 429) {
          pausedUntil = now() + (e.parameters?.retry_after ?? 1) * 1000;
          queue.unshift(item);
        } else if (e.error_code === 400 || e.error_code === 403) {
          log(`[telegram] dropped message to chat ${item.chatId}: ${e.message ?? e.error_code}`);
        } else if (item.attempts + 1 < maxAttempts) {
          item.attempts += 1;
          queue.push(item);
        } else {
          log(`[telegram] gave up on message to chat ${item.chatId}: ${e.message ?? "unknown error"}`);
        }
      }
    }
  }

  return {
    enqueue(chatId, html) {
      queue.push({ chatId, html, attempts: 0 });
      kick();
    },
    async drain() {
      while (running) await running;
    },
    pending() {
      return queue.length;
    },
  };
}
