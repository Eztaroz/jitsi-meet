#!/bin/sh
# Usage: redeploy-central.sh <PREFIX>
# Redeploys the central stack and waits for every central service to be healthy (central-health.sh). Inside the night
# window only, unless NIGHT_WINDOW_CHECK=0 (a deployment by hand, or a rollback). The stack is redeployed either
#   through Portainer's API, when <PREFIX>_PORTAINER_URL is set (Portainer CE has no stack webhook; ADR 0021): this needs
#       node, and the variables of deploy/pipeline/redeployStackMain.ts; or
#   through the stack's Portainer webhook, <PREFIX>_WEBHOOK (Portainer Business).
# With neither there is nothing to deploy: it exits 0.
here=$(cd "$(dirname "$0")" && pwd)
. "$here/lib.sh"

prefix=${1:?usage: redeploy-central.sh <PREFIX>}
webhook=$(value "${prefix}_WEBHOOK")
portainer=$(value "${prefix}_PORTAINER_URL")

if [ -z "$webhook" ] && [ -z "$portainer" ]; then
    log "Neither ${prefix}_PORTAINER_URL nor ${prefix}_WEBHOOK is set: skipping the deploy"
    exit 0
fi
if [ "${NIGHT_WINDOW_CHECK:-1}" != 0 ]; then
    sh "$here/night-window.sh" || exit 1
fi

if [ -n "$portainer" ]; then
    log "Redeploying the central stack through Portainer's API ($prefix)"
    if ! ${NODE:-node} --disable-warning=ExperimentalWarning "$here/../../../pipeline/redeployStackMain.ts" "$prefix"; then
        log "ERROR: the Portainer redeploy failed"
        exit 1
    fi
else
    log "Triggering the Portainer redeploy of the central stack ($prefix)"
    # -k: Portainer's certificate is self-signed on an internal address. The URL is a secret: it is not printed.
    code=$(curl -k -sS -m 60 -o /dev/null -w '%{http_code}' -X POST "$webhook" 2>/dev/null || true)
    log "Portainer webhook -> HTTP $code"
    case "$code" in
        2??) ;;
        *) log "ERROR: the Portainer webhook failed"; exit 1 ;;
    esac
fi

# Portainer pulls and recreates asynchronously: wait a moment for the old containers to go down, so that the checks do not
# see them.
sleep "${REDEPLOY_SETTLE:-0}"
exec sh "$here/central-health.sh" "$prefix"
