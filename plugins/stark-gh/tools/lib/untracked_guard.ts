// untracked_guard.ts — the PATH-based half of the staging guard.
//
// `--commit-all` runs `git add -A`, which stages untracked files as well as
// modified ones. That is usually what you want: new source files are part of
// the change. It is not what you want for the local config sitting in the
// worktree that nobody meant to publish.
//
// lib/secret.ts already scans the staged DIFF, but it is CONTENT-based, and
// that is exactly why it is not enough. On 2026-08-10 `git add -A` swept a
// repo's `.envrc` into a PR and pushed it: the file held only paths and email
// subjects, so every entropy and token rule in the content scanner passed it
// cleanly. The hazard was the file's IDENTITY, not any string inside it.
//
// So this module asks a different question — "is this a kind of file people
// keep out of repos?" — and answers it from the path alone. The two scanners
// are complements: content catches a secret in a source file, path catches a
// config file with nothing secret-looking in it.
//
// Design constraint: friction only where it is earned. A new `.ts`, `.go`,
// `.md` or test fixture stages silently as before. Only the patterns below
// stop the run, and the refusal names the file and both remedies.

export interface RiskyUntracked {
  path: string;
  reason: string;
}

interface Rule {
  re: RegExp;
  reason: string;
}

// Ordered most-specific first so the reported reason is the useful one.
const RULES: Rule[] = [
  // Private key material. The one that would actually hurt.
  { re: /(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/, reason: "SSH private key" },
  { re: /\.(pem|key|p12|pfx|jks|keystore)$/i, reason: "key or certificate material" },
  { re: /(^|\/)\.ssh\//, reason: "SSH configuration directory" },

  // Credential files by conventional name.
  { re: /(^|\/)\.netrc$|(^|\/)\.npmrc$|(^|\/)\.pypirc$|(^|\/)\.dockercfg$/, reason: "credential file" },
  { re: /(^|\/)(client_secret|service-account|serviceaccount)[^/]*\.json$/i, reason: "service-credential JSON" },
  { re: /(^|\/)(credentials|token|secrets?)\.(json|ya?ml|toml|ini)$/i, reason: "credential file" },
  { re: /[^/]*-(credentials|secret|secrets|key|token)\.(json|ya?ml|toml)$/i, reason: "credential file" },

  // Local environment / direnv. The 2026-08-10 case.
  { re: /(^|\/)\.envrc$/, reason: "direnv local environment" },
  { re: /(^|\/)\.env(\.|$)/, reason: "local environment file" },
  { re: /(^|\/)\.direnv\//, reason: "direnv state directory" },

  // Terraform state — routinely contains rendered secrets.
  { re: /\.tfstate(\.backup)?$/, reason: "Terraform state" },
  { re: /(^|\/)\.terraform\//, reason: "Terraform working directory" },
  { re: /\.auto\.tfvars$|(^|\/)terraform\.tfvars$/, reason: "Terraform variable file" },

  // Editor / agent / OS local state.
  { re: /(^|\/)\.claude\//, reason: "local agent state" },
  { re: /(^|\/)\.(vscode|idea)\//, reason: "editor-local settings" },
  { re: /(^|\/)\.DS_Store$/, reason: "macOS directory metadata" },
  { re: /(^|\/)\.envrc\.local$|\.local\.(json|ya?ml|toml)$/, reason: "machine-local override" },
];

// Names that LOOK risky by the rules above but are the published examples
// projects deliberately track. Checked first, so `.env.example` stages
// silently rather than teaching people to pass the override reflexively.
const ALLOW: RegExp[] = [
  /(^|\/)\.env\.(example|sample|template|dist)$/i,
  /(^|\/)\.envrc\.(example|sample|template)$/i,
  /(^|\/)(credentials|secrets?)\.example\.(json|ya?ml|toml)$/i,
  /\.pub$/,
  // A directory whose name ENDS in pubkey(s)/publickey(s) — the segment is
  // often dotted (`trust.pubkeys/`), so anchoring on a preceding slash alone
  // misses it. Repos do track public keys deliberately.
  /(^|\/)[^/]*pub(lic)?keys?\//i,
];

/**
 * classifyUntracked returns the subset of paths that `git add -A` would stage
 * and that almost certainly should not be published. An empty array means
 * staging may proceed.
 *
 * Input should be the output of `git ls-files --others --exclude-standard` —
 * untracked AND not already ignored, which is exactly the set `-A` newly adds.
 * A path the repo's .gitignore already covers never reaches here, so a repo
 * with a correct .gitignore sees no behaviour change at all.
 */
export function classifyUntracked(paths: string[]): RiskyUntracked[] {
  const out: RiskyUntracked[] = [];
  for (const raw of paths) {
    const p = raw.trim();
    if (!p) continue;
    if (ALLOW.some(re => re.test(p))) continue;
    const hit = RULES.find(r => r.re.test(p));
    if (hit) out.push({ path: p, reason: hit.reason });
  }
  return out;
}

/**
 * formatRefusal builds the operator-facing message. It names every file, says
 * why each was flagged, and gives both remedies — because the right fix is
 * usually to gitignore the file, not to wave the run through.
 */
export function formatRefusal(risky: RiskyUntracked[]): string {
  const lines = risky.map(r => `  ${r.path}  (${r.reason})`).join("\n");
  return [
    `refusing to stage ${risky.length} untracked file(s) that look like local config or credentials:`,
    lines,
    "",
    "`--commit-all` runs `git add -A`, which stages untracked files too.",
    "",
    "If these should never be committed (usually the case), add them to .gitignore.",
    "Verify with:  git check-ignore -q <path> && echo ignored || echo EXPOSED",
    "  — note a LATER negation in .gitignore can silently kill an earlier rule,",
    "    so confirm with the exit code rather than assuming a matching line works.",
    "",
    "If you genuinely mean to commit them, re-run with --allow-untracked-config,",
    "or stage them yourself and use --staged-only.",
  ].join("\n");
}
