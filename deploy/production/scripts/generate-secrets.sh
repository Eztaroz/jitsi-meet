#!/bin/sh
# Makes .env from .env.example, with a random value for every secret, and renders coturn/turnserver.conf from its
# template with the same TURN secret. It refuses to overwrite an existing .env: the secrets must stay the same once the
# deployment has run (the passwords are in Prosody's accounts and the services' databases). See README.md.
set -eu

cd "$(dirname "$0")/.."

if [ -e .env ]; then
    echo ".env exists; delete it first only if you mean to replace every secret" >&2
    exit 1
fi

random() {
    openssl rand -hex 24
}

# Only the lines whose value is exactly CHANGE_ME are secrets; the other CHANGE_ME_* values are for you to set.
while IFS= read -r line; do
    case "$line" in
        *=CHANGE_ME) printf '%s=%s\n' "${line%%=*}" "$(random)" ;;
        *) printf '%s\n' "$line" ;;
    esac
done < .env.example > .env
chmod 600 .env

# shellcheck disable=SC1091
set -a; . ./.env; set +a

sed -e "s|@TURN_CREDENTIALS@|$TURN_CREDENTIALS|" \
    -e "s|@PUBLIC_HOST@|$PUBLIC_HOST|" \
    -e "s|@EXTERNAL_IP@|$EXTERNAL_IP|" \
    coturn/turnserver.conf.template > coturn/turnserver.conf
chmod 600 coturn/turnserver.conf

echo "made .env and coturn/turnserver.conf; now set the CHANGE_ME_* values in .env"
