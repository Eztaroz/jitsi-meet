#!/bin/sh
# Checks what must be true before `docker compose up`: it changes nothing. Run it from anywhere on the host. See
# README.md. It exits with the number of problems it found.
set -u

cd "$(dirname "$0")/.."

problems=0

fail() {
    echo "FAIL: $*" >&2
    problems=$((problems + 1))
}

ok() {
    echo "ok:   $*"
}

if [ ! -f .env ]; then
    fail ".env is missing (scripts/generate-secrets.sh)"
    exit "$problems"
fi

# shellcheck disable=SC1091
set -a; . ./.env; set +a

if grep -q "CHANGE_ME" .env; then
    fail ".env still has CHANGE_ME values: $(grep -o '^[A-Z_]*=CHANGE_ME[A-Z_]*' .env | cut -d= -f1 | tr '\n' ' ')"
else
    ok ".env has no CHANGE_ME values"
fi

perm=$(stat -c %a .env 2>/dev/null || echo unknown)
[ "$perm" = 600 ] && ok ".env is 600" || fail ".env is $perm, not 600"

for file in "$TLS_CERT_FILE" "$TLS_KEY_FILE"; do
    [ -r "$file" ] && ok "$file is readable" || fail "$file is not readable"
done

if [ -r "$TLS_KEY_FILE" ]; then
    perm=$(stat -c %a "$TLS_KEY_FILE" 2>/dev/null || echo unknown)
    case "$perm" in
        600|400) ok "the TLS key is $perm" ;;
        *) fail "the TLS key is $perm: nobody but root reads it (chmod 600)" ;;
    esac
fi

if [ -r "$TLS_CERT_FILE" ]; then
    if openssl x509 -in "$TLS_CERT_FILE" -noout -checkend 2592000 >/dev/null 2>&1; then
        ok "the TLS certificate is valid for 30 more days"
    else
        fail "the TLS certificate expires within 30 days, or has expired: $(openssl x509 -in "$TLS_CERT_FILE" -noout -enddate 2>&1)"
    fi
fi

[ -f keys/coordinator-private/private.pem ] && ok "the coordinator's private key exists" ||
    fail "the coordinator's key pair is missing (scripts/generate-keys.sh)"

kid=${COORDINATOR_SIGNING_KID:-coordinator/key-1}
name=$(printf %s "$kid" | sha256sum | cut -d' ' -f1)
for dir in keys/asap keys/coordinator-public; do
    [ -f "$dir/$name.pem" ] && ok "$dir has the coordinator's public key" || fail "$dir/$name.pem is missing"
done

issuer_keys=$(find keys/asap -name '*.pem' ! -name "$name.pem" 2>/dev/null | wc -l)
[ "$issuer_keys" -gt 0 ] && ok "keys/asap has $issuer_keys issuer key(s)" ||
    fail "keys/asap has no hospital issuer key (scripts/publish-issuer-key.sh)"

if grep -l "PRIVATE KEY" keys/asap/*.pem keys/coordinator-public/*.pem >/dev/null 2>&1; then
    fail "a PRIVATE key is among the published keys"
fi

[ -f coordinator/rooms.json ] && ok "coordinator/rooms.json exists" ||
    fail "coordinator/rooms.json is missing (copy coordinator/rooms.example.json and edit it)"

[ -f coturn/turnserver.conf ] && ok "coturn/turnserver.conf exists" ||
    fail "coturn/turnserver.conf is missing (scripts/generate-secrets.sh)"

if [ -d "$RECORDER_BOT_STORAGE_ROOT" ]; then
    [ -f "$RECORDER_BOT_STORAGE_ROOT/.recorder-bot-storage-root" ] && ok "the storage root has its marker" ||
        fail "$RECORDER_BOT_STORAGE_ROOT has no .recorder-bot-storage-root (create it on the mounted share)"
    if mountpoint -q "$RECORDER_BOT_STORAGE_ROOT" 2>/dev/null; then
        ok "$RECORDER_BOT_STORAGE_ROOT is a mount point"
    else
        fail "$RECORDER_BOT_STORAGE_ROOT is not a mount point: the share is not mounted"
    fi
else
    fail "$RECORDER_BOT_STORAGE_ROOT does not exist"
fi

for dir in ../../libs ../../static; do
    [ -d "$dir" ] && ok "web build: $dir" || fail "$dir is missing: run \`make all\` in the repository root"
done
[ -f ../../libs/app.bundle.min.js ] && ok "web build: app.bundle.min.js" ||
    fail "../../libs/app.bundle.min.js is missing: run \`make all\` in the repository root"

videos=$(find videos -type f ! -name .gitkeep 2>/dev/null | wc -l)
[ "$videos" -gt 0 ] && ok "videos: $videos file(s)" || fail "videos/ is empty: the waiting videos are in rooms.json"

command -v docker >/dev/null 2>&1 && docker compose config -q >/dev/null 2>&1 && ok "docker compose config is valid" ||
    fail "docker compose config failed (docker missing, or the compose file or .env is wrong)"

echo
[ "$problems" -eq 0 ] && echo "ready" || echo "$problems problem(s)"
exit "$problems"
