# @termfleet/lucarne

The **optional bridge** between [`lucarne`](https://www.npmjs.com/package/lucarne)
(a standalone browser-session engine) and a **termfleet** console.

termfleet does not depend on lucarne, and lucarne knows nothing of termfleet —
this small process is the *only* thing that speaks both. It presents a running
lucarne daemon to a termfleet console as a **bare-pointer provider** whose windows
are the session **portholes**. Browser sessions then appear on the canvas next to
your terminals, reachable from your phone through the console's existing tunnel.

```
termfleet console ──proxy──▶ @termfleet/lucarne ──proxy──▶ lucarne daemon
   (you, remote)              (the bridge)                  (browsers, local)
```

## Run

```sh
# 1. a lucarne daemon (browsers live here, on your machine)
npx lucarne serve

# 2. the bridge (registers with your console, reflects sessions as windows)
LUCARNE_URL=http://127.0.0.1:7800 \
TERMFLEET_CONSOLE_URL=http://127.0.0.1:7373 \
npx @termfleet/lucarne

# 3. create a browser session — it shows up as a window in the console
npx lucarne create -b native -p work
```

## What it serves

- `GET /healthz` — the termfleet identity gate (`{ ok, provider: "lucarne" }`)
- `GET /api/mirror/snapshot` — one iframe window per lucarne session
- `/sessions/:id/view*` — reverse-proxied to lucarne's porthole (the bridge injects
  the `LUCARNE_TOKEN`, so it never appears in the browser)

## Env

| var | default | purpose |
|---|---|---|
| `LUCARNE_URL` | `http://127.0.0.1:7800` | the lucarne daemon |
| `LUCARNE_TOKEN` | — | lucarne bearer token (injected when proxying) |
| `TERMFLEET_CONSOLE_URL` | `http://127.0.0.1:7373` | console to self-register with |
| `BRIDGE_HOST` / `BRIDGE_PORT` | `127.0.0.1` / `7950` | bind address |
| `BRIDGE_PUBLIC_URL` | `http://HOST:PORT` | the origin it registers as |

## Boundaries

This package depends on neither termfleet core nor lucarne at build time (it talks
to both over HTTP). It is **optional** — uninstall it and termfleet is terminals-only,
lucarne is standalone, and nothing breaks. Drive remains local (an agent hits
lucarne's CDP on the same host); only the *view* crosses the tunnel.

MIT © Aaron Volter
