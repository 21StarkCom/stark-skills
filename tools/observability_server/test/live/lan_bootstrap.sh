#!/usr/bin/env bash
# Phase 8 Task 8 — LAN bootstrap end-to-end.
#
# Executes the loopback → LAN bootstrap five-step sequence from Phase 1
# Task 3 on the actual install, then asserts:
#   - `/data/last_bootstrap_at` is written by the loopback boot.
#   - LAN boot stays accepted only because the marker exists.
#   - The probe endpoint is reachable via TLS terminated by Caddy.
#   - Plain HTTP off-loopback fails (negative test).
# Finally reverts to loopback-only.

set -euo pipefail

COMPOSE_FILE="${COMPOSE_FILE:-tools/observability_server/docker-compose.yml}"
OVERRIDE_EXAMPLE="${OVERRIDE_EXAMPLE:-tools/observability_server/docker-compose.lan.yml.example}"
OVERRIDE_FILE="${OVERRIDE_FILE:-tools/observability_server/docker-compose.override.yml}"
PROJECT_ROOT="${PROJECT_ROOT:-$(pwd)}"
LAN_IP="${LAN_IP:-}"

if [[ -z "$LAN_IP" ]]; then
  echo "set LAN_IP=<your host's LAN address> to run this script" >&2
  echo "example: LAN_IP=192.168.1.42 $0" >&2
  exit 2
fi

if ! command -v mkcert >/dev/null; then
  echo "mkcert not on PATH — install with brew install mkcert" >&2
  exit 2
fi
CA_ROOT=$(mkcert -CAROOT)
if [[ ! -s "$CA_ROOT/rootCA.pem" ]]; then
  echo "mkcert rootCA.pem missing under $CA_ROOT — run mkcert -install" >&2
  exit 2
fi

step() { printf "\n[task-8] step %d — %s\n" "$1" "$2"; }

step 1 "bring stack down + clear bootstrap marker volume"
docker compose -f "$COMPOSE_FILE" down
docker run --rm -v observability_index:/data alpine sh -c 'rm -f /data/last_bootstrap_at'

step 2 "loopback boot + first-bootstrap dance"
docker compose -f "$COMPOSE_FILE" up -d
sleep 2
node --experimental-strip-types tools/observability_open.ts --no-browser

# Assert the marker now exists.
if ! docker exec stark-observability test -s /data/last_bootstrap_at; then
  echo "FAIL — /data/last_bootstrap_at missing after loopback bootstrap" >&2
  exit 1
fi
echo "marker present"

step 3 "stop loopback stack + install LAN override"
docker compose -f "$COMPOSE_FILE" down
cp "$OVERRIDE_EXAMPLE" "$OVERRIDE_FILE"
sed -i.bak "s/LAN_IP_PLACEHOLDER/$LAN_IP/" "$OVERRIDE_FILE"
rm "$OVERRIDE_FILE.bak"

step 4 "boot LAN stack via TLS"
docker compose \
  -f "$COMPOSE_FILE" \
  -f "$OVERRIDE_FILE" up -d
sleep 3

probe=$(curl -sS --cacert "$CA_ROOT/rootCA.pem" "https://$LAN_IP:7700/api/health/probe" || true)
if [[ "$probe" != '{"ok":true}' ]]; then
  echo "FAIL — TLS probe returned: $probe" >&2
  exit 1
fi
echo "TLS probe ok"

# Negative: plain HTTP off-loopback must refuse.
if curl -sS --max-time 5 "http://$LAN_IP:7700/api/health/probe" >/dev/null; then
  echo "FAIL — plain HTTP LAN probe should have been refused" >&2
  exit 1
fi
echo "plain-HTTP LAN refused as expected"

step 5 "revert to loopback-only"
docker compose -f "$COMPOSE_FILE" -f "$OVERRIDE_FILE" down
rm -f "$OVERRIDE_FILE"
docker compose -f "$COMPOSE_FILE" up -d

echo "PASS — LAN bootstrap end-to-end"
