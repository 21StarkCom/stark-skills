# Signal-to-Noise Optimization (learned from real-world data)

In an 8-round review of a 12K-line PR, 18-agent dispatch produced 97 findings with ~10% signal-to-noise. Targeted 3-agent reviews with focused prompts found more real bugs per finding. Key learnings:

1. **Runtime verification catches more critical bugs than review agents.** Import checks and `inspect.signature()` on SDK calls found startup crashes, interface mismatches, and wrong API usage that all 18 agents missed.

2. **Cross-module interface mismatches are the #1 bug class** in AI-generated multi-module code. Each module is written independently and assumes interfaces it hasn't verified. Review agents read one file at a time and rarely trace call chains across module boundaries.

3. **SDK API assumptions are consistently wrong.** AI agents confidently call methods that don't exist. The only reliable verification is installing the package and inspecting it. This pattern repeated 5 times on a single Firestore function.

4. **When classifying findings, weigh runtime-verified findings highest.** A finding from Phase 1.9 (import/SDK check) is almost always a true positive. A finding from a review agent is ~30% true positive.

5. **Test-coverage and style findings are almost always noise.** Unless the PR introduces untested critical logic, suppress test-coverage domain findings to reduce noise.
