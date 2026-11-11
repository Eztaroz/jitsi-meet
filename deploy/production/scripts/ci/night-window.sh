#!/bin/sh
# Exits 0 inside the night window (22:00 to 05:00, Bangkok time, ADR 0017) and 1 outside it. The central services restart
# only inside it, except a deployment started by hand.
# Bangkok has no daylight saving: it is UTC+7. The pipeline's image has no time zone database, so the hour is computed.
# NIGHT_WINDOW_UTC_HOUR replaces the clock, for the tests.
utc_hour=$(printf '%s' "${NIGHT_WINDOW_UTC_HOUR:-$(date -u +%H)}" | sed 's/^0*\(.\)/\1/')
local_hour=$(( (utc_hour + ${NIGHT_WINDOW_UTC_OFFSET:-7}) % 24 ))

if [ "$local_hour" -ge 22 ] || [ "$local_hour" -lt 5 ]; then
    echo "It is $local_hour:00 in Bangkok: inside the night window (22:00-05:00)"
    exit 0
fi
echo "It is $local_hour:00 in Bangkok: outside 22:00-05:00, the central services are not deployed now"
exit 1
