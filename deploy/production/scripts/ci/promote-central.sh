#!/bin/sh
# Moves the `production` tag of each central image to this commit's build (ADR 0017), in the night window only, after
# writing down which build `production` pointed at (PREVIOUS_FILE), so that rollback-central.sh can move it back.
# All the images are looked up before any tag moves: a build with an image missing moves nothing.
# Needs: CI_COMMIT_SHA, IMAGE_PREFIX, REGISTRY, REGISTRY_AUTH, and crane (CRANE).
here=$(cd "$(dirname "$0")" && pwd)
. "$here/lib.sh"

if [ -z "${PRODUCTION_WEBHOOK:-}" ]; then
    log "PRODUCTION_WEBHOOK is not set: production is not deployed, so its tags stay"
    exit 0
fi
require CI_COMMIT_SHA IMAGE_PREFIX
crane=${CRANE:-crane}
previous=${PREVIOUS_FILE:-central-previous.env}
sha=$(short_sha)
registry_login

: > "$previous"
for image in $CENTRAL_IMAGES; do
    if ! new=$($crane digest "$IMAGE_PREFIX/$image:$sha"); then
        log "ERROR: $IMAGE_PREFIX/$image:$sha does not exist: this commit's images are not all built"
        rm -f "$previous"
        exit 1
    fi
    old=$($crane digest "$IMAGE_PREFIX/$image:production" 2>/dev/null || true)
    echo "PREVIOUS_$image=$old" >> "$previous"
    log "$image: production $old -> $new ($sha)"
done

if ! sh "$here/night-window.sh"; then
    rm -f "$previous"
    exit 1
fi

for image in $CENTRAL_IMAGES; do
    $crane tag "$IMAGE_PREFIX/$image:$sha" production || exit 1
done
log "production now follows $sha"
