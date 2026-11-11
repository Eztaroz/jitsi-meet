#!/bin/sh
# Tests of the night deployment's scripts (ci/*.sh) against local fake servers and a fake crane: no registry, no Portainer,
# nothing of production. Needs sh, curl and node. Run: deploy/production/scripts/test/run-tests.sh
here=$(cd "$(dirname "$0")" && pwd)
ci="$here/../ci"
work=$(mktemp -d)
pids=""
failures=0
count=0
trap 'kill $pids 2>/dev/null; rm -rf "$work"' EXIT INT TERM

# Fast polling, so that a deployment that never gets healthy fails in seconds.
export HEALTH_TIMEOUT=3 HEALTH_INTERVAL=1 SKIP_REGISTRY_LOGIN=1 NIGHT_WINDOW_UTC_HOUR=16

check() {
    count=$((count + 1))
    if [ "$2" = "$3" ]; then
        echo "ok   $1"
    else
        failures=$((failures + 1))
        echo "FAIL $1 (expected '$3', got '$2')"
    fi
}

contains() {
    count=$((count + 1))
    if printf '%s' "$2" | grep -q -- "$3"; then
        echo "ok   $1"
    else
        failures=$((failures + 1))
        echo "FAIL $1 (no '$3' in: $2)"
    fi
}

port=18400
# start_stack <name> [VAR=value...]: a fake central stack on a new port, exported as TEST_* for the scripts.
start_stack() {
    port=$((port + 1))
    env PORT=$port "$@" node "$here/fake-central.mjs" &
    pids="$pids $!"
    for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
        curl -s -o /dev/null "http://127.0.0.1:$port/front-health" && break
        sleep 0.25
    done
    export TEST_URL="http://127.0.0.1:$port" TEST_COORDINATOR_SECRET=test-secret
    export TEST_JICOFO_HEALTH_URL="http://127.0.0.1:$port/jicofo-health" TEST_JVB_HEALTH_URL="http://127.0.0.1:$port/jvb-health"
    export TEST_WEBHOOK="http://127.0.0.1:$port/hook"
}

run() { out=$(sh "$@" 2>&1); code=$?; }
hooks() { curl -s "http://127.0.0.1:$port/hook-count"; }

echo "== the night window"
for case in "15 0" "21 0" "16 0" "22 1" "14 1" "3 1" "23 1" "0 1"; do
    set -- $case
    NIGHT_WINDOW_UTC_HOUR=$1 run "$ci/night-window.sh"
    # UTC 15 is 22:00 in Bangkok, UTC 21 is 04:00, UTC 22 is 05:00 (closed), UTC 14 is 21:00 (closed)
    check "UTC hour $1 -> exit $2" "$code" "$2"
done
NIGHT_WINDOW_UTC_HOUR=22 run "$ci/night-window.sh"
contains "a closed window says why" "$out" "outside 22:00-05:00"

echo "== the health checks"
start_stack
run "$ci/central-health.sh" TEST
check "a healthy stack passes" "$code" 0
for name in "coordinator health" "coordinator holds the lock" "front web server" "web page" "web configuration" "Prosody" "Jicofo" "videobridge" "open rooms"; do
    contains "reports: $name" "$out" "ok.*$name"
done

