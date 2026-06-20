/**
 * GitHub App authentication — sole implementation (the parallel Python
 * module `scripts/github_app.py` was deleted on 2026-05-19).
 *
 * Mints installation access tokens from the GitHub App private key stored
 * in macOS Keychain (with STARK_* env-var fallback for CI and final
 * GH_TOKEN fallback), caches them under `~/.cache/github-app-tokens/`,
 * and provides thin REST + GraphQL helpers for the operations the SKILLs
 * use (`token`, `pr review`, `pr comment`, plus the standard CRUD set).
 *
 * The on-disk JSON cache shape and keychain entries are unchanged from
 * what the Python module wrote, so any tokens minted before the deletion
 * remain valid.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import childProcess from "node:child_process";

// ---------------------------------------------------------------------------
// App registry.
// ---------------------------------------------------------------------------

export interface AppConfig {
  appId: string;
  installationId: string;
  installations: Record<string, string>;
  keychainService: string;
}

// Repointed 2026-06-19 from the aryeh-evinced-owned apps to NEW least-privilege
// apps owned by aryeh-stark (slugs stark-{claude,codex,gemini}-21s), installed on
// both GetEvinced and 21-Stark-AI. Old app ids/installs kept in
// github_app_lib.ts.bak-pre-21s for rollback.
const STARK_CLAUDE: AppConfig = {
  appId: "4094779",
  installationId: "141330785",
  installations: { GetEvinced: "141330785", "21-Stark-AI": "141330560" },
  keychainService: "STARK_CLAUDE_PRIVATE_KEY_21S",
};

// Declaring AppRegistry explicitly (instead of inferring via `satisfies`)
// preserves both the literal union for `AppName` AND the widened
// `installations: Record<string, string>` shape for each entry's value —
// callers can pass arbitrary owner strings into `cfg.installations[owner]`
// without per-entry widening assertions.
interface AppRegistry {
  "stark-claude": AppConfig;
  "stark-codex": AppConfig;
  "stark-gemini": AppConfig;
  default: AppConfig;
}

export const APPS: AppRegistry = {
  "stark-claude": STARK_CLAUDE,
  "stark-codex": {
    appId: "4094776",
    installationId: "141330738",
    installations: { GetEvinced: "141330738", "21-Stark-AI": "141330526" },
    keychainService: "STARK_CODEX_PRIVATE_KEY_21S",
  },
  "stark-gemini": {
    appId: "4094781",
    installationId: "141330831",
    installations: { GetEvinced: "141330831", "21-Stark-AI": "141330618" },
    keychainService: "STARK_GEMINI_PRIVATE_KEY_21S",
  },
  // `default` is a legacy alias for stark-claude; both point at the same
  // config object so a runtime patch on one shows up on the other.
  default: STARK_CLAUDE,
};

export type AppName = keyof AppRegistry;
export const APP_NAMES: readonly AppName[] = Object.keys(APPS) as AppName[];

export const DEFAULT_APP: AppName = "stark-codex";
export const API = "https://api.github.com";

export class KeychainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KeychainError";
  }
}

export function isAppName(value: string): value is AppName {
  return value in APPS;
}

export function resolveAppName(app?: string): AppName {
  const name = app ?? DEFAULT_APP;
  if (!isAppName(name)) {
    throw new Error(
      `Unknown app '${name}'. Available: ${APP_NAMES.join(", ")}`,
    );
  }
  return name;
}

function appConfig(app?: AppName): AppConfig {
  return APPS[resolveAppName(app)];
}

// ---------------------------------------------------------------------------
// Repo detection — `git remote get-url origin` → "org/repo".
// ---------------------------------------------------------------------------

export function detectRepo(): string {
  const r = childProcess.spawnSync("git", ["remote", "get-url", "origin"], {
    encoding: "utf8",
    timeout: 5000,
  });
  if (r.status !== 0) return "";
  const url = (r.stdout ?? "").trim();
  // SSH: git@github.com:GetEvinced/infra-pulse.git
  let m = /^git@github\.com:(.+?)(?:\.git)?$/.exec(url);
  if (m && m[1]) return m[1];
  // HTTPS: https://github.com/GetEvinced/infra-pulse.git
  m = /^https:\/\/github\.com\/(.+?)(?:\.git)?$/.exec(url);
  if (m && m[1]) return m[1];
  return "";
}

// ---------------------------------------------------------------------------
// Cache (shared on-disk format with the Python implementation).
// ---------------------------------------------------------------------------

// Resolved lazily so tests can override `HOME` after import. The cost
// (one os.homedir() call per cache op) is negligible.
function cacheDir(): string {
  return path.join(os.homedir(), ".cache", "github-app-tokens");
}

function atomicWriteJson(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = path.join(
    path.dirname(file),
    `.${path.basename(file, path.extname(file))}-${process.pid}-${Date.now()}`,
  );
  try {
    fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw err;
  }
}

function tokenCacheFile(app: AppName, installationId?: string): string {
  return installationId
    ? path.join(cacheDir(), `${app}-${installationId}.json`)
    : path.join(cacheDir(), `${app}.json`);
}

interface CachedToken {
  token: string;
  expires_at: number;
}

export function readCachedToken(
  app: AppName,
  installationId?: string,
): string | null {
  const file = tokenCacheFile(app, installationId);
  if (!fs.existsSync(file)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8")) as CachedToken;
    // Expire 5 minutes early to avoid mid-request expiry.
    if ((data.expires_at ?? 0) > Date.now() / 1000 + 300) return data.token;
  } catch {
    /* ignore */
  }
  return null;
}

