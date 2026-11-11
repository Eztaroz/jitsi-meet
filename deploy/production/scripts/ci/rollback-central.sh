#!/bin/sh
# Moves the `production` tag of each central image back to the build it had before promote-central.sh (PREVIOUS_FILE). It is
# allowed at any hour: a rollback must finish even if the deployment ran past 05:00. Redeploying the stack is the next job's.
# With no PREVIOUS_FILE nothing was promoted: it does nothing.
here=$(cd "$(dirname "$0")" && pwd)
. "$here/lib.sh"

previous=${PREVIOUS_FILE:-central-previous.env}
if [ ! -s "$previous" ]; then
    log "No previous build was recorded: nothing was promoted, nothing to roll back"
    exit 0
fi
require IMAGE_PREFIX
crane=${CRANE:-crane}
registry_login

status=0
for image in $CENTRAL_IMAGES; do
    digest=$(sed -n "s/^PREVIOUS_$image=//p" "$previous")
    if [ -z "$digest" ]; then
        log "$image: production had no build before, left as it is"
        continue
    fi
    log "$image: production back to $digest"
    $crane tag "$IMAGE_PREFIX/$image@$digest" production || status=1
done
exit $status
