# syntax=docker/dockerfile:1
FROM node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df AS heic-compiler
WORKDIR /src
RUN --mount=type=secret,id=proxy_ca \
    apt-get -o Acquire::https::CaInfo=/run/secrets/proxy_ca update && \
    apt-get -o Acquire::https::CaInfo=/run/secrets/proxy_ca install -y --no-install-recommends g++ make cmake curl ca-certificates pkg-config && \
    rm -rf /var/lib/apt/lists/*
COPY infra/runtime/heic/build.sh ./
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export CURL_CA_BUNDLE=/run/secrets/proxy_ca; fi; \
    sh /src/build.sh
COPY infra/runtime/heic/decode.c ./
COPY infra/runtime/heic/NOTICE.md ./
RUN mkdir -p /opt/longball-heic/bin && \
    cc -O2 -Wall -Wextra -Werror -I/opt/longball-heic/include /src/decode.c -L/opt/longball-heic/lib -lheif -Wl,--disable-new-dtags,-rpath,'$ORIGIN/../lib' -o /opt/longball-heic/bin/longball-heic && \
    mkdir -p /opt/longball-heic/share/sources /opt/longball-heic/share/licenses && \
    cp /src/libheif.tar.gz /src/libde265.tar.gz /src/build.sh /src/decode.c /src/NOTICE.md /opt/longball-heic/share/sources/ && \
    cp /src/libheif-1.23.6/COPYING /opt/longball-heic/share/licenses/libheif-COPYING && \
    cp /src/libde265-1.1.3/COPYING /opt/longball-heic/share/licenses/libde265-COPYING && \
    cp /src/libde265-1.1.3/libde265/COPYING /opt/longball-heic/share/licenses/libde265-library-COPYING && \
    chmod -R a+rX /opt/longball-heic/share && \
    rm -rf /opt/longball-heic/include /opt/longball-heic/lib/cmake /opt/longball-heic/lib/pkgconfig /opt/longball-heic/lib/*.a

FROM scratch AS heic-helper
COPY --from=heic-compiler /opt/longball-heic/ /

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
ENV LONGBALL_HEIC_DECODER_FILE=/opt/longball-heic/bin/longball-heic
COPY --chmod=0644 infra/runtime/backend/package*.json ./
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    npm ci --omit=dev --strict-ssl=true --no-audit --no-fund && \
    mkdir -p /data/media && chown -R node:node /data
COPY --from=compiler --chown=node:node /app/release/ /app/
COPY --from=heic-compiler /opt/longball-heic/ /opt/longball-heic/
USER node
EXPOSE 4310
CMD ["node", "backend/api.mjs"]
