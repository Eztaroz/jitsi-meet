# The web server image: docker-jitsi-meet's web image with this fork's web build (`make all`) and the nginx settings of
# this deployment baked in, so that a stack needs no file of this repository on the Docker host.
#
# Build from the repository root (it takes several minutes and about 4 GB of memory for webpack):
#   docker build -f deploy/production/web/Dockerfile -t web .
ARG JITSI_IMAGE_VERSION=stable

FROM node:24-bookworm AS build
WORKDIR /src
COPY . .
RUN npm ci
# The Makefile gives webpack 4 GB of heap itself.
RUN make all

FROM jitsi/web:${JITSI_IMAGE_VERSION}
# nginx locations of this deployment: patients' HNs with "/" (recorder-bot/deploy/README.md), the coordinator proxy
# (ADR 0008) and the waiting videos. The stock site template includes /config/nginx-custom/*.conf, but /config is a
# volume that a running stack keeps across upgrades, so add one more include whose directory is part of the image.
COPY recorder-bot/deploy/nginx/hn-rooms.conf coordinator/deploy/nginx/coordinator.conf deploy/production/nginx/videos.conf /etc/tele-meet/nginx/
RUN sed -i 's|^include /config/nginx-custom/\*\.conf;|&\ninclude /etc/tele-meet/nginx/*.conf;|' /defaults/meet.conf \
    && grep -q '^include /etc/tele-meet/nginx/' /defaults/meet.conf

# The fork's web build replaces the image's own. The bot pages are in static/.
COPY --from=build /src/index.html /src/base.html /src/body.html /src/fonts.html /src/head.html /src/plugin.head.html /src/title.html /src/manifest.json /src/pwa-worker.js /usr/share/jitsi-meet/
COPY --from=build /src/libs /usr/share/jitsi-meet/libs
COPY --from=build /src/css /usr/share/jitsi-meet/css
COPY --from=build /src/static /usr/share/jitsi-meet/static
COPY --from=build /src/images /usr/share/jitsi-meet/images
COPY --from=build /src/fonts /usr/share/jitsi-meet/fonts
COPY --from=build /src/lang /usr/share/jitsi-meet/lang
COPY --from=build /src/sounds /usr/share/jitsi-meet/sounds
