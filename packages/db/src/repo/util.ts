import { randomUUID } from "node:crypto";

/** New primary key for rows the repo creates. */
export const newId = (): string => randomUUID();

/** Canonical address form stored in the database: trimmed and lowercased. */
export const addr = (address: string): string => address.trim().toLowerCase();

/** Narrow a stored text column to a 0x-prefixed type. Values come from addr() or chain data. */
export const hex = (value: string): `0x${string}` => value as `0x${string}`;

/** Bounded LIMIT for list queries. Returns fallback when undefined or not finite. */
export function clampLimit(limit: number | undefined, fallback: number, max: number): number {
  if (limit === undefined || !Number.isFinite(limit)) return fallback;
  return Math.min(Math.max(1, Math.floor(limit)), max);
}
