// Serializes work per agent. A tick, a paper TP/SL exit and a paper ledger write all touch the same orders and
// ledger rows, so each runs inside the agent's lock. Different agents never wait on each other.

export class AgentLock {
  private readonly tails = new Map<string, Promise<unknown>>();

  /** Runs fn after every earlier call for the same key has settled. A rejected call does not block later ones. */
  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    const tail = next.catch(() => undefined);
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return next;
  }
}
