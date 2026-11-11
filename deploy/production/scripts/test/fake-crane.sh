#!/bin/sh
# A fake `crane` for the tests of ../ci/*.sh. The registry is a directory ($FAKE_REGISTRY): one file per image:tag that
# holds the digest. Every call is appended to $FAKE_REGISTRY/calls.log.
echo "$*" >> "$FAKE_REGISTRY/calls.log"
file() { echo "$FAKE_REGISTRY/tags/$(echo "$1" | tr '/:' '__')"; }
case "$1" in
    digest)
        [ -f "$(file "$2")" ] && cat "$(file "$2")" || exit 1
        ;;
    tag)
        ref="$2"
        case "$ref" in
            *@sha256:*) digest="${ref#*@}"; repo="${ref%@*}" ;;
            *) digest=$(cat "$(file "$ref")") || exit 1; repo="${ref%:*}" ;;
        esac
        echo "$digest" > "$(file "$repo:$3")"
        ;;
    *) exit 2 ;;
esac
