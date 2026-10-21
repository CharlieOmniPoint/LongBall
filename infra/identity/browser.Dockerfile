# syntax=docker/dockerfile:1
# Isolated local browser proof only; no provider credentials or local CA enter image layers.
FROM node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df
RUN --mount=type=secret,id=proxy_ca \
    node -e "require('fs').writeFileSync('/tmp/longball-build-ca.crt', require('tls').rootCertificates.join('\n') + '\n')" && \
    if [ -f /run/secrets/proxy_ca ]; then cat /run/secrets/proxy_ca >> /tmp/longball-build-ca.crt; fi && \
    sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources && \
    apt-get -o Acquire::https::CaInfo=/tmp/longball-build-ca.crt update && \
    apt-get -o Acquire::https::CaInfo=/tmp/longball-build-ca.crt install -y --no-install-recommends chromium libnss3-tools ca-certificates && \
    rm -rf /var/lib/apt/lists/* /tmp/longball-build-ca.crt
WORKDIR /work
CMD ["node", "--version"]
