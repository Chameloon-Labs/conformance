#!/usr/bin/env bun
// The Chameloon space server conformance tests: what every server SDK (TypeScript, Python, Go, Rust, …) must do so the
// app works with it. Black box over HTTP: it copies fixtures/spaces to a fresh folder, starts your server on it, and
// talks to it the way the app does (signed requests included).
//
//   bun run.ts -- <command that serves a folder>      {dir} and {port} are filled in
//   bun run.ts -- bun ../sdk/bin/serve.ts {dir} --port {port}
//   bun run.ts --url http://localhost:8787            a server you started yourself on a copy of fixtures/spaces
//
// The `echo` space needs the echo bot (README.md). Exit code 0 when everything passes.
import { cpSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const here = import.meta.dir;
const args = process.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
const url = flag("url");
const only = flag("only");
if (args[0] === "--") args.shift(); // bun may or may not pass the separator on
const command = args;

// ---- start the server under test
const dir = mkdtempSync(join(tmpdir(), "chameloon-conformance-"));
cpSync(join(here, "fixtures/spaces"), dir, { recursive: true });
let base: string;
let child: ReturnType<typeof Bun.spawn> | undefined;
if (url) {
  base = url.replace(/\/$/, "");
} else if (command.length) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const cmd = command.map((a) => a.replaceAll("{dir}", dir).replaceAll("{port}", String(port)));
  child = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", env: { ...process.env, PORT: String(port), SPACES: dir } });
  base = `http://127.0.0.1:${port}`;
} else {
  console.error("Usage: bun run.ts -- <server command with {dir} and {port}>   or   bun run.ts --url <base url>");
  process.exit(2);
}
const stop = () => child?.kill();
process.on("exit", stop);

async function ready() {
  const until = Date.now() + 30_000;
  while (Date.now() < until) {
    try {
      if ((await fetch(`${base}/`)).ok) return;
    } catch {}
    if (child && child.exitCode !== null) break;
    await Bun.sleep(150);
  }
  console.error(`The server at ${base} didn't answer GET / within 30 s.`);
  if (child) {
    child.kill();
    console.error(await new Response(child.stderr as ReadableStream).text());
  }
  process.exit(2);
}

