# The video player service. Playwright's image carries the Chromium build that playwright-core drives, and a Node.js
# recent enough to run the TypeScript sources directly.
FROM mcr.microsoft.com/playwright:v1.63.0-noble

WORKDIR /app
COPY package.json package-lock.json ./
# Behind a TLS-inspecting proxy, pass its CA certificate as the build secret "npm_ca":
#   docker build --secret id=npm_ca,src=<proxy CA bundle> .
RUN --mount=type=secret,id=npm_ca,required=false \
    if [ -f /run/secrets/npm_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/npm_ca; fi \
    && npm ci --omit=dev --ignore-scripts \
    && npm cache clean --force
COPY src ./src

USER pwuser
# The commit this image is built from, which the worker reports in its heartbeat (ADR 0017); the pipeline passes it.
ARG BUILD=unknown
ENV VIDEO_PLAYER_BUILD=$BUILD
ENV NODE_ENV=production
EXPOSE 8091
CMD ["node", "src/main.ts"]
