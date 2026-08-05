#!/usr/bin/env bash
# Drill one repo's Actions usage: run counts by workflow, job fan-out, and the
# billing-vs-timing sanity check. Run this on the repo the breakdown flagged.
#
# It answers: is the spend explained by (a) high run volume, (b) matrix job
# fan-out, (c) a few long runs, or (d) NONE of the above — in which case the
# billing number is anomalous and belongs in a Support ticket.
#
# Usage: GH_TOKEN=<pat> ./gha-repo-actions-drill.sh <owner/repo> [since=YYYY-MM-DD]
set -euo pipefail
REPO="${1:?usage: gha-repo-actions-drill.sh <owner/repo> [since=YYYY-MM-DD]}"
SINCE="${2:-$(date -u +%Y-%m-01)}"   # default: start of current month
: "${GH_TOKEN:?set GH_TOKEN}"; export GH_TOKEN

# STEP 0 — visibility. Public repos get UNLIMITED FREE GitHub-hosted Actions
# minutes AND storage. If this repo is public, its Actions runs cost $0 no matter
# how many or how long — stop here and look at what the workflow *touches*
# (see the downstream-resource note below), not the runs.
VIS=$(gh api "repos/$REPO" --jq '.visibility' 2>/dev/null || echo unknown)
echo "### $REPO  (visibility: $VIS)"
if [ "$VIS" = "public" ]; then
  cat <<EOF
  PUBLIC repo -> GitHub-hosted Actions minutes + storage are FREE (\$0).
  If a bill still looks high, the cost is NOT the Actions run — it's the resource
  the workflow touches (image pushed to a registry, artifact stored, service
  deployed). Chase THAT (e.g. GCP Artifact Registry storage + Cloud Run), on the
  cloud bill, attributed to the project — not GitHub. Stopping the run drill.
EOF
  exit 0
fi

echo "### $REPO — runs since $SINCE"
echo "-- run count + per-workflow volume --"
gh api "repos/$REPO/actions/workflows" --jq '.workflows[] | "\(.id)\t\(.name)"' 2>/dev/null | while IFS=$'\t' read -r id name; do
  n=$(gh api "repos/$REPO/actions/workflows/$id/runs?created=>=$SINCE&per_page=1" --jq '.total_count' 2>/dev/null)
  printf '  %-6s runs  %s\n' "${n:-?}" "$name"
done

echo "-- job fan-out + billable timing on recent runs (matrix explosion detector) --"
gh api "repos/$REPO/actions/runs?per_page=20&created=>=$SINCE" --jq '.workflow_runs[] | "\(.id)\t\(.name)"' 2>/dev/null | while IFS=$'\t' read -r rid rname; do
  jobs=$(gh api "repos/$REPO/actions/runs/$rid/jobs?per_page=100" --jq '.total_count' 2>/dev/null)
  bill=$(gh api "repos/$REPO/actions/runs/$rid/timing" --jq '.billable.UBUNTU.total_ms // 0' 2>/dev/null)
  printf '  %-11s jobs=%-3s billable_min=%s  (%s)\n' "$rid" "${jobs:-?}" "$(( ${bill:-0} / 60000 ))" "$rname"
done

cat <<'EOF'

### How to read this
- High run COUNT on one workflow  -> reduce triggers (cron freq, concurrency
  cancel-in-progress, path filters). See references/levers.md.
- jobs >> 1 per run               -> matrix fan-out; every job rounds UP to 1
  billed minute, so N short jobs = N billed minutes. Trim the matrix.
- billable_min ~0 on every run but the billing report shows huge minutes
  -> ANOMALY. GitHub's own billing and timing APIs disagree. This is not fixable
     by editing workflows — open a Support ticket. See references/support-ticket.md.
EOF