for case in "standby:coordinator holds the lock" "rooms:open rooms" "front:front web server" "web:web page" "config:web configuration" "prosody:Prosody" "jicofo:Jicofo" "jvb:videobridge"; do
    broken=${case%%:*}
    expect=${case#*:}
    start_stack BROKEN=$broken
    run "$ci/central-health.sh" TEST
    check "$broken broken -> unhealthy" "$code" 1
    contains "$broken broken -> names the failing check" "$out" "FAIL.*$expect"
done

start_stack BROKEN=web,jvb HEAL_AFTER_MS=1500
run "$ci/central-health.sh" TEST
check "a stack that heals within the timeout passes" "$code" 0

start_stack BROKEN=jvb
HEALTH_TIMEOUT=2 run "$ci/central-health.sh" TEST
check "a stack that never heals fails after the timeout" "$code" 1

start_stack
TEST_JICOFO_HEALTH_URL= run "$ci/central-health.sh" TEST
check "an unconfigured check fails, it is never skipped" "$code" 1
contains "says what is missing" "$out" "TEST_JICOFO_HEALTH_URL"

TEST_COORDINATOR_SECRET=wrong run "$ci/central-health.sh" TEST
check "a wrong coordinator secret fails" "$code" 1

echo "== redeploying one stack"
start_stack
run "$ci/redeploy-central.sh" TEST
check "a healthy redeploy passes" "$code" 0
check "it called the webhook once" "$(hooks)" 1

start_stack
NIGHT_WINDOW_UTC_HOUR=3 run "$ci/redeploy-central.sh" TEST
check "outside the window nothing is redeployed" "$code" 1
check "the webhook was not called" "$(hooks)" 0
NIGHT_WINDOW_UTC_HOUR=3 NIGHT_WINDOW_CHECK=0 run "$ci/redeploy-central.sh" TEST
check "by hand, outside the window, it is redeployed" "$code" 0
check "the webhook was called" "$(hooks)" 1

TEST_WEBHOOK= run "$ci/redeploy-central.sh" TEST
check "without a webhook the deploy is skipped" "$code" 0

start_stack BROKEN=jvb
run "$ci/redeploy-central.sh" TEST
check "an unhealthy redeploy fails" "$code" 1
check "the webhook was still called once" "$(hooks)" 1

echo "== moving the production tag"
export FAKE_REGISTRY="$work/registry" CRANE="$here/fake-crane.sh" IMAGE_PREFIX=registry.test/tele PREVIOUS_FILE="$work/previous.env"
export CI_COMMIT_SHA=abcdef0123456789 PRODUCTION_WEBHOOK=http://unused
reset_registry() {
    rm -rf "$FAKE_REGISTRY" "$PREVIOUS_FILE"
    mkdir -p "$FAKE_REGISTRY/tags"
    for image in coordinator prosody web front; do
        echo "sha256:old-$image" > "$FAKE_REGISTRY/tags/registry.test_tele_$image""_production"
        echo "sha256:new-$image" > "$FAKE_REGISTRY/tags/registry.test_tele_$image""_abcdef01"
    done
}
production() { cat "$FAKE_REGISTRY/tags/registry.test_tele_$1_production"; }

reset_registry
run "$ci/promote-central.sh"
check "promote passes in the window" "$code" 0
for image in coordinator prosody web front; do
    check "$image production moved to the build" "$(production $image)" "sha256:new-$image"
done
contains "the previous build is remembered" "$(cat "$PREVIOUS_FILE")" "PREVIOUS_coordinator=sha256:old-coordinator"

reset_registry
NIGHT_WINDOW_UTC_HOUR=3 run "$ci/promote-central.sh"
check "promote outside the window fails" "$code" 1
check "and moves nothing" "$(production coordinator)" "sha256:old-coordinator"

reset_registry
rm "$FAKE_REGISTRY/tags/registry.test_tele_front_abcdef01"
run "$ci/promote-central.sh"
check "promote fails when an image of the build is missing" "$code" 1
check "and moves nothing, not even the others" "$(production coordinator)" "sha256:old-coordinator"

reset_registry
PRODUCTION_WEBHOOK= run "$ci/promote-central.sh"
check "without a production webhook promote is skipped" "$code" 0
check "and moves nothing" "$(production coordinator)" "sha256:old-coordinator"

echo "== rolling back"
reset_registry
run "$ci/rollback-central.sh"
check "with nothing promoted, rollback does nothing" "$code" 0

run "$ci/promote-central.sh"
run "$ci/rollback-central.sh"
check "rollback passes" "$code" 0
for image in coordinator prosody web front; do
    check "$image production is back on the previous build" "$(production $image)" "sha256:old-$image"
done
NIGHT_WINDOW_UTC_HOUR=3 run "$ci/rollback-central.sh"
check "a rollback is allowed outside the window" "$code" 0

echo "== a bad build, end to end"
reset_registry
start_stack BROKEN=jvb
export PRODUCTION_URL=$TEST_URL PRODUCTION_COORDINATOR_SECRET=test-secret PRODUCTION_JICOFO_HEALTH_URL=$TEST_JICOFO_HEALTH_URL PRODUCTION_JVB_HEALTH_URL=$TEST_JVB_HEALTH_URL PRODUCTION_WEBHOOK=$TEST_WEBHOOK
run "$ci/promote-central.sh"
run "$ci/redeploy-central.sh" PRODUCTION
check "the bad build is not healthy" "$code" 1
run "$ci/rollback-central.sh"
check "production is back on the previous build" "$(production web)" "sha256:old-web"
good_url=$TEST_URL
start_stack
export PRODUCTION_URL=$TEST_URL PRODUCTION_COORDINATOR_SECRET=test-secret PRODUCTION_JICOFO_HEALTH_URL=$TEST_JICOFO_HEALTH_URL PRODUCTION_JVB_HEALTH_URL=$TEST_JVB_HEALTH_URL PRODUCTION_WEBHOOK=$TEST_WEBHOOK
NIGHT_WINDOW_CHECK=0 run "$ci/redeploy-central.sh" PRODUCTION
check "the rollback's redeploy is healthy" "$code" 0

echo
echo "$((count - failures)) of $count passed"
[ "$failures" -eq 0 ]
