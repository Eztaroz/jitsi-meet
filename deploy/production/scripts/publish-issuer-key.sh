#!/bin/sh
# Publishes a public key of the hospital's token issuer, under the name Prosody and the coordinator service look for,
# the SHA-256 of the key id, in keys/asap/. Usage:
#
#   scripts/publish-issuer-key.sh <key id> <public key PEM file>
#
# The key id is the "kid" in the header of the tokens the issuer signs with that key. Publishing a key lets whoever holds
# the private key sign tokens for any room: publish only what the issuer's owner gave you, and check its fingerprint
# with them. To rotate, publish the new key beside the old, move the issuer to it, then delete the old file.
set -eu

if [ "$#" -ne 2 ]; then
    echo "usage: $0 <key id> <public key PEM file>" >&2
    exit 2
fi

KID=$1
PUBLIC_KEY=$2

cd "$(dirname "$0")/.."

# Only a public RSA key: a PEM with a private key in it must never reach the key server.
if grep -q "PRIVATE KEY" "$PUBLIC_KEY"; then
    echo "$PUBLIC_KEY holds a private key; publish the public key only" >&2
    exit 1
fi
if ! openssl pkey -pubin -in "$PUBLIC_KEY" -noout 2>/dev/null; then
    echo "$PUBLIC_KEY is not a PEM public key" >&2
    exit 1
fi

NAME=$(printf %s "$KID" | sha256sum | cut -d' ' -f1)

mkdir -p keys/asap
openssl pkey -pubin -in "$PUBLIC_KEY" -pubout -out "keys/asap/$NAME.pem"
chmod 644 "keys/asap/$NAME.pem"

echo "published $KID as keys/asap/$NAME.pem; fingerprint:"
openssl pkey -pubin -in "keys/asap/$NAME.pem" -outform DER | sha256sum | cut -d' ' -f1
