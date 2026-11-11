# The front web server: nginx with the TLS and maintenance-page configuration baked in, so that a stack needs no file of
# this repository on the Docker host. It is part of the central stack: a new build is deployed in the night window (ADR 0017).
#
# Build from the repository root:
#   docker build -f deploy/production/front/Dockerfile -t front .
FROM nginx:1.27-alpine

COPY deploy/production/front/front.conf /etc/nginx/conf.d/default.conf
COPY deploy/production/maintenance/index.html /usr/share/tele-meet/maintenance/maintenance.html

# The certificate and key are mounted at /etc/tele-meet/certs/cert.crt and cert.key.
HEALTHCHECK --interval=10s --timeout=3s --retries=3 CMD wget -q -O /dev/null http://127.0.0.1/front-health || exit 1
