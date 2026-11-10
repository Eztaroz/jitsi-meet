#!/bin/sh
# Generates the coordinator service's key pair: the private key it signs the tokens for a move with
# (keys/coordinator-private/private.pem), and the public key where Prosody fetches it, under the name it looks for, the
# SHA-256 of the key id: in keys/coordinator-public/ for the coordinator API module, and in keys/asap/ for the
# participants' token verification, which accepts the coordinator's tokens (ADR 0009). See README.md.
#
# The hospital issuer's own key pair is made by the system that issues the tokens, never here: give it the key id and
# publish its public key with scripts/publish-issuer-key.sh.
set -eu

cd "$(dirname "$0")/.."

KID=${COORDINATOR_SIGNING_KID:-coordinator/key-1}
NAME=$(printf %s "$KID" | sha256sum | cut -d' ' -f1)

if [ -e keys/coordinator-private/private.pem ]; then
    echo "keys/coordinator-private/private.pem exists; delete it and its public keys to generate new ones" >&2
    exit 1
fi

mkdir -p keys/coordinator-private keys/coordinator-public keys/asap
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out keys/coordinator-private/private.pem 2>/dev/null
openssl pkey -in keys/coordinator-private/private.pem -pubout -out "keys/coordinator-public/$NAME.pem"
cp "keys/coordinator-public/$NAME.pem" "keys/asap/$NAME.pem"

# The web server serves the public keys, to Prosody and nothing more; the private key is the service's alone. The
# service runs as the image's "node" user (uid 1000): whoever holds this key can join any room, so nobody else reads it.
chmod 644 "keys/coordinator-public/$NAME.pem" "keys/asap/$NAME.pem"
chmod 700 keys/coordinator-private
chmod 600 keys/coordinator-private/private.pem
if [ "$(id -u)" = 0 ]; then
    chown 1000:1000 keys/coordinator-private keys/coordinator-private/private.pem
else
    echo "run as root, or: sudo chown 1000:1000 keys/coordinator-private keys/coordinator-private/private.pem" >&2
fi

echo "generated the keys of $KID (public key: $NAME.pem)"
