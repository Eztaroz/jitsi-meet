#!/bin/sh
# Makes the two short waiting videos the video player tests play. WebM (VP8 and Opus), because the Chromium the video
# player drives has no H.264. The web server serves this folder at /videos/.
set -e
cd "$(dirname "$0")"
for name in intro second; do
    [ -f "$name.webm" ] || ffmpeg -loglevel error -f lavfi -i "testsrc=duration=20:size=320x240:rate=15" \
        -f lavfi -i "sine=frequency=440:duration=20" -c:v libvpx -b:v 200k -c:a libopus -shortest "$name.webm"
done
