# syntax=docker/dockerfile:1.7
FROM node:26-bookworm-slim AS production-dependencies

WORKDIR /workspace
RUN npm install --global pnpm@11.1.3
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/mdns/package.json ./packages/mdns/package.json
RUN pnpm install --prod --frozen-lockfile

FROM node:26-bookworm-slim AS build

WORKDIR /workspace
RUN npm install --global pnpm@11.1.3
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm build

FROM node:26-bookworm-slim AS runtime

ARG TARGETARCH
LABEL org.opencontainers.image.title="deploy.local suitcase core" \
      org.opencontainers.image.description="Portable deploy.local control plane for Docker targets" \
      deploy.local.runtime.protocol="1"

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl docker.io openssl \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/deploy.local
COPY --from=build /workspace/package.json ./package.json
COPY --from=production-dependencies /workspace/node_modules ./node_modules
COPY --from=build /workspace/packages ./packages
COPY --from=build /workspace/dist ./dist
COPY --from=build /workspace/drizzle ./drizzle
COPY docker/suitcase/core-entrypoint.sh /usr/local/bin/suitcase-entrypoint
COPY docker/suitcase/core-healthcheck.sh /usr/local/bin/suitcase-healthcheck
RUN chmod 0755 /usr/local/bin/suitcase-entrypoint /usr/local/bin/suitcase-healthcheck \
  && mkdir -p /var/lib/deploy.local/content /var/lib/deploy.local/build-cache

ENV NODE_ENV=production \
    DEPLOY_ROLE=single \
    DEPLOY_SUITCASE=1 \
    DEPLOY_SUITCASE_RUNTIME_PROTOCOL=1 \
    DEPLOY_DATA_DIR=/var/lib/deploy.local \
    PORT=80 \
    HTTPS_PORT=443

VOLUME ["/var/lib/deploy.local"]
EXPOSE 80 443
HEALTHCHECK --interval=10s --timeout=3s --start-period=30s --retries=12 \
  CMD ["/usr/local/bin/suitcase-healthcheck"]
ENTRYPOINT ["/usr/local/bin/suitcase-entrypoint"]
