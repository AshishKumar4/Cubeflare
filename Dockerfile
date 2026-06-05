FROM docker.io/cloudflare/sandbox:0.11.0

USER root
ARG TARGETARCH

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    curl \
    jq \
    netcat-openbsd \
    procps \
    unzip \
  && rm -rf /var/lib/apt/lists/*

RUN set -eux; \
  case "${TARGETARCH:-amd64}" in \
    amd64) java_arch="x64" ;; \
    arm64) java_arch="aarch64" ;; \
    *) echo "Unsupported architecture: ${TARGETARCH:-unknown}" >&2; exit 1 ;; \
  esac; \
  mkdir -p /opt/java; \
  curl -fsSL "https://api.adoptium.net/v3/binary/latest/25/ga/linux/${java_arch}/jre/hotspot/normal/eclipse?project=jdk" -o /tmp/java.tar.gz; \
  tar -xzf /tmp/java.tar.gz -C /opt/java --strip-components=1; \
  rm /tmp/java.tar.gz; \
  /opt/java/bin/java -version

COPY container/bin/ /opt/cubeflare/bin/
COPY container/plugins/ /opt/cubeflare/plugins/
RUN chmod +x /opt/cubeflare/bin/*

ENV JAVA_HOME="/opt/java"
ENV PATH="${JAVA_HOME}/bin:/opt/cubeflare/bin:${PATH}"
ENV JAVA_TOOL_OPTIONS=""
ENV CUBEFLARE_JAVA_RUNTIME="temurin-hotspot-25"

EXPOSE 3000
EXPOSE 8080
EXPOSE 8123
EXPOSE 25565
EXPOSE 25566
EXPOSE 25575
