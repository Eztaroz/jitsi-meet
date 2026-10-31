#!/bin/sh
# Generates the key pair the JWT variant of the test deployment signs and verifies participants' tokens with: the
# private key for the tests (jwt/private.pem), and the public key where Prosody fetches it, under the name it looks
# for, the SHA-256 of the key id (jwt/asap/). See README.md.
set -eu

KID=recorder-bot-test/jwt
cd "$(dirname "$0")"

if [ -e private.pem ]; then
    echo "jwt/private.pem exists; delete it and jwt/asap/ to generate new keys" >&2
    exit 1
fi

mkdir -p asap
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out private.pem 2>/dev/null
openssl pkey -in private.pem -pubout -out "asap/$(printf %s "$KID" | sha256sum | cut -d' ' -f1).pem"
# nginx in the web container serves the public key.
chmod 644 asap/*.pem
echo "generated the keys of $KID"
