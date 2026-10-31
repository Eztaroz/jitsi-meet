# The recorder bot service. Playwright's image carries the Chromium build that playwright-core drives, and a Node.js
# recent enough to run the TypeScript sources directly.
FROM mcr.microsoft.com/playwright:v1.63.0-noble

# ffmpeg remuxes each recording into its final file.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
# Behind a TLS-inspecting proxy, pass its CA certificate as the build secret "npm_ca":
#   docker build --secret id=npm_ca,src=<proxy CA bundle> .
RUN --mount=type=secret,id=npm_ca,required=false \
    if [ -f /run/secrets/npm_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/npm_ca; fi \
    && npm ci --omit=dev --ignore-scripts \
    && npm cache clean --force
COPY src ./src

# The spool, where consultations are recorded and finalised before they move to the evidence storage root. Mount a
# volume here so that it outlives the container.
RUN mkdir -p /var/lib/recorder-bot/spool && chown pwuser:pwuser /var/lib/recorder-bot/spool
ENV RECORDER_BOT_SPOOL_DIR=/var/lib/recorder-bot/spool

USER pwuser
ENV NODE_ENV=production
EXPOSE 8090
CMD ["node", "src/main.ts"]
