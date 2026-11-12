#!/bin/bash
# Installs a renewed TLS certificate for the deployment. The hospital's staff drop the renewed wildcard pair in
# doit's home under the same names as before; run this afterwards:
#
#   sudo ~/install-tls-cert.sh            check the new pair, install it, reload what serves it
#   sudo ~/install-tls-cert.sh --check    only check the new pair; change nothing
#
# It checks the pair before touching anything: the key matches the certificate, the file holds the chain, the chain
# verifies, the certificate is valid now and covers PUBLIC_HOST. A pair that fails a check is not installed, and what
# runs keeps the certificate it has. A pair identical to the installed one changes nothing.
#
# It copies the pair to TLS_DIR, where the stack's front web server and coturn read it (TLS_CERT_FILE and
# TLS_KEY_FILE in .env), keeping the previous copy in TLS_DIR/backup/. The key is owned by uid 65534 with mode 400:
# coturn runs as "nobody" and must read it; the front web server reads it as root.
#
# Then it reloads, without cutting a call: the front web server (nginx -s reload), coturn (SIGUSR2 re-reads its
# certificates), and, while the old Debian-package server still runs, its nginx (systemctl reload), which reads the
# pair in place in the home folder.
set -euo pipefail

SRC_CERT=${SRC_CERT:-/home/doit/star.medicine.psu.ac.th.crt}
SRC_KEY=${SRC_KEY:-/home/doit/star.medicine.psu.ac.th.key}
TLS_DIR=${TLS_DIR:-/etc/ssl/tele-meet}
PUBLIC_HOST=${PUBLIC_HOST:-tele-meet.medicine.psu.ac.th}
KEY_OWNER=${KEY_OWNER:-65534}
LOG=${LOG:-/var/log/tele-meet-tls-cert.log}
# RELOAD=0 installs without reloading anything (for testing the script).
RELOAD=${RELOAD:-1}
WARN_DAYS=30

CHECK_ONLY=0
case "${1:-}" in
    --check) CHECK_ONLY=1 ;;
    '') ;;
    *) echo "usage: $0 [--check]" >&2; exit 2 ;;
esac

log() {
    echo "$*"
    if [ "$CHECK_ONLY" = 0 ]; then
        echo "$(date -Is) $*" >> "$LOG"
    fi
}

fail() {
    log "FAILED: $*"
    log "nothing was installed; the running services keep the certificate they have"
    exit 1
}

if [ "$(id -u)" != 0 ]; then
    echo "run it as root: sudo $0 $*" >&2
    exit 1
fi

# --- Check the new pair ----------------------------------------------------------------------------------------

[ -s "$SRC_CERT" ] || fail "no certificate at $SRC_CERT"
[ -s "$SRC_KEY" ] || fail "no key at $SRC_KEY"

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

# Files saved on Windows may have CRLF line endings; openssl reads them, but keep a clean copy anyway.
tr -d '\r' < "$SRC_CERT" > "$WORK/fullchain.crt"
tr -d '\r' < "$SRC_KEY" > "$WORK/private.key"
chmod 600 "$WORK/private.key"

openssl x509 -in "$WORK/fullchain.crt" -noout 2>/dev/null || fail "$SRC_CERT is not a PEM certificate"
openssl pkey -in "$WORK/private.key" -passin pass: -noout 2>/dev/null \
    || fail "$SRC_KEY is not a PEM private key, or it is protected by a passphrase"

cert_pub=$(openssl x509 -in "$WORK/fullchain.crt" -noout -pubkey | sha256sum)
key_pub=$(openssl pkey -in "$WORK/private.key" -passin pass: -pubout | sha256sum)
[ "$cert_pub" = "$key_pub" ] || fail "the key does not belong to the certificate"

chain_count=$(grep -c 'BEGIN CERTIFICATE' "$WORK/fullchain.crt" || true)
[ "$chain_count" -ge 2 ] \
    || fail "the certificate file holds $chain_count certificate; it needs the full chain (the certificate, then the CA's intermediate)"

openssl verify -untrusted "$WORK/fullchain.crt" "$WORK/fullchain.crt" > /dev/null 2>&1 \
    || fail "the chain does not verify against the system's CA certificates"

openssl x509 -in "$WORK/fullchain.crt" -noout -checkhost "$PUBLIC_HOST" | grep -q 'does match' \
    || fail "the certificate does not cover $PUBLIC_HOST"

openssl x509 -in "$WORK/fullchain.crt" -noout -checkend 0 > /dev/null || fail "the certificate has expired"
not_before=$(date -d "$(openssl x509 -in "$WORK/fullchain.crt" -noout -startdate | cut -d= -f2)" +%s)
[ "$not_before" -le "$(date +%s)" ] || fail "the certificate is not valid yet"

