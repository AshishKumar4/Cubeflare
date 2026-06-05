#!/usr/bin/env bash
set -euo pipefail

MANIFEST_PATH="${1:-${CUBEFLARE_MANIFEST_PATH:-/workspace/server/.cubeflare/manifest.json}}"

mkdir -p /workspace/server
cd /workspace/server

BRIDGE_PID=""
DYNMAP_PID=""
JAVA_PID=""

cleanup() {
  local pid
  for pid in "${JAVA_PID}" "${BRIDGE_PID}" "${DYNMAP_PID}"; do
    if [[ -n "${pid}" ]] && kill -0 "${pid}" 2>/dev/null; then
      kill "${pid}" 2>/dev/null || true
    fi
  done
}
trap cleanup EXIT INT TERM

if [[ -n "${CUBEFLARE_BRIDGE_PORT:-}" ]]; then
  /opt/cubeflare/bin/cubeflare-ws-bridge.mjs &
  BRIDGE_PID="$!"
fi

if [[ "${CUBEFLARE_DYNMAP_ENABLED:-false}" == "true" ]]; then
  /opt/cubeflare/bin/cubeflare-dynmap-sync.mjs &
  DYNMAP_PID="$!"
fi

/opt/cubeflare/bin/cubeflare-prepare-server.mjs "$MANIFEST_PATH"

MEMORY_MIN="${MEMORY_MIN:-11G}"
MEMORY_MAX="${MEMORY_MAX:-11G}"
SERVER_JAR="${SERVER_JAR:-/workspace/server/server.jar}"
JAVA_ARGS_FILE="${JAVA_ARGS_FILE:-/workspace/server/.cubeflare/java.args}"
JAVA_ARGS=()

if [[ -f "${JAVA_ARGS_FILE}" ]]; then
  while IFS= read -r arg; do
    [[ -n "${arg}" ]] && JAVA_ARGS+=("${arg}")
  done < "${JAVA_ARGS_FILE}"
fi

java \
  -Xms"${MEMORY_MIN}" \
  -Xmx"${MEMORY_MAX}" \
  "${JAVA_ARGS[@]}" \
  -Dcom.mojang.eula.agree=true \
  -jar "${SERVER_JAR}" nogui &
JAVA_PID="$!"
wait "${JAVA_PID}"
