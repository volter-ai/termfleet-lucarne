// Acceptance proofs for the @termfleet/lucarne bridge — each asserts REAL behavior
// against a live in-process lucarne daemon, driven through the console's OWN
// @termfleet/core ProviderClient (so "it parses" means the console accepts it).
// Run: npm test  (needs Google Chrome — lucarne's native backend).
import { startBridge } from "../dist/index.js";
import { Lucarne } from "lucarne";
import { ProviderClient, providerRefFromUrl } from "@termfleet/core/provider-client.js";
import { io as ioClient } from "socket.io-client";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass: !!pass });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

const LUCARNE_PORT = 7900, BRIDGE_PORT = 7951, CONSOLE_PORT = 7952, TOKEN = "t";
process.env.LUCARNE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "tlh-"));

// a mock console that records the bridge's self-registration POST
let registered = null;
const mockConsole = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/api/registry/local-providers") {
    let body = ""; req.on("data", (d) => (body += d)); req.on("end", () => {
      try { registered = JSON.parse(body); } catch { /* */ }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, baseUrl: registered?.baseUrl }));
    });
  } else { res.writeHead(404); res.end(); }
});
await new Promise((r) => mockConsole.listen(CONSOLE_PORT, "127.0.0.1", r));

const luc = new Lucarne({ port: LUCARNE_PORT, token: TOKEN, record: false });
await luc.listen();
let bridge;
try {
  await luc.create({ backend: "native", profile: "win1" });
  bridge = await startBridge({
    lucarneUrl: `http://127.0.0.1:${LUCARNE_PORT}`, lucarneToken: TOKEN,
    consoleUrl: `http://127.0.0.1:${CONSOLE_PORT}`, port: BRIDGE_PORT, registerOnStart: true,
  });
  const bridgeUrl = `http://127.0.0.1:${BRIDGE_PORT}`;
  const client = new ProviderClient(providerRefFromUrl(bridgeUrl), { authToken: () => undefined });

  // 1. IDENTITY GATE — the console's health probe
  const health = await client.health();
  check("healthz: identity gate reports the lucarne provider", health.ok === true && health.provider === "lucarne");

  // 2. SNAPSHOT — must PARSE via @termfleet/core (else the provider shows offline)
  const snap = await client.snapshot();
  check("snapshot: parses via @termfleet/core (one iframe window per session)",
    Array.isArray(snap.windows) && snap.windows.length === 1 && snap.windows[0].windowKind === "iframe" && snap.windows[0].name === "win1 (native)");
  check("snapshot: window proxies the porthole through the console",
    snap.windows[0].iframe?.resolvedSrc?.includes("/providers/") && snap.windows[0].iframe?.resolvedSrc?.endsWith("/sessions/win1/view/"));

  // 3. CONTROL CHANNEL — socket.io emits provider:snapshot on connect (the
  //    chicken-and-egg the frontend needs to mark the provider "connected")
  const sock = ioClient(bridgeUrl, { path: "/control/socket.io", transports: ["websocket"] });
  const pushed = await new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), 4000);
    sock.on("provider:snapshot", (s) => { clearTimeout(t); resolve(s); });
  });
  check("control: socket.io emits provider:snapshot on connect", !!pushed && Array.isArray(pushed.windows) && pushed.windows.length === 1);

  // 4. PORTHOLE HTTP PROXY — bridge forwards the porthole page (token injected)
  const viewHtml = await (await fetch(`${bridgeUrl}/sessions/win1/view/`)).text();
  check("porthole(http): reverse-proxies the lucarne porthole page", viewHtml.includes("<canvas") && viewHtml.includes("WebSocket"));

  // 5. PORTHOLE WS PROXY — a real JPEG frame flows console→bridge→lucarne→Chrome
  const frameLen = await new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${BRIDGE_PORT}/sessions/win1/view/ws`);
    ws.binaryType = "arraybuffer";
    const t = setTimeout(() => { try { ws.close(); } catch {} resolve(0); }, 6000);
    ws.onmessage = (ev) => {
      if (typeof ev.data === "string") return;
      const b = new Uint8Array(ev.data);
      if (b.length > 1000 && b[0] === 0xff && b[1] === 0xd8) { clearTimeout(t); ws.close(); resolve(b.length); }
    };
    ws.onerror = () => { clearTimeout(t); resolve(0); };
  });
  check("porthole(ws): a real JPEG frame proxies through the bridge", frameLen > 1000, `${frameLen}B`);

  // 6. WINDOW:CLOSE — closing the window destroys the lucarne session
  const wid = snap.windows[0].id;
  const ack = await new Promise((resolve) => sock.emit("window:close", { id: wid }, (r) => resolve(r)));
  await sleep(400);
  check("control: window:close destroys the underlying lucarne session", ack?.ok === true && !luc.list().some((s) => s.id === "win1"));
  sock.close();

  // 7. SELF-REGISTRATION — bridge registered as a bare-pointer provider
  check("register: posts a bare-pointer registration to the console", registered?.baseUrl === bridgeUrl && registered?.label === "lucarne");
} finally {
  if (bridge) await bridge.close().catch(() => {});
  await luc.close().catch(() => {});
  await new Promise((r) => mockConsole.close(r));
}

const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} acceptance proofs passed`);
process.exit(failed ? 1 : 0);
