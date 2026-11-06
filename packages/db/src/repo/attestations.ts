import { desc, eq } from "drizzle-orm";
import type { RiskLevel, RiskReason } from "@arena/shared";
import type { Db } from "../client.ts";
import { attestations, riskStates } from "../schema.ts";
import { hex, newId } from "./util.ts";

export type AttestationKind = "perf" | "risk";

export interface AttestationRecord {
  id: string;
  kind: AttestationKind;
  txHash: `0x${string}` | null;
  payload: Record<string, unknown>;
  asOf: number;
}

export interface RiskStateRecord {
  id: string;
  level: RiskLevel;
  reasonCode: RiskReason;
  asOf: number;
  txHash: `0x${string}` | null;
}

export async function insertAttestation(
  db: Db,
  input: { id?: string; kind: AttestationKind; txHash?: string | null; payload: Record<string, unknown>; asOf: number },
): Promise<string> {
  const id = input.id ?? newId();
  await db
    .insert(attestations)
    .values({
      id,
      kind: input.kind,
      txHash: input.txHash ?? null,
      payload: input.payload,
      asOf: input.asOf,
    })
    .onConflictDoNothing({ target: attestations.id });
  return id;
}

/** Most recent attestation of a kind, by asOf. */
export async function latestAttestation(db: Db, kind: AttestationKind): Promise<AttestationRecord | null> {
  const [row] = await db
    .select()
    .from(attestations)
    .where(eq(attestations.kind, kind))
    .orderBy(desc(attestations.asOf), desc(attestations.id))
    .limit(1);
  if (!row) return null;
  return {
    id: row.id,
    kind: row.kind as AttestationKind,
    txHash: row.txHash ? hex(row.txHash) : null,
    payload: row.payload,
    asOf: row.asOf,
  };
}

export const latestPerfAttestation = (db: Db) => latestAttestation(db, "perf");

/** Records a RiskOracle level, e.g. after a CRE WF2 report lands. Idempotent on id when given. */
export async function insertRisk(
  db: Db,
  input: { id?: string; level: RiskLevel; reasonCode: RiskReason; asOf: number; txHash?: string | null },
): Promise<string> {
  const id = input.id ?? newId();
  await db
    .insert(riskStates)
    .values({
      id,
      level: input.level,
      reasonCode: input.reasonCode,
      asOf: input.asOf,
      txHash: input.txHash ?? null,
    })
    .onConflictDoNothing({ target: riskStates.id });
  return id;
}

/** Current platform risk level (latest asOf). Null if no risk state has ever been recorded. */
export async function latestRisk(db: Db): Promise<RiskStateRecord | null> {
  const [row] = await db
    .select()
    .from(riskStates)
    .orderBy(desc(riskStates.asOf), desc(riskStates.id))
    .limit(1);
  if (!row) return null;
  return {
    id: row.id,
    level: row.level as RiskLevel,
    reasonCode: row.reasonCode as RiskReason,
    asOf: row.asOf,
    txHash: row.txHash ? hex(row.txHash) : null,
  };
}
