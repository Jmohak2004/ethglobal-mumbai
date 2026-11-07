// Chart intervals offered on /trade. Values are Coinbase candle granularities (seconds).

export const INTERVALS = [
  { label: "1m", seconds: 60 },
  { label: "5m", seconds: 300 },
  { label: "15m", seconds: 900 },
  { label: "1h", seconds: 3600 },
] as const;

export const DEFAULT_INTERVAL_SECONDS = 300;

export function intervalFromLabel(label: string | null | undefined): number {
  return INTERVALS.find((i) => i.label === label)?.seconds ?? DEFAULT_INTERVAL_SECONDS;
}

export function intervalLabel(seconds: number): string {
  return INTERVALS.find((i) => i.seconds === seconds)?.label ?? "5m";
}
