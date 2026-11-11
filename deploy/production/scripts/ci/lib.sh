# Shared by the night deployment's scripts (sourced, POSIX sh). They run in the pipeline's small images (curlimages/curl,
# the crane image), which have busybox and no tzdata, so nothing here needs bash, jq or a time zone database.

# The images the central stack builds (the Jitsi images jicofo and jvb are upstream's, pinned by JITSI_IMAGE_VERSION).
CENTRAL_IMAGES=${CENTRAL_IMAGES:-"coordinator prosody web front"}

log() { echo "$*"; }

# value <NAME>: the value of the variable whose name is in $1 (empty when unset).
value() { eval "printf '%s' \"\${$1:-}\""; }

# require <NAME>...: stops when one of the variables is empty, naming it.
require() {
    for name in "$@"; do
        if [ -z "$(value "$name")" ]; then
            log "ERROR: $name is empty: set the CI/CD variable"
            exit 1
        fi
    done
}

# short_sha: the 8 characters the images are tagged with (the image-* jobs in .gitlab-ci.yml).
short_sha() { printf '%s' "$CI_COMMIT_SHA" | cut -c1-8; }

# registry_login: gives crane the registry's credentials, as the kaniko jobs do. The tests skip it.
registry_login() {
    [ "${SKIP_REGISTRY_LOGIN:-}" = 1 ] && return 0
    require REGISTRY REGISTRY_AUTH
    mkdir -p "${DOCKER_CONFIG:-$HOME/.docker}"
    echo "{\"auths\":{\"$REGISTRY\":{\"auth\":\"$REGISTRY_AUTH\"}}}" > "${DOCKER_CONFIG:-$HOME/.docker}/config.json"
}
