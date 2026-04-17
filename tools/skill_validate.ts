import path from "node:path";

import { parseMarkdownLinkTargets, type SkillBundle } from "./skill_lib.ts";

export type ProposalStalenessResult =
  | { stale: false }
  | { stale: true; path: string; reason: "modified" | "deleted" };

/**
 * Returns stale=true when any bundle file has been modified more recently
 * than the proposal file OR has been deleted since the proposal was written.
 *
 * `mtimeFor` is a resolver that returns the mtime (ms) for a relative path,
 * or `null` if the file no longer exists. Passing a pre-run snapshot lets
 * the caller evaluate staleness against the state at the START of a
 * multi-bundle run, so an earlier bundle's own apply step can't trigger a
 * spurious stale failure for a later bundle.
 */
export type BundleProposal = {
  skillPath: string;
  proposal: RewriteProposal;
};

/**
 * Throws if two selected bundles propose incompatible actions on the same
 * shared reference (different update content, or one wants update and the
 * other delete). Prevents a sequential per-bundle apply from silently
 * clobbering an earlier edit on a shared standards doc.
 */
/**
 * When a bundle deletes a shared ref, every OTHER owner's post-rewrite
 * SKILL.md must also drop its link to that ref — otherwise apply leaves
 * dangling links in the co-owners. The per-bundle validateProposal can't
 * catch this because it only sees one proposal at a time; this runs once
 * after all proposals are loaded, before the first apply.
 *
 * `ownerSkillContents` holds the CURRENT SKILL.md text for each owner, used
 * as a fallback when an owner's proposal doesn't touch its own SKILL.md.
 */
export function assertSharedDeletedRefsRemoved(
  bundleProposals: BundleProposal[],
  sharedRefOwners: Map<string, string[]>,
  ownerSkillContents: Map<string, string>,
): void {
  const proposalByOwner = new Map(
    bundleProposals.map((b) => [b.skillPath, b.proposal]),
  );
  for (const { skillPath, proposal } of bundleProposals) {
    for (const change of proposal.changes) {
      if (change.action !== "delete") continue;
      const owners = sharedRefOwners.get(change.path);
      if (!owners || owners.length < 2) continue;
      for (const otherOwner of owners) {
        if (otherOwner === skillPath) continue;
        const postContent = postApplySkillContent(
          otherOwner,
          proposalByOwner.get(otherOwner),
          ownerSkillContents,
        );
        if (postContent === null) continue; // owner itself is being deleted
        if (contentLinksToRef(postContent, otherOwner, change.path)) {
          throw new Error(
            `Refusing to delete ${change.path}: ${otherOwner} still links to it ` +
              `in its post-rewrite SKILL.md. Update every owner's proposal to drop ` +
              `the link before deleting the shared reference.`,
          );
        }
      }
    }
  }
}

function postApplySkillContent(
  skillPath: string,
  proposal: RewriteProposal | undefined,
  ownerSkillContents: Map<string, string>,
): string | null {
  if (proposal) {
    const change = proposal.changes.find((c) => c.path === skillPath);
    if (change?.action === "update") return change.content;
    if (change?.action === "delete") return null;
  }
  return ownerSkillContents.get(skillPath) ?? "";
}

function contentLinksToRef(
  content: string,
  ownerSkillPath: string,
  targetRefPath: string,
): boolean {
  const ownerDir = path.posix.dirname(ownerSkillPath);
  for (const target of extractLocalMarkdownLinks(content)) {
    const relOnly = target.split("#")[0];
    if (!relOnly) continue;
    const resolved = path.posix.normalize(path.posix.join(ownerDir, relOnly));
    if (resolved === targetRefPath) return true;
  }
  return false;
}

function extractLocalMarkdownLinks(content: string): string[] {
  // Reuse skill_lib's shared parser so a future link-syntax fix stays
  // consistent with bundle discovery. Filter to markdown targets only —
  // the delete guard is scoped to .md shared refs.
  return parseMarkdownLinkTargets(content).filter(
    (t) => t.toLowerCase().endsWith(".md") || t.toLowerCase().includes(".md#"),
  );
}

