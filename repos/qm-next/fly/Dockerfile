# Pinned 2026-09-21 (cluster 3 brief `qm-next-c3-sandbox-digest-pin`).
# Re-pin with: `docker pull <image>` then replace the digest below.
# Cross-arch: linux/amd64 (qm-next ships host arch per parity #27).
# node:24-slim current digest
FROM node:24-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS node-runtime

# debian:12-slim current digest
FROM debian:12-slim@sha256:3783cc01769c7b2b1b83a5c5ad96c815348e28ed7da68e2e3687004faa906251

ARG DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
      bash coreutils findutils grep sed gawk \
      git curl wget jq unzip \
      python3 python3-venv python3-pip \
      ca-certificates gnupg \
  && rm -rf /var/lib/apt/lists/*

COPY --from=node-runtime /usr/local/ /usr/local/

COPY .sandbox-build/gh.tar.gz /tmp/gh.tgz
RUN tar xzf /tmp/gh.tgz -C /tmp \
  && install "/tmp/gh_2.93.0_linux_"*"/bin/gh" /usr/local/bin/gh \
  && rm -rf /tmp/gh* \
  && gh --version

COPY .sandbox-build/awscliv2.zip /tmp/awscliv2.zip
RUN unzip -q /tmp/awscliv2.zip -d /tmp \
  && /tmp/aws/install \
  && rm -rf /tmp/aws /tmp/awscliv2.zip \
  && aws --version

RUN python3 -m venv /opt/agent-venv \
  && /opt/agent-venv/bin/pip install --no-cache-dir --upgrade pip
ENV PATH="/opt/agent-venv/bin:${PATH}"
ENV VIRTUAL_ENV=/opt/agent-venv

ENV ANONYMIZED_TELEMETRY=false

WORKDIR /workspace

CMD ["sh", "-c", "while true; do sleep 3600; done"]