export function writeCachedToken(
  token: string,
  expiresAt: number,
  app: AppName,
  installationId?: string,
): void {
  atomicWriteJson(tokenCacheFile(app, installationId), {
    token,
    expires_at: expiresAt,
  });
}

function installCacheFile(app: AppName): string {
  return path.join(cacheDir(), `installations-${app}.json`);
}

interface InstallCache {
  expires_at: number;
  entries: Record<string, string>;
}

export function readInstallCache(app: AppName): Record<string, string> {
  const file = installCacheFile(app);
  if (!fs.existsSync(file)) return {};
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8")) as InstallCache;
    if ((data.expires_at ?? 0) > Date.now() / 1000) return data.entries ?? {};
  } catch {
    /* ignore */
  }
  return {};
}

export function writeInstallCache(
  app: AppName,
  entries: Record<string, string>,
): void {
  atomicWriteJson(installCacheFile(app), {
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    entries,
  });
}

// ---------------------------------------------------------------------------
// Private-key resolution.
// ---------------------------------------------------------------------------

export function getPrivateKeyFromKeychain(app?: AppName): string {
  const cfg = appConfig(app);
  let r;
  try {
    r = childProcess.spawnSync(
      "security",
      ["find-generic-password", "-s", cfg.keychainService, "-w"],
      { encoding: "utf8" },
    );
  } catch (err) {
    // `security` only ships on macOS; Linux runners raise ENOENT.
    throw new KeychainError(
      `Keychain unavailable (${(err as Error).name}): ${(err as Error).message}`,
    );
  }
  if (r.error) {
    throw new KeychainError(
      `Keychain unavailable (${r.error.name}): ${r.error.message}`,
    );
  }
  if (r.status !== 0) {
    throw new KeychainError(
      `Keychain read failed (${cfg.keychainService}): ${(r.stderr ?? "").trim()}`,
    );
  }
  // The Python helper base64-decodes the stored value so the keychain entry
  // can hold the multi-line PEM without quoting issues.
  return Buffer.from((r.stdout ?? "").trim(), "base64").toString("utf8");
}

export interface EnvCredentials {
  privateKey: string;
  appId: string;
  installationId: string;
}

export function getPrivateKeyFromEnv(): EnvCredentials {
  const keyB64 = process.env["STARK_PRIVATE_KEY_B64"] ?? "";
  const appId = process.env["STARK_APP_ID"] ?? "";
  const installId = process.env["STARK_INSTALL_ID"] ?? "";
  if (!(keyB64 && appId && installId)) {
    throw new Error(
      "STARK_PRIVATE_KEY_B64, STARK_APP_ID, or STARK_INSTALL_ID is missing or empty",
    );
  }
  return {
    privateKey: Buffer.from(keyB64, "base64").toString("utf8"),
    appId,
    installationId: installId,
  };
}

// ---------------------------------------------------------------------------
// JWT (RS256) — node:crypto, no external dep.
// ---------------------------------------------------------------------------

function base64url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function makeJwt(
  privateKey: string,
  appId: string,
  now: number = Math.floor(Date.now() / 1000),
): string {
  const header = base64url(
    Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })),
  );
  const payload = base64url(
    Buffer.from(JSON.stringify({ iat: now - 60, exp: now + 600, iss: appId })),
  );
  const signingInput = `${header}.${payload}`;
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(signingInput);
  const signature = base64url(signer.sign(privateKey));
  return `${signingInput}.${signature}`;
}

