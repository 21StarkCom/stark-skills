#!/usr/bin/env bash
# GitHub Actions + GHAS cost breakdown for an enterprise (or single org).
#
# Drills the enhanced-billing usage report from product -> SKU -> repo, and
# reports GHAS (Secret Protection / Code Security) committer-seat consumption.
# This is the "where is the money going" first pass — run it before touching any
# workflow.
#
# Auth: GH_TOKEN must be a PAT with admin:enterprise (for the enterprise usage
# endpoint) or admin:org (for a single org). Read it into the env; never print it.
#
# Usage:
#   GH_TOKEN=<pat> ./gha-cost-breakdown.sh --enterprise <slug>
#   GH_TOKEN=<pat> ./gha-cost-breakdown.sh --org <login>     # narrower; usage still enterprise-scoped
set -euo pipefail

SCOPE_KIND="" SCOPE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --enterprise) SCOPE_KIND=enterprises; SCOPE="$2"; shift 2 ;;
    --org)        SCOPE_KIND=organizations; SCOPE="$2"; shift 2 ;;
    *) echo "usage: $0 --enterprise <slug> | --org <login>" >&2; exit 2 ;;
  esac
done
[ -n "$SCOPE" ] || { echo "usage: $0 --enterprise <slug> | --org <login>" >&2; exit 2; }
: "${GH_TOKEN:?set GH_TOKEN to an admin:enterprise / admin:org PAT}"
export GH_TOKEN

echo "### Billing usage — $SCOPE_KIND/$SCOPE"
# The old orgs/{org}/settings/billing/actions endpoint is GONE (HTTP 410). The
# enhanced-billing usage endpoint returns per-line-item {product,sku,quantity,
# unitType,netAmount,repositoryName}. Enterprise slug works even though the
# top-level enterprises/{slug} REST route 404s (it's GraphQL-only).
gh api "$SCOPE_KIND/$SCOPE/settings/billing/usage" 2>/dev/null | python3 -c "
import json,sys
from collections import defaultdict
d=json.load(sys.stdin); items=d.get('usageItems',[])
if not items: print('  no usageItems (wrong scope/period, or nothing billed)'); sys.exit()
tot=0.0; byprod=defaultdict(float); bysku=defaultdict(float); byrepo=defaultdict(float)
for i in items:
    net=i.get('netAmount',0) or 0; tot+=net
    byprod[i.get('product','?')]+=net
    bysku[(i.get('product','?'),i.get('sku','?'))]+=net
    if i.get('product')=='actions': byrepo[i.get('repositoryName','(none)')]+=net
print(f'  TOTAL net \${tot:.2f}  ({len(items)} line items)')
print('  -- by product --')
for p,v in sorted(byprod.items(),key=lambda x:-x[1]):
    if abs(v)>0.005: print(f'    {v:9.2f}  {p}')
print('  -- top SKUs --')
for (p,s),v in sorted(bysku.items(),key=lambda x:-x[1])[:12]:
    if abs(v)>0.005: print(f'    {v:9.2f}  {p} / {s}')
print('  -- Actions \$ by repo (the cost driver lives here) --')
for r,v in sorted(byrepo.items(),key=lambda x:-x[1])[:15]:
    if abs(v)>0.005: print(f'    {v:9.2f}  {r}')
"

# GHAS seats only make sense at enterprise scope.
if [ "$SCOPE_KIND" = enterprises ]; then
  echo "### GHAS committer seats (per-committer billing)"
  for prod in secret_protection code_security; do
    line=$(gh api "enterprises/$SCOPE/settings/billing/advanced-security?advanced_security_product=$prod" \
             --jq '"used=\(.total_advanced_security_committers) max=\(.maximum_advanced_security_committers)"' 2>/dev/null || echo "n/a")
    printf '  %-18s %s\n' "$prod" "$line"
  done
  echo "  (Secret Protection ~\$19/committer/mo · Code Security ~\$30/committer/mo · Dependabot+dep-graph are FREE)"
fi
