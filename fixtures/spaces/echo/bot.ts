// The echo bot every SDK implements for the conformance tests (see conformance/README.md, "The echo bot").
import type { Op, Store } from "@chameloon-labs/space/server";

export function onOp(op: Op, store: Store, device: string) {
  if (op.table === "notes" && op.op === "upsert") store.put("replies", { id: `re-${op.row.id}`, text: `echo: ${op.row.text}`, device });
}

export function onEvent(event: string, data: unknown, store: Store, device: string) {
  const d = (data ?? {}) as { id?: string; title?: string; body?: string };
  if (event === "ping") store.put("pongs", { id: String(d.id), device });
  if (event === "notify") store.notify(String(d.title), String(d.body));
}

export function hook(body: Record<string, unknown>, store: Store) {
  store.put("inbox", { id: String(body.id), text: String(body.text) });
  return { ok: true, echoed: body.text };
}
