// Server-only environment access. Parsed once with the platform schema from @arena/shared.
import { loadEnv, type Env } from "@arena/shared";

let cached: Env | undefined;

/** Parsed platform env. Throws on invalid values (fail loud at first use). */
export function env(): Env {
  cached ??= loadEnv(process.env);
  return cached;
}

export const isProduction = (): boolean => process.env.NODE_ENV === "production";

/** Flash submission is possible only when live mode is on, the kill switch is off and the key is present. */
export function flashLive(): boolean {
  const e = env();
  return e.EXECUTION_MODE === "live" && !e.GLOBAL_KILL_SWITCH && Boolean(e.DEFINITIVE_API_KEY);
}

/** SESSION_SECRET for signing session cookies. Must be at least 32 characters. Null disables sign-in. */
export function sessionSecret(): string | null {
  const s = process.env.SESSION_SECRET;
  return s && s.length >= 32 ? s : null;
}

/** Shared 0G Router base URL for the active network. */
export function zgRouterBaseUrl(): string | undefined {
  return env().ZG_ROUTER_URL || undefined;
}
