# syntax=docker/dockerfile:1
FROM node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df AS compiler
WORKDIR /app
COPY infra/runtime/compiler/package*.json ./
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    npm ci --strict-ssl=true --no-audit --no-fund
# The Dockerfile-specific allowlist sends only source/manifests, never .local,
# credentials, native SDKs, node_modules or unrelated build outputs.
COPY . .
RUN node scripts/build-api.mjs && \
    mkdir -p release/backend release/migrations/postgresql && \
    cp apps/api/dist/*.mjs release/backend/ && \
    cp apps/api/migrations/postgresql/*.sql release/migrations/postgresql/

FROM node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --chmod=0644 infra/runtime/backend/package*.json ./
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    npm ci --omit=dev --strict-ssl=true --no-audit --no-fund && \
    mkdir -p /data/media && chown -R node:node /data
COPY --from=compiler --chown=node:node /app/release/ /app/
USER node
EXPOSE 4310
CMD ["node", "backend/api.mjs"]
