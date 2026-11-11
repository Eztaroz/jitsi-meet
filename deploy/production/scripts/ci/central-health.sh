#!/bin/sh
# Usage: central-health.sh <PREFIX>
# Waits until every central service is healthy, as ADR 0017 defines it, for at most HEALTH_TIMEOUT seconds (default 120),
# and says each check's result. Exits 0 when all pass, 1 when one is still failing at the end.
#   the coordinator service: its health check passes and it holds the database lock (active, not standby);
#   the web server and the front web server: the page and its configuration are served, not the maintenance page
#       (the front web server marks that page with the header X-Maintenance);
#   Prosody, Jicofo, the videobridge: their own health checks pass, and the coordinator service can still list the open rooms.
# Variables, all prefixed with <PREFIX>_ (TEST or PRODUCTION):
#   URL                   the public address, https://<host>
#   COORDINATOR_SECRET    the bearer secret of the coordinator service's API
#   JICOFO_HEALTH_URL     Jicofo's health check, e.g. http://<host>:8888/about/health
#   JVB_HEALTH_URL        the videobridge's, e.g. http://<host>:8080/about/health
#   INSECURE              1 to accept a self-signed certificate (the test deployment's)
# A check whose variable is empty fails: a check must never be skipped quietly.
here=$(cd "$(dirname "$0")" && pwd)
. "$here/lib.sh"

prefix=${1:?usage: central-health.sh <PREFIX>}
base=$(value "${prefix}_URL")
secret=$(value "${prefix}_COORDINATOR_SECRET")
jicofo=$(value "${prefix}_JICOFO_HEALTH_URL")
jvb=$(value "${prefix}_JVB_HEALTH_URL")
insecure=""
[ "$(value "${prefix}_INSECURE")" = 1 ] && insecure="-k"
timeout=${HEALTH_TIMEOUT:-120}
interval=${HEALTH_INTERVAL:-5}
body=$(mktemp)
headers=$(mktemp)
trap 'rm -f "$body" "$headers"' EXIT

# get <url> [bearer]: fetches into $body and $headers; prints the status (000 when nothing answers). The secret goes to curl
# on its standard input, so that it is not in the process list.
get() {
    if [ -n "$2" ]; then
        printf 'header = "Authorization: Bearer %s"\n' "$2" | curl -sS $insecure -m 10 -K - -D "$headers" -o "$body" -w '%{http_code}' "$1" 2>/dev/null || true
    else
        curl -sS $insecure -m 10 -D "$headers" -o "$body" -w '%{http_code}' "$1" 2>/dev/null || true
    fi
}

# result <name> <ok|FAIL> <detail>: prints one line, and remembers a failure.
result() {
    printf '  %-4s %-30s %s\n' "$2" "$1" "$3"
    [ "$2" = ok ] || failed=1
}

maintenance() { grep -qi '^x-maintenance:' "$headers"; }

attempt() {
    failed=0
    if [ -z "$base" ]; then
        result "web page" FAIL "${prefix}_URL is not set"
        return
    fi

    if [ -z "$secret" ]; then
        for name in "coordinator health" "coordinator holds the lock" "open rooms"; do
            result "$name" FAIL "${prefix}_COORDINATOR_SECRET is not set"
        done
    else
        status=$(get "$base/coordinator/health" "$secret")
        if [ "$status" = 200 ]; then
            result "coordinator health" ok "HTTP 200"
        else
            result "coordinator health" FAIL "HTTP $status"
        fi
        if [ "$status" = 200 ] && grep -q '"active": *true' "$body"; then
            result "coordinator holds the lock" ok "active"
        else
            result "coordinator holds the lock" FAIL "not active (standby, or no answer)"
        fi
        status=$(get "$base/coordinator/rooms" "$secret")
        if [ "$status" = 200 ]; then
            result "open rooms" ok "listed through Prosody"
        else
            result "open rooms" FAIL "HTTP $status"
        fi
    fi

    status=$(get "$base/front-health")
    if [ "$status" = 200 ] && grep -q '^ok' "$body"; then
        result "front web server" ok "answers by itself"
    else
        result "front web server" FAIL "HTTP $status"
    fi

    status=$(get "$base/")
    if [ "$status" != 200 ]; then
        result "web page" FAIL "HTTP $status"
    elif maintenance; then
        result "web page" FAIL "the maintenance page"
    else
        result "web page" ok "HTTP 200, not the maintenance page"
    fi

    status=$(get "$base/config.js")
    if [ "$status" != 200 ]; then
        result "web configuration" FAIL "HTTP $status"
    elif maintenance; then
        result "web configuration" FAIL "the maintenance page"
    else
        result "web configuration" ok "HTTP 200"
    fi

    # Prosody's BOSH endpoint answers GET 200 when Prosody runs; the web server proxies it.
    status=$(get "$base/http-bind")
    if [ "$status" = 200 ]; then
        result "Prosody" ok "BOSH endpoint answers"
    else
        result "Prosody" FAIL "HTTP $status"
    fi

    for entry in "Jicofo|$jicofo|${prefix}_JICOFO_HEALTH_URL" "videobridge|$jvb|${prefix}_JVB_HEALTH_URL"; do
        name=${entry%%|*}
        rest=${entry#*|}
        url=${rest%%|*}
        var=${rest#*|}
        if [ -z "$url" ]; then
            result "$name" FAIL "$var is not set"
            continue
        fi
        status=$(get "$url")
        if [ "$status" = 200 ]; then
            result "$name" ok "own health check, HTTP 200"
        else
            result "$name" FAIL "HTTP $status"
        fi
    done
}

started=$(date +%s)
n=1
while :; do
    log "Health check $n ($prefix):"
    attempt
    if [ "$failed" = 0 ]; then
        log "Every central service is healthy"
        exit 0
    fi
    if [ $(( $(date +%s) - started + interval )) -gt "$timeout" ]; then
        log "ERROR: not healthy within ${timeout}s"
        exit 1
    fi
    n=$((n + 1))
    sleep "$interval"
done
