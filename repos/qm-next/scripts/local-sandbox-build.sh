#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

BASE_TAG="qm-sandbox-base:dev"
LOCAL_TAG="${LOCAL_SANDBOX_IMAGE:-qm-sandbox-local:latest}"
PLATFORM="${LOCAL_SANDBOX_PLATFORM:-}"
DIST_DIR=".sandbox-build"
GH_VERSION="2.93.0"
AWSCLI_VERSION="2.34.54"

HOST_ARCH="$(uname -m)"
case "$HOST_ARCH" in
  arm64|aarch64) GH_ARCH=arm64; AWS_ARCH=aarch64 ;;
  x86_64) GH_ARCH=amd64; AWS_ARCH=x86_64 ;;
  *) echo "unsupported host arch: $HOST_ARCH" >&2; exit 1 ;;
esac

mkdir -p "$DIST_DIR"
if [[ ! -s "$DIST_DIR/gh.tar.gz" ]]; then
  echo "==> downloading gh ${GH_VERSION} (${GH_ARCH})"
  curl --http1.1 --retry 4 --retry-all-errors -fsSL \
    "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_${GH_ARCH}.tar.gz" \
    -o "$DIST_DIR/gh.tar.gz"
fi
if [[ ! -s "$DIST_DIR/awscliv2.zip" ]]; then
  echo "==> downloading aws cli ${AWSCLI_VERSION} (${AWS_ARCH})"
  curl --http1.1 --retry 4 --retry-all-errors -fsSL \
    "https://awscli.amazonaws.com/awscli-exe-linux-${AWS_ARCH}-${AWSCLI_VERSION}.zip" \
    -o "$DIST_DIR/awscliv2.zip"
fi

FINGERPRINT="$(node --import tsx/esm --input-type=module -e '
const { computeSandboxImageFingerprint } = await import("./packages/sandbox/src/local-sandbox.ts");
const fp = await computeSandboxImageFingerprint(process.cwd());
console.log(fp ?? "");
')"

PLATFORM_ARGS=()
if [[ -n "$PLATFORM" ]]; then
  PLATFORM_ARGS=(--platform "$PLATFORM")
fi

echo "==> building ${BASE_TAG} from fly/Dockerfile"
docker build ${PLATFORM_ARGS[@]+"${PLATFORM_ARGS[@]}"} -f fly/Dockerfile -t "${BASE_TAG}" .

echo "==> building ${LOCAL_TAG} from local/Dockerfile (fingerprint ${FINGERPRINT:-none})"
docker build ${PLATFORM_ARGS[@]+"${PLATFORM_ARGS[@]}"} -f local/Dockerfile --build-arg "BASE=${BASE_TAG}" --label "qm.sandbox-fingerprint=${FINGERPRINT}" -t "${LOCAL_TAG}" .

echo "==> done: ${LOCAL_TAG}"
