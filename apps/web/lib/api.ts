// Client-side fetch helper for the /api/* route handlers.

export async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string; errors?: string[] } | null;
    throw new Error(body?.error ?? body?.errors?.join("; ") ?? `Request failed (${res.status})`);
  }
  return (await res.json()) as T;
}

export async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => null)) as (T & { errors?: string[]; error?: string }) | null;
  if (!res.ok) throw new Error(data?.errors?.join("; ") ?? data?.error ?? `Request failed (${res.status})`);
  return data as T;
}
