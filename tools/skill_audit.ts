#!/usr/bin/env node

import {
  collectSharedRefs,
  discoverSkillBundles,
  findRepoRoot,
  hasBrokenRefs,
} from "./skill_lib.ts";

const repoRoot = findRepoRoot(process.cwd());
const args = new Set(process.argv.slice(2));
const asJson = args.has("--json");
const validateOnly = args.has("--validate");

const bundles = discoverSkillBundles(repoRoot);
const sharedRefs = collectSharedRefs(bundles);

if (asJson) {
  console.log(
    JSON.stringify(
      {
        repoRoot,
        skills: bundles,
        sharedRefs,
        brokenRefCount: bundles.reduce(
          (sum, bundle) => sum + bundle.missingRefs.length,
          0,
        ),
      },
      null,
      2,
    ),
  );
  process.exit(hasBrokenRefs(bundles) ? 1 : 0);
}

if (validateOnly) {
  const broken = bundles.filter((bundle) => bundle.missingRefs.length > 0);
  if (!broken.length) {
    console.log("All local markdown references resolve.");
    process.exit(0);
  }
  for (const bundle of broken) {
    console.log(bundle.skillPath);
    for (const ref of bundle.missingRefs) {
      console.log(`  - ${ref}`);
    }
  }
  process.exit(1);
}

console.log(`Repo: ${repoRoot}`);
console.log(`Skills: ${bundles.length}`);
console.log("");
for (const bundle of bundles) {
  const refSummary = bundle.refs.length ? `${bundle.refs.length} refs` : "no refs";
  const brokenSummary = bundle.missingRefs.length
    ? `, ${bundle.missingRefs.length} broken`
    : "";
  console.log(
    `${bundle.skillPath} (${bundle.wordCount}w/${bundle.lineCount}l, ${refSummary}${brokenSummary})`,
  );
  for (const ref of bundle.refs) {
    console.log(`  - ${ref}`);
  }
  for (const ref of bundle.missingRefs) {
    console.log(`  ! ${ref}`);
  }
}
if (sharedRefs.length) {
  console.log("");
  console.log("Shared references:");
  for (const item of sharedRefs) {
    console.log(`- ${item.ref}`);
    console.log(`  ${item.skills.join(", ")}`);
  }
}

process.exit(hasBrokenRefs(bundles) ? 1 : 0);
