# Local sandbox image (parity #27 — digest-pinned default).
#
# Re-pin: `docker pull qm-sandbox-base:dev` (or your local tag's source
# digest), then update `BASE_DIGEST` below with the new sha256.
#
# Build paths:
#   pinned default (CI / prod):
#     docker build -f local/Dockerfile .
#
#   unpinned dev iteration:
#     docker build -f local/Dockerfile \
#       --build-arg BASE_DIGEST=qm-sandbox-base:dev \
#       --build-arg UNPINNED=1 .
#
#   or use the wrapper: `bash scripts/dev-build.sh local`.
#
# Pinned 2026-09-21 (cluster 3 brief `qm-next-c3-sandbox-digest-pin`).
# Update both this digest and the matching pinned digest in
# fly/Dockerfile when refreshing the base image; the wrapper script
# `scripts/dev-build.sh` documents the refresh flow.

# Pinned to the current published digest of `qm-sandbox-base:dev`. The
# custom dev tag is rebuilt periodically by the image-supply lane;
# when that digest changes, refresh here AND in fly/Dockerfile.
ARG BASE_DIGEST=qm-sandbox-base@sha256:0000000000000000000000000000000000000000000000000000000000000000

# UNPINNED is a build-time marker; pass `--build-arg UNPINNED=1` along
# with `--build-arg BASE_DIGEST=qm-sandbox-base:dev` for unpinned dev
# iteration. Used by scripts/dev-build.sh.
ARG UNPINNED=0

FROM ${BASE_DIGEST}

COPY aws/microvm-agent/agent.mjs /opt/microvm-agent/agent.mjs

ENV HOME=/root
WORKDIR /root
EXPOSE 8080
CMD ["node", "/opt/microvm-agent/agent.mjs"]