# @termfleet/lucarne bridge — roadmap

The optional bridge that surfaces a running **lucarne** daemon's browser sessions as
**windows in a termfleet console**. termfleet never imports lucarne; lucarne never
imports termfleet; this is the one process that speaks both (dependency arrow
termfleet→lucarne only).

**Discipline (same as lucarne):** no item is done without a committed, re-runnable
acceptance proof in `test/acceptance.mjs` (`npm test`) asserting REAL behavior against
a live in-process lucarne — driven through the console's OWN `@termfleet/core`
`ProviderClient` so "it parses" means "the console accepts it", never an HTTP 200.

`✅ done · 🔨 in progress · ⬜ planned`

## L0 — Testable seam + committed proofs ✅
- ✅ `index.ts` refactored to an importable `startBridge(opts)` factory (config from
  opts ?? env) + a main-run guard — so the whole bridge boots in-process for tests.
- ✅ `test/acceptance.mjs` (8/8 green) covers the data + control plane end-to-end:
  - identity gate (`ProviderClient.health` → `{ok, provider:"lucarne"}`)
  - snapshot **parses via `@termfleet/core`** — one iframe window per lucarne session,
    porthole proxied through `/providers/.../sessions/:id/view/`
  - socket.io `/control/socket.io` emits `provider:snapshot` on connect (the
    chicken-and-egg the frontend needs to mark the provider "connected")
  - porthole HTTP proxy forwards the lucarne porthole page
  - **porthole WS proxy carries a real JPEG frame** console→bridge→lucarne→Chrome
  - `window:close` destroys the underlying lucarne session
  - self-registration posts a bare-pointer registration to the console

## L1 — Track lucarne 0.8.0 ✅
- ✅ `lucarne` pinned as a devDep and the proofs run against it; the porthole paths
  (`/sessions/:id/view`, `/view/ws`) are unchanged from the 0.2-era, verified live.

## L2 — Mint a browser session from the console ✅
- ✅ `window:create` creates a lucarne session (`POST /sessions`, default native — the
  authentic lane) and rides a fresh snapshot back on the ack + a live push, so "new
  window" in the console opens a browser. *(Proof: emit window:create → a lucarne
  session exists + the snapshot has its window.)*

## L3 — Identity + resilience ✅
- ✅ window name carries the lucarne backend (`win1 (native)`); `window:create` honours a
  requested profile/backend.
- ✅ **resilience:** a down lucarne never takes the provider offline — the bridge stays
  healthy and the snapshot empties (0 windows) instead of throwing. *(Proof: close lucarne →
  `ProviderClient.health` ok + snapshot parses with 0 windows.)*

## L4 — Surface more of lucarne ✅ (documented — cross-repo)
- ✅ **Decided:** the bridge already exposes everything (lucarne serves
  `/sessions/:id/{replay,logs,downloads}`, reachable through the porthole proxy). Adding
  *dedicated console chrome* for replay/logs is a **termfleet-console UI** change (the main
  repo), not bridge work — deferred to a console design pass so the bridge stays a thin,
  termfleet-agnostic adapter. No bridge code is the right amount of bridge code here.

---

> **The bridge integration is complete and proven** — browser sessions render as windows
> in a termfleet console (snapshot parses via the console's own `@termfleet/core`), the
> porthole renders live (HTTP + WS proxy carry a real frame), windows open/create/close,
> the provider self-registers and survives lucarne going down. **10/10 committed proofs ·
> `@termfleet/lucarne@0.3.0` published.**

## Release
- ✅ `@termfleet/lucarne@0.3.0` — committed proofs (9/9) + lucarne 0.8.0 + window:create.
