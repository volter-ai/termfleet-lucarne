#!/usr/bin/env node
// @termfleet/lucarne — the optional bridge. Presents a running lucarne daemon to
// a termfleet console as a bare-pointer provider whose windows are the session
// portholes. termfleet never imports lucarne; lucarne never imports termfleet;
// THIS is the only process that speaks both.
//
//   • GET /healthz                 → identity gate ({ ok, provider })
//   • GET /api/mirror/snapshot     → one iframe window per lucarne session
//   • /sessions/:id/view*          → reverse-proxied to lucarne's porthole
//                                    (so the console can proxy it over the tunnel)
import http from "node:http";
import net from "node:net";
import { Server as IOServer } from "socket.io";

const LUCARNE_URL = process.env.LUCARNE_URL ?? "http://127.0.0.1:7800";
const LUCARNE_TOKEN = process.env.LUCARNE_TOKEN;
const CONSOLE_URL = process.env.TERMFLEET_CONSOLE_URL ?? "http://127.0.0.1:7373";
const HOST = process.env.BRIDGE_HOST ?? "127.0.0.1";
const PORT = Number(process.env.BRIDGE_PORT ?? 7950);
const PUBLIC_URL = process.env.BRIDGE_PUBLIC_URL ?? `http://${HOST}:${PORT}`;
const PROVIDER_KEY = encodeURIComponent(PUBLIC_URL);

interface LucarneSession { id: string; backend: string; viewUrl: string }

const windowIds = new Map<string, number>();
let nextWindowId = 1;
let revision = 0;

function sessionIdForWindow(wid: number): string | undefined {
  for (const [sid, id] of windowIds) if (id === wid) return sid;
  return undefined;
}

async function lucarne(path: string): Promise<unknown> {
  const headers: Record<string, string> = {};
  if (LUCARNE_TOKEN) headers["authorization"] = `Bearer ${LUCARNE_TOKEN}`;
  const res = await fetch(LUCARNE_URL + path, { headers });
  return res.json();
}

function makeWindow(sessionId: string, name: string): Record<string, unknown> {
  let wid = windowIds.get(sessionId);
  if (wid === undefined) { wid = nextWindowId++; windowIds.set(sessionId, wid); }
  const i = wid - 1, col = i % 2, row = Math.floor(i / 2);
  const W = 960, H = 680, gx = 40, gy = 40;
  const left = 40 + col * (W + gx), top = 40 + row * (H + gy);
  const tbH = 30;
  return {
    id: wid,
    name,
    windowKind: "iframe",
    iframe: {
      src: `/sessions/${sessionId}/view/`,
      // load through the console proxy → this bridge → lucarne
      resolvedSrc: `/providers/${PROVIDER_KEY}/sessions/${sessionId}/view/`,
    },
    bounds: { left, top, right: left + W, bottom: top + H, width: W, height: H },
    chrome: {
      id: wid,
      title: name,
      titlebar: { left, top, width: W, height: tbH },
      closeButton: { left: left + W - 30, top: top + 8, width: 16, height: 16 },
      minimizeButton: { left: left + W - 54, top: top + 8, width: 16, height: 16 },
      fullscreenButton: { left: left + W - 78, top: top + 8, width: 16, height: 16 },
      terminalViewport: { left, top: top + tbH, width: W, height: H - tbH },
      textArea: { left, top: top + tbH, width: W, height: H - tbH },
      scrollbar: { left: left + W - 10, top: top + tbH, width: 10, height: H - tbH },
    },
    terminalArea: { left, top: top + tbH, width: W, height: H - tbH },
    terminalSize: { columns: 120, rows: 32 },
  };
}

async function snapshot(): Promise<Record<string, unknown>> {
  const sessions = (await lucarne("/sessions").catch(() => [])) as LucarneSession[];
  const windows = sessions.map((s) => makeWindow(s.id, `${s.id} (${s.backend})`));
  return {
    epoch: "lucarne-bridge",
    instanceId: "lucarne-bridge",
    // termfleet's snapshot `provider` is a CLOSED enum (iterm|virtual-tmux|wezterm)
    // validated by @termfleet/core — an unknown value is rejected ("unsupported
    // provider") and the provider shows offline. There's no "browser"/"external"
    // kind yet, so we present a valid one; the board still shows the "lucarne"
    // label (from registration) and renders our iframe windows regardless of kind.
    provider: "virtual-tmux",
    revision: ++revision,
    observedAt: new Date().toISOString(),
    displayBounds: { left: 0, top: 0, right: 1920, bottom: 1080, width: 1920, height: 1080 },
    windows,
    // @termfleet/core parseProviderSnapshot requires lifecycle with BOTH arrays
    lifecycle: { panes: [], sessions: [] },
  };
}

