# Support-ticket template — Actions billing anomaly

Use when the billing report and the runs/timing API disagree by a large factor
(≥ ~10×) and no workflow change can explain the minutes. This is likely
mis-billing (billing-pipeline error, or deleted-run accounting), and only GitHub
can reconcile it. Submit at github.com/support → Billing → GitHub Actions.

Fill the `<...>` from `gha-cost-breakdown.sh` + `gha-repo-actions-drill.sh`.

---

**Subject:** Actions <OS> minutes billed (<N>) grossly exceed observable usage (~<R> short runs)

**Enterprise:** <slug> · **Org:** <login> · **Repo:** <owner/repo> · **Period:** <YYYY-MM>

Enhanced-billing usage reports for a single private repo:
- Product `actions` · SKU `Actions <OS>` · unitType `Minutes`
- **Quantity <N> minutes** · gross $<g> · included-minutes discount $<d> · **net $<net>**

This is inconsistent with the repo's actual usage by ~<factor>×, unreconcilable
against the API:

1. **Total runs for the period: <R>** (`GET /repos/OWNER/REPO/actions/runs?created=>=<since>`, `total_count`).
2. **All runs short** — longest ~<X> min wall-clock; most < 1 min; ~<T> min total.
3. **No matrix fan-out** — <W> workflows, 1–<J> jobs/run.
4. **Per-run timing reports ~0 billable** — `GET /repos/.../actions/runs/{id}/timing`
   returns `billable.UBUNTU.total_ms = 0` for sampled runs (e.g. `{"billable":{"UBUNTU":{"total_ms":0,...}},"run_duration_ms":9000}`).

<R> runs of 1–<J> short jobs cannot produce <N> billable minutes. The billing
report and the runs/timing API disagree by ~<factor>×.

**Requests:**
1. The per-workflow / per-run breakdown that sums to the <N> `Actions <OS>`
   minutes for this repo/period — which run IDs (or deleted runs) account for it.
2. Confirm if these are deleted/runaway runs and identify the source.
3. If it's a billing-pipeline error (double-count, mis-attribution, unit
   mislabeling), correct the charge.

For reference, the prior month shows <baseline> for this repo — the cost appeared
abruptly with no corresponding workload change.

Happy to provide run IDs, timing samples, or read access.
