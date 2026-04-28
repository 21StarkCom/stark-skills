import { sha256 } from "./git.ts";

export interface StateFingerprint {
  headOid: string;
  indexHash: string;
  worktreeHash: string;
  existingPrSha: string | null;
  branch: string;
  repoNameWithOwner: string;
}

export interface FingerprintInputs {
  headOid: string;
  indexBytes: string;
  worktreeBytes: string;
  existingPrSha: string | null;
  branch: string;
  repoNameWithOwner: string;
}

export function fingerprintFromInputs(inp: FingerprintInputs): StateFingerprint {
  return {
    headOid: inp.headOid,
    indexHash: sha256(inp.indexBytes),
    worktreeHash: sha256(inp.worktreeBytes),
    existingPrSha: inp.existingPrSha,
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
    "existingPrSha",
    "branch",
    "repoNameWithOwner",
  ];
  return fields.filter(f => a[f] !== b[f]);
}
