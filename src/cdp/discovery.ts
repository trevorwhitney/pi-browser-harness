import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { connect as netConnect } from "node:net";
import { request as httpRequest } from "node:http";
import { type Result, err, ok } from "../util/result";
import { type CdpError, cdpError } from "./errors";

const PORT_PROBE_DEADLINE_MS = 30_000;
const PORT_PROBE_INTERVAL_MS = 1_000;

const profileDirs = (): ReadonlyArray<string> => {
  const home = homedir();
  return [
    // macOS
    join(home, "Library/Application Support/Google/Chrome"),
    join(home, "Library/Application Support/Google/Chrome Beta"),
    join(home, "Library/Application Support/Google/Chrome Dev"),
    join(home, "Library/Application Support/Google/Chrome Canary"),
    join(home, "Library/Application Support/Chromium"),
    join(home, "Library/Application Support/BraveSoftware/Brave-Browser"),
    join(home, "Library/Application Support/BraveSoftware/Brave-Browser-Beta"),
    join(home, "Library/Application Support/BraveSoftware/Brave-Browser-Nightly"),
    join(home, "Library/Application Support/BraveSoftware/Brave-Browser-Dev"),
    join(home, "Library/Application Support/Microsoft Edge"),
    join(home, "Library/Application Support/Microsoft Edge Beta"),
    join(home, "Library/Application Support/Microsoft Edge Dev"),
    join(home, "Library/Application Support/Microsoft Edge Canary"),
    // Linux
    join(home, ".config/google-chrome"),
    join(home, ".config/google-chrome-beta"),
    join(home, ".config/google-chrome-unstable"),
    join(home, ".config/chromium"),
    join(home, ".config/chromium-browser"),
    join(home, ".config/BraveSoftware/Brave-Browser"),
    join(home, ".config/BraveSoftware/Brave-Browser-Beta"),
    join(home, ".config/BraveSoftware/Brave-Browser-Nightly"),
    join(home, ".config/microsoft-edge"),
    join(home, ".config/microsoft-edge-beta"),
    join(home, ".config/microsoft-edge-dev"),
    join(home, ".var/app/org.chromium.Chromium/config/chromium"),
    join(home, ".var/app/com.google.Chrome/config/google-chrome"),
    join(home, ".var/app/com.brave.Browser/config/BraveSoftware/Brave-Browser"),
    join(home, ".var/app/com.microsoft.Edge/config/microsoft-edge"),
    // Windows
    join(home, "AppData/Local/Google/Chrome/User Data"),
    join(home, "AppData/Local/Chromium/User Data"),
    join(home, "AppData/Local/BraveSoftware/Brave-Browser/User Data"),
    join(home, "AppData/Local/BraveSoftware/Brave-Browser-Beta/User Data"),
    join(home, "AppData/Local/Microsoft/Edge/User Data"),
    join(home, "AppData/Local/Microsoft/Edge Beta/User Data"),
    join(home, "AppData/Local/Microsoft/Edge Dev/User Data"),
    join(home, "AppData/Local/Microsoft/Edge SxS/User Data"),
  ];
};

const probePort = (port: number): Promise<Result<void, CdpError>> =>
  new Promise((resolve) => {
    const sock = netConnect({ host: "127.0.0.1", port });
    let settled = false;
    const finish = (r: Result<void, CdpError>): void => {
      if (settled) return;
      settled = true;
      sock.setTimeout(0);
      sock.destroy();
      resolve(r);
    };
    sock.setTimeout(1000, () => finish(err(cdpError("discovery_failed", "probe timeout"))));
    sock.once("error", (e) => finish(err(cdpError("discovery_failed", e.message))));
    sock.once("connect", () => finish(ok(undefined)));
  });

const waitForPort = async (port: number): Promise<Result<void, CdpError>> => {
  const end = Date.now() + PORT_PROBE_DEADLINE_MS;
  let lastMessage = "unknown";
  while (Date.now() < end) {
    const probe = await probePort(port);
    if (probe.success) return probe;
    lastMessage = probe.error.message;
    await new Promise((r) => setTimeout(r, PORT_PROBE_INTERVAL_MS));
  }
  return err(cdpError(
    "discovery_failed",
    `Chrome's remote-debugging page is open, but DevTools is not live yet on 127.0.0.1:${port} — if Chrome opened a profile picker, choose your normal profile first, then tick the checkbox and click Allow if shown (last error: ${lastMessage})`,
  ));
};