// reverse-proxy /sessions/:id/view* → lucarne (inject the lucarne token here)
function proxyView(req: http.IncomingMessage, res: http.ServerResponse, rest: string): void {
  const target = new URL(LUCARNE_URL);
  const qs = LUCARNE_TOKEN ? `?token=${encodeURIComponent(LUCARNE_TOKEN)}` : "";
  const preq = http.request({
    hostname: target.hostname,
    port: target.port,
    method: req.method,
    path: `/sessions/${rest}${qs}`,
    headers: { ...req.headers, host: target.host },
  }, (pres) => {
    res.writeHead(pres.statusCode ?? 502, pres.headers);
    pres.pipe(res);
  });
  preq.on("error", () => { try { res.writeHead(502); res.end("bridge: lucarne unreachable"); } catch { /* */ } });
  req.pipe(preq);
}

const server = http.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url ?? "/", "http://x").pathname;
    if (pathname === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, provider: "lucarne", instanceId: "lucarne-bridge", build: { version: "0.1.0" } }));
      return;
    }
    if (pathname === "/api/mirror/snapshot") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(await snapshot()));
      return;
    }
    const view = pathname.match(/^\/sessions\/(.*)$/);
    if (view) { proxyView(req, res, view[1]!); return; }
    res.writeHead(404); res.end();
  } catch (e) {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: String((e as Error).message ?? e) }));
  }
});

// termfleet provider control channel. The frontend marks a provider "connected"
// only once its socket.io connection (path /control/socket.io) is up AND it has
// received a `provider:snapshot` with displayBounds — without this the provider
// shows offline / 0 windows. (Protocol owned by termfleet; see @termfleet/core.)
const io = new IOServer(server, {
  path: "/control/socket.io",
  transports: ["websocket"],
  cors: { origin: true },           // access control is the console proxy's job
});
io.on("connection", (socket) => {
  void snapshot().then((s) => socket.emit("provider:snapshot", s)).catch(() => {});
  // closing a window destroys the underlying lucarne session
  socket.on("window:close", async (p: { id?: number }, ack?: (r: unknown) => void) => {
    const sid = typeof p?.id === "number" ? sessionIdForWindow(p.id) : undefined;
    if (sid) {
      const headers: Record<string, string> = {};
      if (LUCARNE_TOKEN) headers["authorization"] = `Bearer ${LUCARNE_TOKEN}`;
      await fetch(`${LUCARNE_URL}/sessions/${sid}`, { method: "DELETE", headers }).catch(() => {});
    }
    ack?.({ ok: true });
  });
  // read-only for the rest: acknowledge so the UI never hangs on a command
  for (const ev of ["window:create", "window:move", "display:resize", "terminal:input",
    "agent:create", "agent-session:input", "agent-session:close",
    "agent-session:subscribe", "agent-session:unsubscribe", "terminal:effect"]) {
    socket.on(ev, (_p: unknown, ack?: (r: unknown) => void) => ack?.({ ok: true }));
  }
});
// push live snapshots so new/closed sessions appear on the board
setInterval(() => { void snapshot().then((s) => io.emit("provider:snapshot", s)).catch(() => {}); }, 3000);

// Proxy the porthole WebSocket (/sessions/:id/view/ws) through to lucarne, raw.
// socket.io owns /control/socket.io; we only act on the porthole ws path.
server.on("upgrade", (req, socket, head) => {
  const pathname = new URL(req.url ?? "/", "http://x").pathname;
  if (!/^\/sessions\/.+\/view\/ws$/.test(pathname)) return; // leave /control/socket.io to socket.io
  const target = new URL(LUCARNE_URL);
  const qs = LUCARNE_TOKEN ? `?token=${encodeURIComponent(LUCARNE_TOKEN)}` : "";
  const upstream = net.connect(Number(target.port || 80), target.hostname, () => {
    const lines = [`GET ${pathname}${qs} HTTP/1.1`];
    for (const [k, v] of Object.entries(req.headers)) {
      if (k.toLowerCase() === "host") continue;
      lines.push(`${k}: ${Array.isArray(v) ? v.join(", ") : v}`);
    }
    lines.push(`host: ${target.host}`, "", "");
    upstream.write(lines.join("\r\n"));
    if (head?.length) upstream.write(head);
    socket.pipe(upstream);
    upstream.pipe(socket);
  });
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
});

async function registerWithConsole(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    try {
      const r = await fetch(`${CONSOLE_URL}/api/registry/local-providers`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ baseUrl: PUBLIC_URL, label: "lucarne" }),
      });
      if (r.ok) { process.stdout.write(`registered with console ${CONSOLE_URL}\n`); return; }
      process.stderr.write(`register attempt ${i + 1}: HTTP ${r.status} ${await r.text()}\n`);
    } catch (e) {
      process.stderr.write(`register attempt ${i + 1}: ${(e as Error).message}\n`);
    }
    await new Promise((res) => setTimeout(res, 1000));
  }
}

server.listen(PORT, HOST, () => {
  process.stdout.write(`@termfleet/lucarne bridge on ${PUBLIC_URL} → lucarne ${LUCARNE_URL}\n`);
  void registerWithConsole();
});
