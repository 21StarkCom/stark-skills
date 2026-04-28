import { sha256 } from "./git.ts";

export interface StateFingerprint {
  headOid: string;
  indexHash: string;
  worktreeHash: string;
  worktreeContentHash: string | null;
  existingPrSha: string | null;
  baseOid: string;
  branch: string;
  repoNameWithOwner: string;
}

export interface FingerprintInputs {
  headOid: string;
  indexBytes: string;
  worktreeBytes: string;
  worktreeContentBytes: string | null;
  existingPrSha: string | null;
  baseOid: string;
  branch: string;
  repoNameWithOwner: string;
}

export function fingerprintFromInputs(inp: FingerprintInputs): StateFingerprint {
  return {
    headOid: inp.headOid,
    indexHash: sha256(inp.indexBytes),
    worktreeHash: sha256(inp.worktreeBytes),
    worktreeContentHash: inp.worktreeContentBytes === null ? null : sha256(inp.worktreeContentBytes),
    existingPrSha: inp.existingPrSha,
    baseOid: inp.baseOid,
    branch: inp.branch,
    repoNameWithOwner: inp.repoNameWithOwner,
  };
}

export function fingerprintsMatch(a: StateFingerprint, b: StateFingerprint): boolean {
  return diffFingerprints(a, b).length === 0;
}

export function diffFingerprints(a: StateFingerprint, b: StateFingerprint): (keyof StateFingerprint)[] {
  const fields: (keyof StateFingerprint)[] = [
    "headOid",
    "indexHash",
    "worktreeHash",
    "worktreeContentHash",
    "existingPrSha",
    "baseOid",
    "branch",
    "repoNameWithOwner",
  ];
  return fields.filter(f => a[f] !== b[f]);
}
