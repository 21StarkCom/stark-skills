import type { SkillBundle } from "./skill_lib.ts";

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
  }
  for (const ref of proposal.refs_removed) {
    if (!bundle.refs.includes(ref)) {
      throw new Error(`refs_removed contains a non-reference path: ${ref}`);
    }
  }
}