export function assertCrossBundleConsistency(entries: BundleProposal[]): void {
  type Claim = { skillPath: string; action: RewriteAction; content: string };
  const byPath = new Map<string, Claim[]>();
  for (const { skillPath, proposal } of entries) {
    for (const change of proposal.changes) {
      if (change.action === "keep") continue;
      const list = byPath.get(change.path) ?? [];
      list.push({ skillPath, action: change.action, content: change.content });
      byPath.set(change.path, list);
    }
  }
  for (const [sharedPath, claims] of byPath) {
    if (claims.length < 2) continue;
    const first = claims[0];
    const disagreement = claims.find(
      (c) => c.action !== first.action || c.content !== first.content,
    );
    if (disagreement) {
      const owners = claims.map((c) => `${c.skillPath} (${c.action})`).join(", ");
      throw new Error(
        `Cross-bundle conflict on ${sharedPath}: ${owners}. ` +
          "Reconcile the proposals (identical content or matching delete) before applying.",
      );
    }
  }
}

export function findStaleBundleFile(
  proposalMtimeMs: number,
  bundleFilePaths: string[],
  mtimeFor: (relPath: string) => number | null,
): ProposalStalenessResult {
  for (const relPath of bundleFilePaths) {
    const mtime = mtimeFor(relPath);
    if (mtime === null) {
      return { stale: true, path: relPath, reason: "deleted" };
    }
    if (mtime > proposalMtimeMs) {
      return { stale: true, path: relPath, reason: "modified" };
    }
  }
  return { stale: false };
}

export function extractOutputText(payload: unknown): string {
  if (typeof payload !== "object" || payload === null) {
    throw new Error("Responses API payload is not an object");
  }
  const p = payload as Record<string, unknown>;
  if (typeof p.output_text === "string" && p.output_text.trim()) {
    return p.output_text;
  }
  const parts: string[] = [];
  const output = Array.isArray(p.output) ? p.output : [];
  for (const item of output) {
    if (typeof item !== "object" || item === null) continue;
    const itemContent = (item as Record<string, unknown>).content;
    const contents = Array.isArray(itemContent) ? itemContent : [];
    for (const content of contents) {
      if (typeof content !== "object" || content === null) continue;
      const c = content as Record<string, unknown>;
      if (c.type === "output_text" && typeof c.text === "string") {
        parts.push(c.text);
      }
    }
  }
  const joined = parts.join("").trim();
  if (!joined) {
    throw new Error("Responses API returned no output text");
  }
  return joined;
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

export function decodeRewriteProposal(raw: unknown): RewriteProposal {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("Proposal is not an object");
  }
  const r = raw as Record<string, unknown>;
  if (typeof r.bundle_summary !== "string") {
    throw new Error("bundle_summary must be a string");
  }
  if (!isStringArray(r.global_notes)) throw new Error("global_notes must be string[]");
  if (!isStringArray(r.refs_kept)) throw new Error("refs_kept must be string[]");
  if (!isStringArray(r.refs_removed)) throw new Error("refs_removed must be string[]");
  if (!isStringArray(r.contradictions_resolved)) throw new Error("contradictions_resolved must be string[]");
  if (!isStringArray(r.terminology_normalizations)) throw new Error("terminology_normalizations must be string[]");
  if (!isStringArray(r.warnings)) throw new Error("warnings must be string[]");
  if (!Array.isArray(r.changes)) throw new Error("changes must be an array");
  const changes: RewriteChange[] = r.changes.map((item, i) => {
    if (typeof item !== "object" || item === null) {
      throw new Error(`changes[${i}] is not an object`);
    }
    const c = item as Record<string, unknown>;
    if (typeof c.path !== "string") throw new Error(`changes[${i}].path must be a string`);
    if (c.action !== "update" && c.action !== "delete" && c.action !== "keep") {
      throw new Error(`changes[${i}].action must be update|delete|keep`);
    }
    if (typeof c.summary !== "string") throw new Error(`changes[${i}].summary must be a string`);
    if (typeof c.content !== "string") throw new Error(`changes[${i}].content must be a string`);
    return {
      path: c.path,
      action: c.action,
      summary: c.summary,
      content: c.content,
    };
  });
  return {
    bundle_summary: r.bundle_summary,
    global_notes: r.global_notes,
    changes,
    refs_kept: r.refs_kept,
    refs_removed: r.refs_removed,
    contradictions_resolved: r.contradictions_resolved,
    terminology_normalizations: r.terminology_normalizations,
    warnings: r.warnings,
  };
}


