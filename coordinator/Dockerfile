# The coordinator service. Node.js 22.18 or later runs the TypeScript sources directly, and has SQLite built in, so the
# service has no dependencies to install.
FROM node:24-bookworm-slim

WORKDIR /app
COPY package.json ./
COPY src ./src

# The database. Mount a volume here so that encounters outlive the container.
RUN mkdir -p /var/lib/coordinator && chown node:node /var/lib/coordinator
ENV COORDINATOR_DATA_DIR=/var/lib/coordinator

USER node
ENV NODE_ENV=production
EXPOSE 8091
CMD ["node", "--disable-warning=ExperimentalWarning", "src/main.ts"]
