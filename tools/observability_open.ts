#!/usr/bin/env -S node --experimental-strip-types
/**
 * Bootstrap helper for the stark-observability server.
 *
 * Two modes (Phase 1 Task 3 + Phase 4 Task 1 contract):
 *
 *   Default (browser) mode — invoked as `tools/observability_open.ts` with no
 *   flag. Reads `/data/bootstrap_token` + `/data/prune_token` from the
 *   container via `docker exec stark-observability`, stores both in the
 *   macOS Keychain under the scoped service names
 *   (`stark-observability-bootstrap-token`,
 *   `stark-observability-prune-token`), calls
 *   `POST /api/auth/bootstrap` to obtain a one-time code, opens
 *   `http://127.0.0.1:7700/#b=<code>` in the OS default browser. The code
 *   lives in the URL FRAGMENT, not the query string — fragments are never
 *   transmitted in the HTTP request target so the still-valid 60-second
 *   code never appears in access logs or proxy captures. The helper then
 *   EXITS. The browser-side mount script (Phase 5 `ui/src/bootstrap.ts`)
 *   parses `location.hash`, strips it via `history.replaceState`, and
 *   calls `POST /api/auth/exchange` to receive the HttpOnly session
 *   cookie.
 *
 *   Headless mode — `--no-browser`. Same Keychain population + bootstrap
 *   call, then the helper itself calls `POST /api/auth/exchange` on
 *   loopback, receives the session cookie, and writes it to
 *   `~/.claude/code-review/observability/session.cookie` (mode 0600,
 *   Netscape format for curl). Used by Phase 1 step 2 of the LAN bootstrap
 *   sequence and by any scripted setup.
 *
 * The helper NEVER echoes a raw token to stdout in any code path.
 * `--print-token` does not exist.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

interface Args {
  noBrowser: boolean;
  apiBase: string;
  containerName: string;
  sessionCookiePath: string;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {
    noBrowser: false,
    apiBase: process.env.OBSERVABILITY_API_BASE ?? "http://127.0.0.1:7700",
    containerName: process.env.OBSERVABILITY_CONTAINER ?? "stark-observability",
    sessionCookiePath:
      process.env.OBSERVABILITY_SESSION_COOKIE ??
      path.join(
        os.homedir(),
        ".claude",
        "code-review",
        "observability",
        "session.cookie",
      ),
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--no-browser") out.noBrowser = true;
    else if (a === "--api-base") out.apiBase = argv[++i] ?? out.apiBase;
    else if (a === "--container") out.containerName = argv[++i] ?? out.containerName;
    else if (a === "--cookie-out") out.sessionCookiePath = argv[++i] ?? out.sessionCookiePath;
    else {
      process.stderr.write(`[observability_open] unknown arg: ${a}\n`);
      process.exit(2);
    }
  }
  return out;
}

function dockerCat(container: string, p: string): string {
  const r = spawnSync(
    "docker",
    ["exec", container, "cat", p],
    { encoding: "utf-8" },
  );
  if (r.status !== 0) {
    process.stderr.write(
      `[observability_open] docker exec ${container} cat ${p} failed: ${r.stderr || r.status}\n`,
    );
    process.exit(1);
  }
  return (r.stdout ?? "").trim();
}

function keychainSet(service: string, account: string, value: string): void {
  spawnSync(
    "security",
    ["delete-generic-password", "-s", service, "-a", account],
    { stdio: "ignore" },
  );
  const r = spawnSync(
    "security",
    ["add-generic-password", "-s", service, "-a", account, "-w", value, "-U"],
    { stdio: ["ignore", "ignore", "pipe"], encoding: "utf-8" },
  );
  if (r.status !== 0) {
    process.stderr.write(
      `[observability_open] keychain write for ${service} failed: ${r.stderr}\n`,
    );
    process.exit(1);
  }
}

function writeSessionCookie(cookiePath: string, sessionId: string, apiHost: string): void {
  const lines = [
    "# Netscape HTTP Cookie File",
    "# https://curl.se/docs/http-cookies.html",
    "# Written by tools/observability_open.ts",
    "",
    `#HttpOnly_${apiHost}\tFALSE\t/\tFALSE\t0\tobs_session\t${sessionId}`,
    "",
  ];
  const dir = path.dirname(cookiePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = cookiePath + ".tmp";
  fs.writeFileSync(tmp, lines.join("\n"), { mode: 0o600 });
  fs.renameSync(tmp, cookiePath);
}

async function postJson(
  url: string,
  body: unknown,
): Promise<{ status: number; body: unknown; cookieHeader: string | null }> {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  let parsed: unknown = null;
  const text = await r.text();
  if (text.length > 0) {
    try { parsed = JSON.parse(text); } catch { parsed = text; }
  }
  return {
    status: r.status,
    body: parsed,
    cookieHeader: r.headers.get("set-cookie"),
  };
}

function extractSessionId(setCookie: string): string | null {
  const m = /(?:^|;\s*|,\s*)obs_session=([^;]+)/.exec(setCookie);
  return m ? m[1]! : null;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);

  const bootstrapTok = dockerCat(args.containerName, "/data/bootstrap_token");
  const pruneTok = dockerCat(args.containerName, "/data/prune_token");
  const account = os.userInfo().username;
  keychainSet("stark-observability-bootstrap-token", account, bootstrapTok);
  keychainSet("stark-observability-prune-token", account, pruneTok);

  const bootstrapRes = await postJson(
    `${args.apiBase}/api/auth/bootstrap`,
    { token: bootstrapTok },
  );
  if (bootstrapRes.status !== 200 || typeof (bootstrapRes.body as { code?: unknown })?.code !== "string") {
    process.stderr.write(
      `[observability_open] bootstrap failed (status=${bootstrapRes.status}): ${JSON.stringify(bootstrapRes.body)}\n`,
    );
    process.exit(1);
  }
  const code = (bootstrapRes.body as { code: string }).code;

  if (!args.noBrowser) {
    const url = `${args.apiBase}/#b=${code}`;
    spawnSync("open", [url], { stdio: "ignore" });
    process.stdout.write(`browser opened — complete login at ${args.apiBase}\n`);
    return;
  }

  const exchangeRes = await postJson(
    `${args.apiBase}/api/auth/exchange`,
    { code },
  );
  if (exchangeRes.status !== 204) {
    process.stderr.write(
      `[observability_open] exchange failed (status=${exchangeRes.status}): ${JSON.stringify(exchangeRes.body)}\n`,
    );
    process.exit(1);
  }
  const setCookie = exchangeRes.cookieHeader ?? "";
  const sessionId = extractSessionId(setCookie);
  if (sessionId === null) {
    process.stderr.write(
      `[observability_open] exchange returned no obs_session cookie: ${setCookie}\n`,
    );
    process.exit(1);
  }
  const apiHost = new URL(args.apiBase).hostname;
  writeSessionCookie(args.sessionCookiePath, sessionId, apiHost);
  process.stdout.write(`session established — cookie at ${args.sessionCookiePath}\n`);
}

main().catch((err) => {
  process.stderr.write(`[observability_open] fatal: ${(err as Error).message}\n`);
  process.exit(1);
});