export type RewriteAction = "update" | "delete" | "keep";

export type RewriteChange = {
  path: string;
  action: RewriteAction;
  summary: string;
  // Required everywhere: the OpenAI schema marks content required, and
  // validateProposal rejects non-string values. Optional typing let
  // callers pass `undefined` past tsc even though runtime always rejects.
  content: string;
};

export type RewriteProposal = {
  bundle_summary: string;
  global_notes: string[];
  changes: RewriteChange[];
  refs_kept: string[];
  refs_removed: string[];
  contradictions_resolved: string[];
  terminology_normalizations: string[];
  warnings: string[];
};

export function validateProposal(
  bundle: SkillBundle,
  proposal: RewriteProposal,
  bundleFiles: Array<{ path: string; content: string }>,
  sharedRefOwners: Map<string, string[]>,
  selectedSkillPaths: Set<string>,
): void {
  const allowedPaths = new Set([bundle.skillPath, ...bundle.refs]);
  const currentContent = new Map(bundleFiles.map((file) => [file.path, file.content]));
  const seen = new Set<string>();
  for (const change of proposal.changes) {
    if (!allowedPaths.has(change.path)) {
      throw new Error(`Proposal touched unexpected path: ${change.path}`);
    }
    if (change.path === bundle.skillPath && change.action === "delete") {
      throw new Error("Proposal cannot delete the main SKILL.md");
    }
    if (seen.has(change.path)) {
      throw new Error(`Proposal touched the same path twice: ${change.path}`);
    }
    seen.add(change.path);
    if (typeof change.content !== "string") {
      throw new Error(`Change is missing string content: ${change.path}`);
    }
    if (change.action === "update" && change.content.length === 0) {
      throw new Error(`Updated file is missing content: ${change.path}`);
    }
    if (change.action === "keep" && change.content !== currentContent.get(change.path)) {
      throw new Error(
        `Proposal marks ${change.path} as "keep" but supplies different content; ` +
          'use action "update" to edit or match the current file exactly.',
      );
    }
    if (change.action === "delete" || change.action === "update") {
      const otherOwners = (sharedRefOwners.get(change.path) ?? []).filter(
        (owner) => owner !== bundle.skillPath && !selectedSkillPaths.has(owner),
      );
      if (otherOwners.length > 0) {
        throw new Error(
          `Refusing to ${change.action} ${change.path}: also referenced by ${otherOwners.join(", ")}. ` +
            "Rerun the optimizer including every owner, or keep the shared ref unchanged.",
        );
      }
    }
    // A delete of a ref owned by this bundle is only safe if the bundle's
    // own post-rewrite SKILL.md no longer links to that path. The shared-
    // ref guard handles cross-bundle references; this block catches the
    // single-owner case where a proposal drops a ref but forgets to remove
    // the link from its own SKILL.md.
    if (change.action === "delete" && change.path !== bundle.skillPath) {
      const selfSkillChange = proposal.changes.find(
        (c) => c.path === bundle.skillPath,
      );
      const postSkillContent =
        selfSkillChange?.action === "update"
          ? selfSkillChange.content
          : currentContent.get(bundle.skillPath) ?? "";
      if (contentLinksToRef(postSkillContent, bundle.skillPath, change.path)) {
        throw new Error(
          `Refusing to delete ${change.path}: ${bundle.skillPath} still links ` +
            `to it after its own rewrite. Update SKILL.md to drop the link ` +
            `before deleting the reference.`,
        );
      }
    }
  }
  for (const ref of proposal.refs_removed) {
    if (!bundle.refs.includes(ref)) {
      throw new Error(`refs_removed contains a non-reference path: ${ref}`);
    }
  }
}