subject=$(openssl x509 -in "$WORK/fullchain.crt" -noout -subject | sed 's/^subject= *//')
not_after=$(openssl x509 -in "$WORK/fullchain.crt" -noout -enddate | cut -d= -f2)
fingerprint=$(openssl x509 -in "$WORK/fullchain.crt" -noout -fingerprint -sha256 | cut -d= -f2)

log "new certificate: $subject, valid until $not_after"
if ! openssl x509 -in "$WORK/fullchain.crt" -noout -checkend $((WARN_DAYS * 86400)) > /dev/null; then
    log "WARNING: it expires within $WARN_DAYS days"
fi

if [ -e "$TLS_DIR/fullchain.crt" ]; then
    current_after=$(openssl x509 -in "$TLS_DIR/fullchain.crt" -noout -enddate | cut -d= -f2)
    log "installed certificate: valid until $current_after"
    if [ "$(date -d "$not_after" +%s)" -lt "$(date -d "$current_after" +%s)" ]; then
        fail "the new certificate expires before the installed one; is it an old file?"
    fi
    if cmp -s "$WORK/fullchain.crt" "$TLS_DIR/fullchain.crt" && cmp -s "$WORK/private.key" "$TLS_DIR/private.key"; then
        log "the new pair is already installed; nothing to do"
        exit 0
    fi
fi

if [ "$CHECK_ONLY" = 1 ]; then
    echo "the new pair passes every check; run it without --check to install it"
    exit 0
fi

# --- Install ---------------------------------------------------------------------------------------------------

install -d -m 755 -o root -g root "$TLS_DIR"
if [ -e "$TLS_DIR/fullchain.crt" ]; then
    backup="$TLS_DIR/backup/$(date +%Y%m%d-%H%M%S)"
    install -d -m 700 -o root -g root "$backup"
    cp -p "$TLS_DIR/fullchain.crt" "$TLS_DIR/private.key" "$backup/"
    log "previous pair kept in $backup"
fi

# Write next to the target, then rename: a reader never sees a half-written file.
install -m 644 -o root -g root "$WORK/fullchain.crt" "$TLS_DIR/.fullchain.crt.new"
install -m 400 -o "$KEY_OWNER" -g 0 "$WORK/private.key" "$TLS_DIR/.private.key.new"
mv -f "$TLS_DIR/.fullchain.crt.new" "$TLS_DIR/fullchain.crt"
mv -f "$TLS_DIR/.private.key.new" "$TLS_DIR/private.key"
log "installed in $TLS_DIR (sha256 fingerprint $fingerprint)"

# --- Reload what serves it -------------------------------------------------------------------------------------

reloaded=0
if [ "$RELOAD" != 1 ]; then
    log "RELOAD=$RELOAD: nothing reloaded"
    exit 0
fi
if command -v docker > /dev/null; then
    for id in $(docker ps -q --filter label=com.docker.compose.service=front); do
        if docker exec "$id" nginx -t > /dev/null 2>&1 && docker exec "$id" nginx -s reload; then
            log "reloaded the front web server ($(docker inspect -f '{{.Name}}' "$id"))"
            reloaded=1
        else
            log "WARNING: could not reload the front web server ($id); restart it in the night window"
        fi
    done
    for id in $(docker ps -q --filter label=com.docker.compose.service=coturn); do
        if docker kill -s USR2 "$id" > /dev/null; then
            log "asked coturn to re-read its certificates ($(docker inspect -f '{{.Name}}' "$id"))"
        else
            log "WARNING: could not signal coturn ($id); restart it"
        fi
    done
fi

# The old server's nginx reads the pair in place, in the home folder.
if systemctl is-active --quiet nginx 2>/dev/null; then
    if nginx -t > /dev/null 2>&1 && systemctl reload nginx; then
        log "reloaded the old server's nginx"
        reloaded=1
    else
        log "WARNING: the old server's nginx refused its configuration; it was not reloaded"
    fi
fi

# --- Verify ----------------------------------------------------------------------------------------------------

if [ "$reloaded" = 1 ]; then
    sleep 2
    served=$(echo | openssl s_client -connect 127.0.0.1:443 -servername "$PUBLIC_HOST" 2>/dev/null \
        | openssl x509 -noout -fingerprint -sha256 2>/dev/null | cut -d= -f2 || true)
    if [ "$served" = "$fingerprint" ]; then
        log "OK: port 443 serves the new certificate"
    else
        log "WARNING: port 443 serves ${served:-nothing} rather than the new certificate; check the web server"
    fi
else
    log "nothing serves the certificate yet; it is in place for when the stack starts"
fi