// ---------------------------------------------------------------------------
// HTTP helpers (REST + GraphQL).
// ---------------------------------------------------------------------------

interface RequestOpts {
  method: string;
  path: string;
  bearer: string;
  body?: unknown;
  params?: Record<string, string | number>;
  timeoutMs?: number;
}

async function ghRequest(opts: RequestOpts): Promise<Response> {
  const url = new URL(`${API}${opts.path}`);
  if (opts.params) {
    for (const [k, v] of Object.entries(opts.params)) {
      url.searchParams.set(k, String(v));
    }
  }
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    opts.timeoutMs ?? 30_000,
  );
  try {
    return await fetch(url, {
      method: opts.method,
      headers: {
        Authorization: `Bearer ${opts.bearer}`,
        Accept: "application/vnd.github+json",
        ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function readJson(resp: Response): Promise<unknown> {
  const text = await resp.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// ---------------------------------------------------------------------------
// Installation token mint.
// ---------------------------------------------------------------------------

export interface MintedToken {
  token: string;
  expiresAt: number;
}

export async function mintInstallationToken(
  privateKey: string,
  appId: string,
  installationId: string,
): Promise<MintedToken> {
  const jwt = makeJwt(privateKey, appId);
  const resp = await ghRequest({
    method: "POST",
    path: `/app/installations/${installationId}/access_tokens`,
    bearer: jwt,
    timeoutMs: 10_000,
  });
  if (resp.status !== 201) {
    const body = await resp.text();
    throw new Error(`Token exchange failed (${resp.status}): ${body}`);
  }
  const data = (await resp.json()) as { token: string; expires_at: string };
  return {
    token: data.token,
    expiresAt: Math.floor(new Date(data.expires_at).getTime() / 1000),
  };
}

// ---------------------------------------------------------------------------
// Installation-ID discovery.
// ---------------------------------------------------------------------------

export async function getInstallationId(
  owner: string,
  app?: AppName,
): Promise<string> {
  const appName = resolveAppName(app);
  const cfg = APPS[appName]!;

  // 1. Hardcoded
  if (owner in cfg.installations) return cfg.installations[owner]!;

  // 2. File cache
  const cached = readInstallCache(appName);
  if (owner in cached) return cached[owner]!;

  // 3. API discovery
  let privateKey: string;
  try {
    privateKey = getPrivateKeyFromKeychain(appName);
  } catch (err) {
    if (!(err instanceof KeychainError)) throw err;
    try {
      privateKey = getPrivateKeyFromEnv().privateKey;
    } catch {
      throw new Error(
        `Cannot discover installations for '${appName}': Keychain unavailable and STARK_* env vars not set.`,
      );
    }
  }
  const jwt = makeJwt(privateKey, cfg.appId);
  const resp = await ghRequest({
    method: "GET",
    path: `/app/installations`,
    bearer: jwt,
    params: { per_page: 100 },
  });
  if (resp.status !== 200) {
    const body = await resp.text();
    throw new Error(
      `Failed to list installations for '${appName}' (${resp.status}): ${body}`,
    );
  }
  const list = (await resp.json()) as Array<{
    id: number;
    account?: { login?: string };
  }>;
  const discovered: Record<string, string> = {};
  for (const inst of list) {
    const login = inst.account?.login;
    if (login) discovered[login] = String(inst.id);
  }
  writeInstallCache(appName, { ...cached, ...discovered });
  if (!(owner in discovered)) {
    const known = Object.keys(discovered).join(", ") || "none";
    throw new Error(
      `GitHub App '${appName}' is not installed on owner '${owner}'. Known installations: ${known}.`,
    );
  }
  return discovered[owner]!;
}

// ---------------------------------------------------------------------------
// getToken — 4-tier auth precedence (cache → keychain → env → GH_TOKEN).
// ---------------------------------------------------------------------------

export interface GetTokenOpts {
  app?: AppName;
  owner?: string;
}

export async function getToken(opts: GetTokenOpts = {}): Promise<string> {
  const appName = resolveAppName(opts.app);
  const cfg = APPS[appName]!;

  // Fail closed when a specific owner was requested but cannot be resolved.
  // Silently falling back to the default installation would mint credentials
  // scoped to the wrong org — the caller asked for owner X, returning a token
  // for org Y is a security smell. The Python helper warn-fell-back here; this
  // is a deliberate divergence flagged by stark-review on PR #578.
  let installId = cfg.installationId;
  if (opts.owner) {
    installId = await getInstallationId(opts.owner, appName);
  }

  // 1. Cache
  const cached = readCachedToken(appName, installId);
  if (cached) return cached;

  // 2. Keychain (macOS local dev)
  try {
    const privateKey = getPrivateKeyFromKeychain(appName);
    const { token, expiresAt } = await mintInstallationToken(
      privateKey,
      cfg.appId,
      installId,
    );
    writeCachedToken(token, expiresAt, appName, installId);
    return token;
  } catch (err) {
    if (!(err instanceof KeychainError)) throw err;
  }

  // 3. Env vars (CI / Linux)
  try {
    const env = getPrivateKeyFromEnv();
    const effectiveInstall = opts.owner ? installId : env.installationId;
    const { token, expiresAt } = await mintInstallationToken(
      env.privateKey,
      env.appId,
      effectiveInstall,
    );
    writeCachedToken(token, expiresAt, appName, effectiveInstall);
    return token;
  } catch {
    /* fall through */
  }

  // 4. GH_TOKEN fallback
  const ghToken = process.env["GH_TOKEN"];
  if (ghToken) {
    process.stderr.write(
      "github_app: using GH_TOKEN fallback (App auth unavailable — Keychain failed and STARK_* env vars are not set)\n",
    );
    return ghToken;
  }

  throw new Error(
    "No GitHub auth available: Keychain read failed, STARK_* env vars not set, GH_TOKEN not set.",
  );
}

// ---------------------------------------------------------------------------
// REST helpers.
// ---------------------------------------------------------------------------

/**
 * Auto-derive the repo owner from a `/repos/{owner}/{name}/...` path.
 *
 * Returns `undefined` for routes that aren't repo-scoped (`/user`, `/app`,
 * `/orgs/...`, etc.) — those paths don't need per-installation routing
 * because they hit either the user/app-global context or a different
 * resource hierarchy. Callers can still pass `owner` explicitly to override.
 */
function ownerFromPath(pathStr: string): string | undefined {
  const m = /^\/repos\/([^/]+)\/[^/]+/.exec(pathStr);
  return m?.[1];
}

async function apiCall(
  method: string,
  pathStr: string,
  body?: unknown,
  params?: Record<string, string | number>,
  app?: AppName,
  owner?: string,
): Promise<unknown> {
  // Per-owner installation routing: prefer the caller's explicit `owner`,
  // otherwise derive from a `/repos/{owner}/...` path. `getToken` itself
  // falls back to the default installation only when no owner was provided
  // — explicit-but-unresolvable owners fail closed (see getToken).
  const effectiveOwner = owner ?? ownerFromPath(pathStr);
  const bearer = await getToken({ app, owner: effectiveOwner });
  const resp = await ghRequest({
    method,
    path: pathStr,
    bearer,
    body,
    params,
  });
  if (resp.status >= 400) {
    const text = await resp.text();
    throw new Error(`GitHub ${method} ${pathStr} failed (${resp.status}): ${text}`);
  }
  return readJson(resp);
}

export async function apiGet(
  pathStr: string,
  params?: Record<string, string | number>,
  app?: AppName,
  owner?: string,
): Promise<unknown> {
  return apiCall("GET", pathStr, undefined, params, app, owner);
}

export async function apiPost(
  pathStr: string,
  body?: unknown,
  app?: AppName,
  owner?: string,
): Promise<unknown> {
  return apiCall("POST", pathStr, body, undefined, app, owner);
}

export async function apiPut(
  pathStr: string,
  body?: unknown,
  app?: AppName,
  owner?: string,
): Promise<unknown> {
  return apiCall("PUT", pathStr, body, undefined, app, owner);
}

export async function apiPatch(
  pathStr: string,
  body?: unknown,
  app?: AppName,
  owner?: string,
): Promise<unknown> {
  return apiCall("PATCH", pathStr, body, undefined, app, owner);
}

export async function apiDelete(
  pathStr: string,
  app?: AppName,
  owner?: string,
): Promise<number> {
  const effectiveOwner = owner ?? ownerFromPath(pathStr);
  const bearer = await getToken({ app, owner: effectiveOwner });
  const resp = await ghRequest({ method: "DELETE", path: pathStr, bearer });
  if (resp.status >= 400) {
    const text = await resp.text();
    throw new Error(`GitHub DELETE ${pathStr} failed (${resp.status}): ${text}`);
  }
  return resp.status;
}

// ---------------------------------------------------------------------------
// GraphQL with one retry on transient connection failure.
// ---------------------------------------------------------------------------

export interface GraphQLOpts {
  variables?: Record<string, unknown>;
  retry?: boolean;
  app?: AppName;
}

export async function graphql(
  query: string,
  opts: GraphQLOpts = {},
): Promise<unknown> {
  const bearer = await getToken({ app: opts.app });
  const body: Record<string, unknown> = { query };
  if (opts.variables !== undefined) body["variables"] = opts.variables;
  const attempts = opts.retry === false ? 1 : 2;
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const resp = await ghRequest({
        method: "POST",
        path: "/graphql",
        bearer,
        body,
      });
      if (resp.status >= 400) {
        const text = await resp.text();
        throw new Error(`GraphQL HTTP ${resp.status}: ${text}`);
      }
      const data = (await resp.json()) as { errors?: Array<{ message?: string }> };
      if (data.errors && data.errors.length > 0) {
        const msgs = data.errors
          .map((e) => e.message ?? JSON.stringify(e))
          .join("; ");
        throw new Error(`GraphQL errors: ${msgs}`);
      }
      return data;
    } catch (err) {
      lastErr = err;
      const msg = (err as Error).message ?? "";
      const transient =
        msg.includes("ECONNRESET") ||
        msg.includes("fetch failed") ||
        msg.includes("ENOTFOUND");
      if (!transient || i + 1 >= attempts) throw err;
    }
  }
  throw lastErr ?? new Error("GraphQL request failed after retries");
}

// ---------------------------------------------------------------------------
// High-level operations (parity with the Python module's surface).
// ---------------------------------------------------------------------------

export async function repoInfo(repo: string, app?: AppName): Promise<unknown> {
  return apiGet(`/repos/${repo}`, undefined, app);
}

export async function prList(
  repo: string,
  state: string = "open",
  app?: AppName,
): Promise<unknown> {
  return apiGet(`/repos/${repo}/pulls`, { state, per_page: 30 }, app);
}

export async function prView(
  repo: string,
  number: number,
  app?: AppName,
): Promise<unknown> {
  return apiGet(`/repos/${repo}/pulls/${number}`, undefined, app);
}

export interface PrCreateOpts {
  head: string;
  title: string;
  body?: string;
  base?: string;
  draft?: boolean;
  app?: AppName;
}

export async function prCreate(repo: string, opts: PrCreateOpts): Promise<unknown> {
  return apiPost(
    `/repos/${repo}/pulls`,
    {
      head: opts.head,
      base: opts.base ?? "main",
      title: opts.title,
      body: opts.body ?? "",
      draft: opts.draft ?? false,
    },
    opts.app,
  );
}

export type PrReviewEvent = "APPROVE" | "REQUEST_CHANGES" | "COMMENT";

export async function prReview(
  repo: string,
  number: number,
  event: PrReviewEvent,
  body: string = "",
  app?: AppName,
): Promise<unknown> {
  return apiPost(
    `/repos/${repo}/pulls/${number}/reviews`,
    { event, body },
    app,
  );
}

export type PrMergeMethod = "squash" | "merge" | "rebase";

export async function prMerge(
  repo: string,
  number: number,
  method: PrMergeMethod = "squash",
  commitTitle: string = "",
  app?: AppName,
): Promise<unknown> {
  const payload: Record<string, unknown> = { merge_method: method };
  if (commitTitle) payload["commit_title"] = commitTitle;
  return apiPut(`/repos/${repo}/pulls/${number}/merge`, payload, app);
}

export async function prComment(
  repo: string,
  number: number,
  body: string,
  app?: AppName,
): Promise<unknown> {
  return apiPost(
    `/repos/${repo}/issues/${number}/comments`,
    { body },
    app,
  );
}

export async function issueList(
  repo: string,
  state: string = "open",
  app?: AppName,
): Promise<unknown[]> {
  const items = (await apiGet(
    `/repos/${repo}/issues`,
    { state, per_page: 30 },
    app,
  )) as Array<Record<string, unknown>>;
  return items.filter((i) => !("pull_request" in i));
}

export interface IssueCreateOpts {
  title: string;
  body?: string;
  labels?: string[];
  issueType?: string;
  app?: AppName;
}

export async function issueCreate(
  repo: string,
  opts: IssueCreateOpts,
): Promise<unknown> {
  const payload: Record<string, unknown> = {
    title: opts.title,
    body: opts.body ?? "",
  };
  if (opts.labels && opts.labels.length > 0) payload["labels"] = opts.labels;
  if (opts.issueType) payload["type"] = opts.issueType;
  return apiPost(`/repos/${repo}/issues`, payload, opts.app);
}
