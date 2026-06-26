#!/usr/bin/env node
// @termfleet/lucarne — the optional bridge. Presents a running lucarne daemon to
// a termfleet console as a bare-pointer provider whose windows are the session
// portholes. termfleet never imports lucarne; lucarne never imports termfleet;
// THIS is the only process that speaks both.
//
//   • GET /healthz                 → identity gate ({ ok, provider })
//   • GET /api/mirror/snapshot     → one iframe window per lucarne session
//   • /control/socket.io           → termfleet provider control channel
//   • /sessions/:id/view*          → reverse-proxied to lucarne's porthole
//                                    (HTTP + the porthole WebSocket)
import http from "node:http";
import net from "node:net";
import { Server as IOServer } from "socket.io";

export interface BridgeOptions {
  /** lucarne daemon base URL (default $LUCARNE_URL or http://127.0.0.1:7800). */
  lucarneUrl?: string;
  /** lucarne bearer token (default $LUCARNE_TOKEN). */
  lucarneToken?: string;
  /** console base URL to self-register with (default $TERMFLEET_CONSOLE_URL or :7373). */
  consoleUrl?: string;
  host?: string;
  port?: number;
  /** public URL the console proxies to (default http://host:port). */
  publicUrl?: string;
  /** POST to the console's local-providers endpoint on start. Default true. */
  registerOnStart?: boolean;
  /** live-snapshot push interval (ms). Default 3000. */
  snapshotIntervalMs?: number;
}

export interface Bridge {
  server: http.Server;
  io: IOServer;
  port: number;
  publicUrl: string;
  snapshot(): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}

interface LucarneSession { id: string; backend: string; viewUrl: string }

