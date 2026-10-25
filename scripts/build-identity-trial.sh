#!/usr/bin/env bash
set -euo pipefail
longball_root="$(cd "$(dirname "$0")/.." && pwd)"
longball_maven_image='maven:3.9.11-eclipse-temurin-21@sha256:6fdc855a6ed81d288ca7ca37ac6ff5e9308b612485c0801d70b25a858c83d237'
mkdir -p "$longball_root/.local/identity/maven-repository"
longball_ca_mount=()
if [ -n "${CODEX_PROXY_CERT:-}" ]; then
  test -f "$CODEX_PROXY_CERT"
  longball_ca_mount=(--mount "type=bind,src=$CODEX_PROXY_CERT,dst=/run/longball-proxy-ca.pem,readonly")
fi
env -u DOCKER_HOST -u DOCKER_CONTEXT -u DOCKER_TLS -u DOCKER_TLS_VERIFY -u DOCKER_CERT_PATH \
  docker --host=unix:///var/run/docker.sock run --rm --user "$(id -u):$(id -g)" \
  --mount "type=bind,src=$longball_root,dst=/work" "${longball_ca_mount[@]}" \
  --workdir /work --entrypoint bash "$longball_maven_image" -euo pipefail -c '
    if [ -f /run/longball-proxy-ca.pem ]; then
      cp "$JAVA_HOME/lib/security/cacerts" /tmp/longball-maven-cacerts
      keytool -importcert -noprompt -alias longball-session-proxy -file /run/longball-proxy-ca.pem -keystore /tmp/longball-maven-cacerts -storepass changeit >/dev/null
      export MAVEN_OPTS="${MAVEN_OPTS:-} -Djavax.net.ssl.trustStore=/tmp/longball-maven-cacerts -Djavax.net.ssl.trustStorePassword=changeit"
    fi
    if [ -n "${HTTPS_PROXY:-}" ]; then
      longball_proxy_endpoint="${HTTPS_PROXY##*@}"
      longball_proxy_endpoint="${longball_proxy_endpoint#*://}"
      longball_proxy_host="${longball_proxy_endpoint%:*}"
      longball_proxy_port="${longball_proxy_endpoint##*:}"
      export MAVEN_OPTS="${MAVEN_OPTS:-} -Dhttps.proxyHost=$longball_proxy_host -Dhttps.proxyPort=$longball_proxy_port -Dhttp.proxyHost=$longball_proxy_host -Dhttp.proxyPort=$longball_proxy_port -Dhttp.nonProxyHosts=localhost|127.*"
      cat > /tmp/longball-maven-settings.xml <<PROXY_SETTINGS
<settings><proxies><proxy><id>longball-session-proxy</id><active>true</active><protocol>http</protocol><host>$longball_proxy_host</host><port>$longball_proxy_port</port><nonProxyHosts>localhost|127.*</nonProxyHosts></proxy></proxies></settings>
PROXY_SETTINGS
    else
      printf "%s\n" "<settings/>" > /tmp/longball-maven-settings.xml
    fi
    mvn -B -ntp -s /tmp/longball-maven-settings.xml -Dmaven.repo.local=/work/.local/identity/maven-repository -f infra/identity/keycloak-extension/pom.xml verify
  '