// ---- a tiny test runner
type Case = { name: string; fn: () => Promise<void> };
const cases: Case[] = [];
const test = (name: string, fn: () => Promise<void>) => cases.push({ name, fn });
class Fail extends Error {}
function expect(ok: unknown, what: string): asserts ok {
  if (!ok) throw new Fail(what);
}
const eq = (a: unknown, b: unknown, what: string) => expect(JSON.stringify(a) === JSON.stringify(b), `${what}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);

// ---- talking like the app
const enc = new TextEncoder();
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const b64 = (b: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(b instanceof Uint8Array ? b : new Uint8Array(b))));
const canonical = async (method: string, path: string, time: string, body: Uint8Array) =>
  `${method}\n${path}\n${time}\n${hex(await crypto.subtle.digest("SHA-256", body))}`;

const get = (path: string, headers: Record<string, string> = {}) => fetch(base + path, { headers });
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });

/** A phone with its own P-256 key, signing every request like the app (DeviceKey.swift). */
async function phone(device = `phone-${crypto.randomUUID().slice(0, 8)}`) {
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const key = b64(await crypto.subtle.exportKey("raw", keys.publicKey)); // X9.63, uncompressed
  let last = 0;
  const signed = async (method: string, path: string, opts: { body?: unknown; invite?: string; time?: number; sig?: string; sendBody?: string } = {}) => {
    const raw = opts.body === undefined ? new Uint8Array() : enc.encode(JSON.stringify(opts.body));
    // a phone never signs the same text twice: the same request in the same millisecond would be a replay
    const time = String(opts.time ?? (last = Math.max(Date.now(), last + 1)));
    const sig = opts.sig ?? b64(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keys.privateKey, enc.encode(await canonical(method, path, time, raw))));
    const headers: Record<string, string> = { "X-Chameloon-Key": key, "X-Chameloon-Time": time, "X-Chameloon-Signature": sig, "X-Chameloon-Device": device, "X-Chameloon-App": "conformance" };
    if (opts.invite) headers["X-Chameloon-Invite"] = opts.invite;
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    return { method, headers, body: opts.sendBody ?? (opts.body === undefined ? undefined : raw) } as RequestInit;
  };
  return { key, device, signed, fetch: async (method: string, path: string, opts: Parameters<typeof signed>[2] = {}) => fetch(base + path, await signed(method, path, opts)) };
}

type Sync = { done: string[]; pull: Record<string, { id: string; [k: string]: unknown }[]>; cursor: unknown; version?: number; notify?: { title: string; body: string }[] };
const op = (table: string, row: Record<string, unknown>, kind: "upsert" | "delete" | "event" = "upsert") =>
  ({ id: crypto.randomUUID(), op: kind, table, row, at: new Date().toISOString() });
async function sync(space: string, device: string, ops: unknown[] = [], cursor: unknown = 0, extra: object = {}): Promise<Sync> {
  const r = await post(`/${space}/sync`, { device, ops, cursor, ...extra });
  eq(r.status, 200, `POST /${space}/sync status`);
  return r.json();
}
const ids = (rows: { id: string }[] | undefined) => (rows ?? []).map((r) => r.id).sort();
async function errorSays(r: Response, word: string) {
  const text = await r.text();
  let said = "";
  try { said = JSON.parse(text).error; } catch {}
  expect(typeof said === "string" && said.length > 0, `the body is JSON {"error": "<sentence>"} (the app shows it); got ${JSON.stringify(text.slice(0, 120))}`);
  expect(said.toLowerCase().includes(word), `the error mentions "${word}"; got ${JSON.stringify(said)}`);
}

// =====================================================================================================================
// Packages and files

test("GET / lists the spaces", async () => {
  const r = await get("/");
  eq(r.status, 200, "status");
  eq(((await r.json()) as string[]).sort(), ["echo", "locked", "open", "shared"], "spaces");
});

test("GET /<space>/space is space.json with pages filled in", async () => {
  const r = await get("/open/space");
  eq(r.status, 200, "status");
  expect((r.headers.get("content-type") ?? "").includes("application/json"), "Content-Type is application/json");
  const p = await r.json();
  eq([p.name, p.version, p.icon, p.tint], ["Open", 3, "list-check", "#16A34A"], "fields from space.json");
  eq(p.sync, { tables: ["notes"] }, "sync");
  eq(p.pages.home, 'root = Page([Text("home")])\n', "pages.home is the file's text");
  eq(p.pages.chat, { ui: 'root = Page([Text("chat")])\n', scroll: "bottom" }, "pageScroll turns a page into {ui, scroll}");
  expect(!("$schema" in p), "$schema is left out");
  expect(!("pageScroll" in p), "pageScroll is left out");
});

test("unknown spaces, routes and files are 404", async () => {
  eq((await get("/nope/space")).status, 404, "unknown space");
  eq((await get("/Open/space")).status, 404, "space names are lowercase a-z, 0-9 and -");
  eq((await get("/open/nothing")).status, 404, "unknown route");
  eq((await get("/open/img/missing.png")).status, 404, "missing picture");
  eq((await get("/open/img/..%2Fspace.json")).status, 404, "no way out of img/");
  eq((await get("/open/img/space.json")).status, 404, "only png, jpg, jpeg and svg");
});

test("GET /<space>/img/<file> serves pictures with their type", async () => {
  const r = await get("/open/img/dot.png");
  eq(r.status, 200, "status");
  eq(r.headers.get("content-type"), "image/png", "Content-Type");
  eq(b64(await r.arrayBuffer()), b64(readFileSync(join(here, "fixtures/spaces/open/img/dot.png"))), "the file's bytes");
});

// =====================================================================================================================
// Access

test('auth "token": Authorization: Bearer <auth.json token>', async () => {
  const none = await get("/shared/space");
  eq(none.status, 401, "without the token");
  await errorSays(none, "token");
  eq((await get("/shared/space", { Authorization: "Bearer nope" })).status, 401, "a wrong token");
  eq((await get("/shared/space", { Authorization: "Bearer s3cret-token" })).status, 200, "the right token");
  eq((await get("/open/space", { Authorization: "Bearer whatever" })).status, 200, "open spaces ignore tokens");
});

test('auth "device": a signed phone with an invite gets in once, then by its key alone', async () => {
  eq((await get("/locked/space")).status, 401, "an unsigned request");
  const p = await phone();
  const noInvite = await p.fetch("GET", "/locked/space");
  eq(noInvite.status, 401, "signed, but unknown and no invite");
  await errorSays(noInvite, "invite");
  eq((await p.fetch("GET", "/locked/space", { invite: "WRONG-CODE" })).status, 401, "a wrong invite");
  eq((await p.fetch("GET", "/locked/space", { invite: "ABCD-EFGH" })).status, 200, "the invite lets it in");
  eq((await p.fetch("GET", "/locked/space")).status, 200, "known now: no invite needed");
  const s = await p.fetch("POST", "/locked/sync", { body: { device: p.device, ops: [], cursor: 0 } });
  eq(s.status, 200, "a signed POST with a body");
  const other = await phone();
  eq((await other.fetch("GET", "/locked/space", { invite: "ABCD-EFGH" })).status, 401, "a used-up invite (uses: 1) lets nobody else in");
  eq((await other.fetch("GET", "/locked/space", { invite: "MANY-MANY" })).status, 200, "an invite with uses: null lets any number in");
  const third = await phone();
  eq((await third.fetch("GET", "/locked/space", { invite: "MANY-MANY" })).status, 200, "… and another");
});

test('auth "device": replays, forgeries, tampering and old clocks are refused', async () => {
  const p = await phone();
  eq((await p.fetch("GET", "/locked/space", { invite: "MANY-MANY" })).status, 200, "let in");
  const once = await p.signed("GET", "/locked/space");
  eq((await fetch(base + "/locked/space", once)).status, 200, "a signed request");
  eq((await fetch(base + "/locked/space", once)).status, 401, "the same signature again (a replay)");
  eq((await p.fetch("GET", "/locked/space", { sig: b64(new Uint8Array(64)) })).status, 401, "a forged signature");
  // ECDSA signatures come in two valid forms (s and n - s): a replay with the other form must be refused too
  const orig = await p.signed("GET", "/locked/space");
  eq((await fetch(base + "/locked/space", orig)).status, 200, "a signed request");
  const h = orig.headers as Record<string, string>;
  const raw = Uint8Array.from(atob(h["X-Chameloon-Signature"]), (c) => c.charCodeAt(0));
  const n = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
  const s = BigInt("0x" + hex(raw.slice(32).buffer));
  const flipped = new Uint8Array(64);
  flipped.set(raw.slice(0, 32));
  flipped.set(Uint8Array.from((n - s).toString(16).padStart(64, "0").match(/../g)!.map((x) => parseInt(x, 16))), 32);
  eq((await fetch(base + "/locked/space", { ...orig, headers: { ...h, "X-Chameloon-Signature": b64(flipped) } })).status, 401, "a replay with the signature's other valid form (s → n − s)");
  const forSpace = await p.signed("GET", "/locked/space");
  eq((await fetch(base + "/locked/img/a.png", forSpace)).status, 401, "a signature for another path");
  const tampered = await p.signed("POST", "/locked/sync", { body: { device: p.device, ops: [], cursor: 0 }, sendBody: JSON.stringify({ device: p.device, ops: [], cursor: 99 }) });
  eq((await fetch(base + "/locked/sync", tampered)).status, 401, "a body changed after signing");
  eq((await p.fetch("GET", "/locked/space", { time: Date.now() - 10 * 60 * 1000 })).status, 401, "a clock 10 minutes behind");
  eq((await p.fetch("GET", "/locked/space", { time: Date.now() + 10 * 60 * 1000 })).status, 401, "a clock 10 minutes ahead");
  eq((await p.fetch("GET", "/locked/space", { time: Date.now() - 2 * 60 * 1000 })).status, 200, "a clock 2 minutes off is fine");
});

test("a signature covers the query string", async () => {
  const p = await phone();
  eq((await p.fetch("GET", "/locked/space", { invite: "MANY-MANY" })).status, 200, "let in");
  eq((await p.fetch("GET", "/locked/space?x=1")).status, 200, "signed with its query");
  const signed = await p.signed("GET", "/locked/space?x=1");
  eq((await fetch(base + "/locked/space?x=2", signed)).status, 401, "the query changed after signing");
});

// =====================================================================================================================
// Sync

test("sync needs a device id", async () => {
  eq((await post("/open/sync", { ops: [], cursor: 0 })).status, 400, "no device");
  eq((await post("/open/sync", { device: "", ops: [], cursor: 0 })).status, 400, "an empty device");
});

test("sync: done lists the ops, a phone never gets its own rows back, others get them", async () => {
  const a = `a-${crypto.randomUUID()}`, b = `b-${crypto.randomUUID()}`;
  const o = op("notes", { id: "n1", text: "hello" });
  const ra = await sync("open", a, [o], 0);
  eq(ra.done, [o.id], "done");
  eq(ids(ra.pull.notes), [], "no own rows in the pull");
  eq(ra.version, 3, "version is space.json's version");
  expect(ra.cursor !== undefined && ra.cursor !== null, "a cursor comes back");
  const rb = await sync("open", b, [], 0);
  eq(rb.pull.notes?.find((r) => r.id === "n1"), { id: "n1", text: "hello" }, "the other phone gets the row as it was sent");
  const again = await sync("open", b, [], rb.cursor);
  eq(ids(again.pull.notes), [], "nothing new since its cursor");
});

test("sync: retried op ids are stored once; changes and deletes go through", async () => {
  const a = `a-${crypto.randomUUID()}`, b = `b-${crypto.randomUUID()}`;
  const o = op("notes", { id: "n2", text: "one" });
  await sync("open", a, [o], 0);
  const rb = await sync("open", b, [], 0);
  const retry = await sync("open", a, [o], 0);
  eq(retry.done, [o.id], "a retried op is done again");
  eq(ids((await sync("open", b, [], rb.cursor)).pull.notes), [], "but not stored twice (nothing new for the other phone)");
  await sync("open", a, [op("notes", { id: "n2", text: "two" })], 0);
  const changed = await sync("open", b, [], rb.cursor);
  eq(changed.pull.notes?.find((r) => r.id === "n2")?.text, "two", "a changed row comes again");
  await sync("open", a, [op("notes", { id: "n2" }, "delete")], 0);
  const fresh = await sync("open", `c-${crypto.randomUUID()}`, [], 0);
  expect(!fresh.pull.notes?.some((r) => r.id === "n2"), "a deleted row is gone for a new phone");
});

test("sync: a cursor from the future (the server lost its data) starts over from 0", async () => {
  const a = `a-${crypto.randomUUID()}`;
  await sync("open", a, [op("notes", { id: "n3", text: "kept" })], 0);
  const r = await sync("open", `b-${crypto.randomUUID()}`, [], 999999999);
  expect(r.pull.notes?.some((x) => x.id === "n3"), "everything comes again");
  expect(typeof r.cursor === "string" ? Number(r.cursor) < 999999999 : (r.cursor as number) < 999999999, "and a real cursor");
});

test("sync: a phone on an older space version gets no rows until it updates", async () => {
  const a = `a-${crypto.randomUUID()}`, b = `b-${crypto.randomUUID()}`;
  await sync("open", a, [op("notes", { id: "n4", text: "new column world" })], 0);
  const o = op("notes", { id: "n5", text: "from an old phone" });
  const old = await sync("open", b, [o], 0, { version: 2 });
  eq(old.done, [o.id], "its changes are still taken");
  eq(old.pull, {}, "no rows");
  eq(old.cursor, 0, "its cursor comes back unchanged");
  eq(old.version, 3, "and the version to update to");
  const after = await sync("open", b, [], old.cursor, { version: 3 });
  expect(after.pull.notes?.some((x) => x.id === "n4"), "after updating it gets them");
});

test("sync: events are done but not stored as rows", async () => {
  const a = `a-${crypto.randomUUID()}`;
  const e = op("hello", { id: "e1", x: 1 }, "event");
  eq((await sync("open", a, [e], 0)).done, [e.id], "done");
  const fresh = await sync("open", `b-${crypto.randomUUID()}`, [], 0);
  expect(!("hello" in fresh.pull), "no table named after the event");
});

// =====================================================================================================================
// The echo bot

test("bot onOp: a note gets a reply row, which the phone that wrote the note does get", async () => {
  const a = `a-${crypto.randomUUID()}`;
  const r = await sync("echo", a, [op("notes", { id: "x1", text: "hi" })], 0);
  eq(r.pull.replies?.find((x) => x.id === "re-x1"), { id: "re-x1", text: "echo: hi", device: a }, "the reply (rows the bot writes go to every phone)");
});

test("bot onEvent: an event becomes a row, and store.notify reaches the phone with its sync", async () => {
  const a = `a-${crypto.randomUUID()}`;
  const r = await sync("echo", a, [op("ping", { id: "p1" }, "event")], 0);
  eq(r.pull.pongs?.find((x) => x.id === "p1"), { id: "p1", device: a }, "the pong row");
  const n = await sync("echo", a, [op("notify", { title: "Hi", body: "from the bot" }, "event")], r.cursor);
  eq(n.notify, [{ title: "Hi", body: "from the bot" }], "notify in the same sync");
  eq((await sync("echo", a, [], n.cursor)).notify ?? [], [], "and only once");
});

test("bot hook: POST /<space>/hook runs the bot's hook and answers with what it returns", async () => {
  const r = await post("/echo/hook", { id: "h1", text: "from n8n" });
  eq(r.status, 200, "status");
  eq(await r.json(), { ok: true, echoed: "from n8n" }, "the hook's answer");
  const s = await sync("echo", `a-${crypto.randomUUID()}`, [], 0);
  eq(s.pull.inbox?.find((x) => x.id === "h1"), { id: "h1", text: "from n8n" }, "the row it wrote reaches phones");
  eq((await post("/echo/hook", "[1, 2]")).status, 400, "a body that isn't a JSON object");
  eq((await post("/open/hook", { a: 1 })).status, 404, "a space without a hook");
});

// =====================================================================================================================

await ready();
let failed = 0;
for (const c of cases.filter((c) => !only || c.name.includes(only))) {
  try {
    await c.fn();
    console.log(`  \x1b[32m✓\x1b[0m ${c.name}`);
  } catch (e) {
    failed++;
    console.log(`  \x1b[31m✗\x1b[0m ${c.name}\n      ${e instanceof Fail ? e.message : (e as Error).stack}`);
  }
}
console.log(`\n${cases.length - failed} passed, ${failed} failed`);
stop();
process.exit(failed ? 1 : 0);
