# The coordinator service. Node.js 22.18 or later runs the TypeScript sources directly, and has SQLite built in. Its one
# dependency is the MariaDB driver, which keeps the state in the hospital's MariaDB when the deployment sets one (ADR 0015).
FROM node:24-bookworm-slim

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src

# The SQLite database, for a deployment that does not set a MariaDB. Mount a volume here so that encounters outlive the
# container.
RUN mkdir -p /var/lib/coordinator && chown node:node /var/lib/coordinator
ENV COORDINATOR_DATA_DIR=/var/lib/coordinator

USER node
ENV NODE_ENV=production
EXPOSE 8091
CMD ["node", "--disable-warning=ExperimentalWarning", "src/main.ts"]
