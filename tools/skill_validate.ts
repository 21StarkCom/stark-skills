import type { SkillBundle } from "./skill_lib.ts";

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
    if (change.action === "delete") {
      const otherOwners = (sharedRefOwners.get(change.path) ?? []).filter(
        (owner) => owner !== bundle.skillPath && !selectedSkillPaths.has(owner),
      );
      if (otherOwners.length > 0) {
        throw new Error(
          `Refusing to delete ${change.path}: also referenced by ${otherOwners.join(", ")}. ` +
            "Rerun the optimizer including every owner or keep the shared ref.",
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