export async function startBridge(opts: BridgeOptions = {}): Promise<Bridge> {
  const lucarneUrl = opts.lucarneUrl ?? process.env.LUCARNE_URL ?? "http://127.0.0.1:7800";
  const lucarneToken = opts.lucarneToken ?? process.env.LUCARNE_TOKEN;
  const consoleUrl = opts.consoleUrl ?? process.env.TERMFLEET_CONSOLE_URL ?? "http://127.0.0.1:7373";
  const host = opts.host ?? process.env.BRIDGE_HOST ?? "127.0.0.1";
  const port = opts.port ?? Number(process.env.BRIDGE_PORT ?? 7950);
  const publicUrl = opts.publicUrl ?? process.env.BRIDGE_PUBLIC_URL ?? `http://${host}:${port}`;
  const providerKey = encodeURIComponent(publicUrl);
  const snapshotIntervalMs = opts.snapshotIntervalMs ?? 3000;

  const windowIds = new Map<string, number>();
  let nextWindowId = 1;
  let revision = 0;

  const sessionIdForWindow = (wid: number): string | undefined => {
    for (const [sid, id] of windowIds) if (id === wid) return sid;
    return undefined;
  };

  const lucarne = async (p: string): Promise<unknown> => {
    const headers: Record<string, string> = {};
    if (lucarneToken) headers["authorization"] = `Bearer ${lucarneToken}`;
    return (await fetch(lucarneUrl + p, { headers })).json();
  };

  const makeWindow = (sessionId: string, name: string): Record<string, unknown> => {
    let wid = windowIds.get(sessionId);
    if (wid === undefined) { wid = nextWindowId++; windowIds.set(sessionId, wid); }
    const i = wid - 1, col = i % 2, row = Math.floor(i / 2);
    const W = 960, H = 680, gx = 40, gy = 40;
    const left = 40 + col * (W + gx), top = 40 + row * (H + gy);
    const tbH = 30;
    return {
      id: wid, name, windowKind: "iframe",
      iframe: {
        src: `/sessions/${sessionId}/view/`,
        resolvedSrc: `/providers/${providerKey}/sessions/${sessionId}/view/`,
      },
      bounds: { left, top, right: left + W, bottom: top + H, width: W, height: H },
      chrome: {
        id: wid, title: name,
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
  };

  const snapshot = async (): Promise<Record<string, unknown>> => {
    const sessions = (await lucarne("/sessions").catch(() => [])) as LucarneSession[];
    const windows = (Array.isArray(sessions) ? sessions : []).map((s) => makeWindow(s.id, `${s.id} (${s.backend})`));
    return {
      epoch: "lucarne-bridge",
      instanceId: "lucarne-bridge",
      // termfleet's snapshot `provider` is a CLOSED enum (iterm|virtual-tmux|wezterm)
      // validated by @termfleet/core — an unknown value is rejected ("unsupported
      // provider") and the provider shows offline. There's no "browser" kind yet, so
      // we present a valid one; the board still shows the "lucarne" label and our iframes.
      provider: "virtual-tmux",
      revision: ++revision,
      observedAt: new Date().toISOString(),
      displayBounds: { left: 0, top: 0, right: 1920, bottom: 1080, width: 1920, height: 1080 },
      windows,
      lifecycle: { panes: [], sessions: [] },
    };
  };

  // reverse-proxy /sessions/:id/view* → lucarne (inject the lucarne token here)
  const proxyView = (req: http.IncomingMessage, res: http.ServerResponse, rest: string): void => {
    const target = new URL(lucarneUrl);
    const qs = lucarneToken ? `?token=${encodeURIComponent(lucarneToken)}` : "";
    const preq = http.request({
      hostname: target.hostname, port: target.port, method: req.method,
      path: `/sessions/${rest}${qs}`, headers: { ...req.headers, host: target.host },
    }, (pres) => { res.writeHead(pres.statusCode ?? 502, pres.headers); pres.pipe(res); });
    preq.on("error", () => { try { res.writeHead(502); res.end("bridge: lucarne unreachable"); } catch { /* */ } });
    req.pipe(preq);
  };

  const server = http.createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url ?? "/", "http://x").pathname;
      if (pathname === "/healthz") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, provider: "lucarne", instanceId: "lucarne-bridge", build: { version: "0.3.0" } }));
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

  // termfleet provider control channel: the frontend marks a provider "connected"
  // only once /control/socket.io is up AND it has a `provider:snapshot` with
  // displayBounds — without this the provider shows offline / 0 windows.
  const io = new IOServer(server, { path: "/control/socket.io", transports: ["websocket"], cors: { origin: true } });
  io.on("connection", (socket) => {
    void snapshot().then((s) => socket.emit("provider:snapshot", s)).catch(() => {});
    socket.on("window:close", async (p: { id?: number }, ack?: (r: unknown) => void) => {
      const sid = typeof p?.id === "number" ? sessionIdForWindow(p.id) : undefined;
      if (sid) {
        const headers: Record<string, string> = {};
        if (lucarneToken) headers["authorization"] = `Bearer ${lucarneToken}`;
        await fetch(`${lucarneUrl}/sessions/${sid}`, { method: "DELETE", headers }).catch(() => {});
      }
      ack?.({ ok: true });
    });
    // "new window" mints a real lucarne browser session (default native — the
    // authentic lane); the fresh snapshot rides the ack + a live push.
    socket.on("window:create", async (p: { profile?: string; backend?: string }, ack?: (r: unknown) => void) => {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (lucarneToken) headers["authorization"] = `Bearer ${lucarneToken}`;
      const body: Record<string, string> = { backend: p?.backend ?? "native" };
      if (p?.profile) body.profile = p.profile;
      await fetch(`${lucarneUrl}/sessions`, { method: "POST", headers, body: JSON.stringify(body) }).catch(() => {});
      const s = await snapshot();
      io.emit("provider:snapshot", s);
      ack?.({ ok: true, snapshot: s });
    });
    for (const ev of ["window:move", "display:resize", "terminal:input",
      "agent:create", "agent-session:input", "agent-session:close",
      "agent-session:subscribe", "agent-session:unsubscribe", "terminal:effect"]) {
      socket.on(ev, (_p: unknown, ack?: (r: unknown) => void) => ack?.({ ok: true }));
    }
  });
  const pushTimer = setInterval(() => { void snapshot().then((s) => io.emit("provider:snapshot", s)).catch(() => {}); }, snapshotIntervalMs);
  pushTimer.unref?.();

  // Proxy the porthole WebSocket (/sessions/:id/view/ws) through to lucarne, raw.
  server.on("upgrade", (req, socket, head) => {
    const pathname = new URL(req.url ?? "/", "http://x").pathname;
    if (!/^\/sessions\/.+\/view\/ws$/.test(pathname)) return; // leave /control/socket.io to socket.io
    const target = new URL(lucarneUrl);
    const qs = lucarneToken ? `?token=${encodeURIComponent(lucarneToken)}` : "";
    const upstream = net.connect(Number(target.port || 80), target.hostname, () => {
      const lines = [`GET ${pathname}${qs} HTTP/1.1`];
      for (const [k, v] of Object.entries(req.headers)) {
        if (k.toLowerCase() === "host") continue;
        lines.push(`${k}: ${Array.isArray(v) ? v.join(", ") : v}`);
      }
      lines.push(`host: ${target.host}`, "", "");
      upstream.write(lines.join("\r\n"));
      if (head?.length) upstream.write(head);
      socket.pipe(upstream); upstream.pipe(socket);
    });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
  });

  const registerWithConsole = async (): Promise<void> => {
    for (let i = 0; i < 5; i++) {
      try {
        const r = await fetch(`${consoleUrl}/api/registry/local-providers`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ baseUrl: publicUrl, label: "lucarne" }),
        });
        if (r.ok) { process.stdout.write(`registered with console ${consoleUrl}\n`); return; }
        process.stderr.write(`register attempt ${i + 1}: HTTP ${r.status} ${await r.text()}\n`);
      } catch (e) { process.stderr.write(`register attempt ${i + 1}: ${(e as Error).message}\n`); }
      await new Promise((res) => setTimeout(res, 1000));
    }
  };

  await new Promise<void>((resolve) => server.listen(port, host, () => resolve()));
  if (opts.registerOnStart ?? true) void registerWithConsole();

  return {
    server, io, port, publicUrl, snapshot,
    async close(): Promise<void> {
      clearInterval(pushTimer);
      await new Promise<void>((resolve) => io.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

// Run as the `@termfleet/lucarne` bin.
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  void startBridge().then((b) => {
    process.stdout.write(`@termfleet/lucarne bridge on ${b.publicUrl}\n`);
  });
}
