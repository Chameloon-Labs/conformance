# Chameloon server conformance

Tests every Chameloon space server must pass, in any language. They talk to your server over HTTP exactly like the
Chameloon app does (signed requests included), so a server that passes them works with the app.

```sh
bun run.ts -- <command that serves a folder>          # {dir} and {port} are filled in, PORT and SPACES are set too
bun run.ts -- bunx chameloon-serve {dir} --port {port}
bun run.ts -- python -m chameloon_space serve {dir} --port {port}
bun run.ts --url http://localhost:8787                # a server you started on a copy of fixtures/spaces
bun run.ts --only sync -- …                           # only the tests whose name contains "sync"
```

The runner copies `fixtures/spaces` to a fresh folder, starts your command on it, waits until `GET /` answers, runs
the tests and stops the server. It needs [Bun](https://bun.sh).

## What a server does

A server serves a folder with one sub-folder per space. A sub-folder is a space when it has a `space.json`:

```
spaces/
  todo/
    space.json        the package, without pages
    pages/*.oui       one OpenUI Lang page per file (home.oui is required)
    img/*.png|jpg|jpeg|svg   pictures
    auth.json         secrets for "auth": "token" | "device" (never served)
    server-data.json  the server's own state (rows, cursors, …), written by the server
    bot.*             optional: the space's bot (the language's own way of loading it)
```

| Route | Answer |
|---|---|
| `GET /` | JSON array of the space names |
| `GET /<space>/space` | `space.json` with `pages` filled in from `pages/*.oui` (`{"home": "<source>"}`). A page named in `space.json`'s `pageScroll` becomes `{"ui": "<source>", "scroll": "<value>"}`. `$schema` and `pageScroll` are left out. |
| `POST /<space>/sync` | See [Sync](#sync). |
| `GET /<space>/img/<file>` | The file, with `Content-Type` `image/png`, `image/jpeg` or `image/svg+xml`. File names match `^[\w-]+\.(png\|jpe?g\|svg)$`. |
| `POST /<space>/hook` | The bot's `hook(body, store, headers)`; answers with what it returns as JSON (`{"ok": true}` if nothing). `400` if the body isn't a JSON object, `404` if the space's bot has no hook. Not covered by the space's `auth` (the bot checks its caller). |

Space names match `^[a-z0-9-]+$`; anything else, and every unknown route or file, is `404`. A server may also require
one token for every request (`--token` / `TOKEN`): `Authorization: Bearer <token>`, `401` otherwise.

### Errors

Every access problem is `401` with a JSON body `{"error": "<one short sentence>"}`; the app shows the sentence:

| When | Sentence (or your own words) |
|---|---|
| token space, wrong or no token | This space needs its token. |
| device space, a header missing | This space needs a signed request from the Chameloon app. |
| clock more than 5 minutes off | The phone's clock is off by more than 5 minutes. |
| signature already used | This request was already used. |
| signature doesn't verify | The signature doesn't match. |
| unknown phone, no or no valid invite | This space needs an invite code. |

### Access (`auth` in space.json)

- `"open"` or none: anyone with the address.
- `"token"`: `Authorization: Bearer <token>` equal to `auth.json` `token` (compare in constant time).
- `"device"`: every request is signed by the phone:
  - `X-Chameloon-Key`: the phone's P-256 public key, X9.63 uncompressed (65 bytes), base64.
  - `X-Chameloon-Time`: Unix time in ms. Refuse if it's 5 minutes or more away from the server's clock.
  - `X-Chameloon-Signature`: ECDSA P-256 with SHA-256 over
    `METHOD + "\n" + path?query + "\n" + time + "\n" + hex(sha256(raw body))`, the signature as raw `r‖s`
    (64 bytes), base64. The path and query exactly as requested; an empty body hashes the empty string.
  - Refuse a signature seen in the last 10 minutes (replays).
  - A key listed in `auth.json` `devices` gets in. An unknown key needs `X-Chameloon-Invite` matching an
    `auth.json` invite with `uses` > 0 or `uses: null` (unlimited). The server then adds
    `{"key", "device": <X-Chameloon-Device>, "added": <ISO time>, "note": <the invite's note>}` to `devices`,
    takes one use off the invite and removes used-up invites.

`auth.json`:

```json
{ "token": "…", "invites": [{ "code": "K7QM-3XRP", "uses": 1, "note": "Anna's phone" }],
  "devices": [{ "key": "<base64>", "device": "<phone id>", "added": "2026-11-10T12:00:00.000Z", "note": "…" }] }
```

Invite codes are 4 + 4 characters from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`, like `K7QM-3XRP`.

### Sync

`POST /<space>/sync` with `{"device", "ops": [...], "cursor", "push"?, "version"?}`:

- `device` (required, non-empty string; `400` otherwise): one id per app install.
- `ops`: `{"id", "op": "upsert" | "delete" | "event", "table", "row", "at"}`. Skip op ids you've seen before (retries).
  `upsert` stores `row` under `row.id` in `table`; `delete` removes it; `event` is a message for the bot
  (`onEvent(table, row, store, device)`), never stored.
- `cursor`: what you answered last time, or `0`/`null`. A number or a numeric string.
- `push`: a push relay URL for this phone (optional; see the TypeScript server).
- `version`: the space version the phone runs (optional).

Answer `{"done": [every op id sent], "pull": {"<table>": [rows]}, "cursor", "version", "notify"?: [{"title", "body"}]}`:

- Every stored row gets a new sequence number when written. `pull` has every row with a sequence number above the
  phone's `cursor` that wasn't written by this phone (rows the bot writes go to every phone). `cursor` is the newest
  sequence number.
- A `cursor` above the newest sequence number means the server lost its data: treat it as `0`.
- `version` is `space.json`'s `version`. If the phone sent a lower `version`, still take its ops, but answer
  `"pull": {}` and its own `cursor` unchanged: it updates the space first and syncs again.
- Order on each sync: note the phone as seen, take the ops (calling `onOp(op, store, device)` after each stored change and
  `onEvent` for events), call `tick(store)`, build the pull, add and clear this phone's queued notifications.
- `store.notify(title, body)` queues a notification for every phone that synced in the last 7 days (at most the 20
  newest per phone); it comes with that phone's next sync.

Keep the state in `server-data.json` in the same shape as the TypeScript server, so a space can move between servers
without losing data:

```json
{ "seq": 12, "seen": ["<op id>"], "devices": {"<device>": 1762776000000}, "push": {}, "notes": {"<device>": [{"title", "body"}]},
  "rows": {"<table>": {"<row id>": {"row": {...}, "seq": 12, "origin": "<device> | server"}}} }
```

## The echo bot

The `echo` space needs this bot, written in your language:

| Hook | Does |
|---|---|
| `onOp(op, store, device)` | for an `upsert` into `notes`: `store.put("replies", {"id": "re-" + row.id, "text": "echo: " + row.text, "device": device})` |
| `onEvent(event, data, store, device)` | `"ping"`: `store.put("pongs", {"id": data.id, "device": device})`; `"notify"`: `store.notify(data.title, data.body)` |
| `hook(body, store, headers)` | `store.put("inbox", {"id": body.id, "text": body.text})`, returns `{"ok": true, "echoed": body.text}` |

`fixtures/spaces/echo/bot.ts` is the TypeScript one.
