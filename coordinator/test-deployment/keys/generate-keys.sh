#!/bin/sh
# Generates the key pair the coordinator service signs its tokens with: the private key for the service
# (keys/private.pem), and the public key where Prosody fetches it, under the name it looks for, the SHA-256 of the key
# id (keys/asap/). See README.md.
set -eu

KID=coordinator-test/key
cd "$(dirname "$0")"

if [ -e private.pem ]; then
    echo "keys/private.pem exists; delete it and keys/asap/ to generate new keys" >&2
    exit 1
fi

mkdir -p asap
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out private.pem 2>/dev/null
openssl pkey -in private.pem -pubout -out "asap/$(printf %s "$KID" | sha256sum | cut -d' ' -f1).pem"
# nginx in the web container serves the public key; the service runs as a user of its own and reads the private key.
chmod 644 asap/*.pem private.pem
echo "generated the keys of $KID"
