// Personal 0G key kept in this browser only (localStorage). Never sent anywhere except the x-user-0g-key
// header on AI requests to this app's own API. Client-only.
const KEY = "arena.zg-key";

export function getUserZgKey(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(KEY);
}

export function setUserZgKey(key: string): void {
  window.localStorage.setItem(KEY, key.trim());
  window.dispatchEvent(new Event("arena:zg-key"));
}

export function clearUserZgKey(): void {
  window.localStorage.removeItem(KEY);
  window.dispatchEvent(new Event("arena:zg-key"));
}

/** Header object for AI requests (empty when no personal key is set). */
export function zgKeyHeaders(): Record<string, string> {
  const key = getUserZgKey();
  return key ? { "x-user-0g-key": key } : {};
}
