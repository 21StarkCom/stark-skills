// TEMPORARY — deliberate type error, reverted in the next commit.
// Proves the `typecheck` required check can actually go red on a PR, and that
// `test` stays green on the same commit (Node strips types, it does not check
// them). Exactly the STARK-5008 failure scenario, run live.
export const probe: number = "this is not a number";