// Quickly check if a port accepts a TCP connection. Used to skip stale
// DevToolsActivePort files left behind by browsers that have since quit.
const quickProbe = (port: number, timeoutMs = 500): Promise<boolean> =>
  new Promise((resolve) => {
    const sock = netConnect({ host: "127.0.0.1", port });
    let settled = false;
    const finish = (v: boolean): void => {
      if (settled) return;
      settled = true;
      sock.setTimeout(0);
      sock.destroy();
      resolve(v);
    };
    sock.setTimeout(timeoutMs, () => finish(false));
    sock.once("error", () => finish(false));
    sock.once("connect", () => finish(true));
  });

// Ask the live browser for its canonical webSocketDebuggerUrl via
// http://127.0.0.1:<port>/json/version. This is authoritative — it avoids
// trusting paths from stale DevToolsActivePort files that may belong to a
// different browser that has since exited (e.g. Chrome's stale port file
// pointing at port 9222 while Brave actually owns the port).
const queryLiveWsUrl = async (port: number, timeoutMs = 1500): Promise<string | null> => {
  return await new Promise<string | null>((resolve) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, path: "/json/version", method: "GET", timeout: timeoutMs },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          resolve(null);
          return;
        }
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          try {
            const body = Buffer.concat(chunks).toString("utf8");
            const json = JSON.parse(body) as Record<string, unknown>;
            const ws = json["webSocketDebuggerUrl"];
            resolve(typeof ws === "string" ? ws : null);
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.on("error", () => resolve(null));
    req.end();
  });
};

export const discoverWsUrl = async (): Promise<Result<string, CdpError>> => {
  const dirs = profileDirs();
  type Candidate = { readonly base: string; readonly port: number; readonly path: string; readonly mtimeMs: number };
  const candidates: Candidate[] = [];
  for (const base of dirs) {
    const portFile = join(base, "DevToolsActivePort");
    let raw: string;
    let mtimeMs = 0;
    try {
      raw = await readFile(portFile, "utf8");
      try {
        const st = await stat(portFile);
        mtimeMs = st.mtimeMs;
      } catch {
        // mtime is a tiebreaker; ignore stat failures
      }
    } catch (e) {
      // Node fs errors carry .code; see ErrnoException
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === undefined) continue;
      return err(cdpError("discovery_failed", `failed to read ${portFile}: ${e instanceof Error ? e.message : String(e)}`));
    }
    const lines = raw.trim().split("\n");
    if (lines.length < 2) continue;
    const port = lines[0]?.trim();
    const path = lines[1]?.trim();
    if (!port || !path) continue;
    candidates.push({ base, port: Number(port), path, mtimeMs });
  }

  if (candidates.length === 0) {
    return err(cdpError(
      "discovery_failed",
      `DevToolsActivePort not found in ${dirs.join(", ")} — open chrome://inspect/#remote-debugging (or brave://inspect, edge://inspect) in your browser, tick the checkbox, click Allow, then retry. Or set BU_CDP_WS to a remote browser endpoint.`,
    ));
  }

  // Disambiguate candidates sharing a port (e.g. one browser running and
  // another's port file left behind on the default 9222): prefer the
  // most-recently-written file — that's the currently-running browser.
  const byPort = new Map<number, Candidate>();
  for (const c of candidates) {
    const prev = byPort.get(c.port);
    if (!prev || c.mtimeMs > prev.mtimeMs) byPort.set(c.port, c);
  }
  const uniqueCandidates = Array.from(byPort.values());

  // Find which unique-port candidates are currently live. This skips stale
  // DevToolsActivePort files left behind by browsers that have quit.
  const live: Candidate[] = [];
  for (const c of uniqueCandidates) {
    if (await quickProbe(c.port)) live.push(c);
  }
  const ordered = live.length > 0 ? live : uniqueCandidates;

  // For each candidate, prefer asking the live browser for its canonical WS URL
  // via /json/version. Some browsers (notably Chrome/Brave when remote debugging
  // is enabled only via chrome://inspect rather than --remote-debugging-port)
  // disable the HTTP discovery endpoints, so we fall back to the WS path written
  // to DevToolsActivePort.
  let lastErr: Result<string, CdpError> | null = null;
  for (const c of ordered) {
    const ready = await waitForPort(c.port);
    if (!ready.success) {
      lastErr = err(ready.error);
      continue;
    }
    const liveUrl = await queryLiveWsUrl(c.port);
    if (liveUrl) return ok(liveUrl);
    return ok(`ws://127.0.0.1:${c.port}${c.path}`);
  }
  return lastErr ?? err(cdpError("discovery_failed", "no live DevTools endpoint among candidates"));
};
