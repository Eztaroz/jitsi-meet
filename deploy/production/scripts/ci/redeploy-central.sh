#!/bin/sh
# Usage: redeploy-central.sh <PREFIX>
# Calls the central stack's Portainer webhook (<PREFIX>_WEBHOOK) and waits for every central service to be healthy
# (central-health.sh). Inside the night window only, unless NIGHT_WINDOW_CHECK=0 (a deployment by hand, or a rollback).
# Without the webhook there is nothing to deploy: it exits 0.
here=$(cd "$(dirname "$0")" && pwd)
. "$here/lib.sh"

prefix=${1:?usage: redeploy-central.sh <PREFIX>}
webhook=$(value "${prefix}_WEBHOOK")

if [ -z "$webhook" ]; then
    log "${prefix}_WEBHOOK is not set: skipping the deploy"
    exit 0
fi
if [ "${NIGHT_WINDOW_CHECK:-1}" != 0 ]; then
    sh "$here/night-window.sh" || exit 1
fi

log "Triggering the Portainer redeploy of the central stack ($prefix)"
# -k: Portainer's certificate is self-signed on an internal address. The URL is a secret: it is not printed.
code=$(curl -k -sS -m 60 -o /dev/null -w '%{http_code}' -X POST "$webhook" 2>/dev/null || true)
log "Portainer webhook -> HTTP $code"
case "$code" in
    2??) ;;
    *) log "ERROR: the Portainer webhook failed"; exit 1 ;;
esac

# Portainer pulls and recreates asynchronously: wait a moment for the old containers to go down, so that the checks do not
# see them.
sleep "${REDEPLOY_SETTLE:-0}"
exec sh "$here/central-health.sh" "$prefix"
