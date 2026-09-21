# qm-next-c3-sandbox-digest-pin

## Origin

- **Created**: 2026-09-21
- **Parent task**: parity clearance (cluster 3, item: local sandbox base image digest pin)
- **Blocked by**: none (image-supply lane is a separate concern; this brief scopes the digest-pin mechanism only)
- **Conversation context**: `local/Dockerfile` and `fly/Dockerfile` use unpinned base tags (`node:24-slim`, `debian:12-slim`). parity-deviations.md #27 marks digest pin as deferred to image-supply lane.

## What

Add digest-pinned variant Dockerfiles (or ARG-driven pin mechanism) for `local/Dockerfile` and `fly/Dockerfile`. Default build uses pinned sha256; dev passes allow unpinned via `--build-arg UNPINNED=1`.

## Why

Supply-chain reproducibility: unpinned `node:24-slim` can change under us; digest pin catches silent base-image mutations. qm's Dockerfiles use digest pins per the comment in parity-deviations.md #27.

## Tier

`tier:simple` — Dockerfile-only changes; mechanism is straightforward.

## Files to Modify

- `EDIT: local/Dockerfile` — switch `FROM ${BASE}` default to digest-pinned form
- `EDIT: fly/Dockerfile` — switch `FROM node:24-slim AS node-runtime` and `FROM debian:12-slim` to digest-pinned
- `NEW: scripts/digest-pin.ts` — helper that fetches current digests and updates Dockerfiles (optional, can be deferred)

## Implementation Steps

1. Read both Dockerfiles.
2. Run `docker pull <base>` to fetch the current digests, capture the `sha256:...` from the pull output.
3. Update Dockerfiles:
   - `FROM node:24-slim@sha256:<digest> AS node-runtime`
   - `FROM debian:12-slim@sha256:<digest>`
4. Add a comment near each pin explaining how to update (run `docker pull` and replace).
5. For local dev, allow `UNPINNED=1` build arg that overrides the pin.
6. Test: `docker build` works with pinned default; `docker build --build-arg UNPINNED=1` works for dev iteration.

```dockerfile
# local/Dockerfile
ARG BASE_DIGEST=ghcr.io/example/qm-sandbox-base@sha256:abcdef...
ARG BASE=qm-sandbox-base:dev
FROM ${BASE_DIGEST}
```

## Hazards

- **Digest drift**: pinning means image rebuilds break if upstream silently changes. Document the update procedure clearly.
- **Cross-arch**: qm pins linux/amd64 for Fly. qm-next uses host arch per #27; keep this asymmetry.
- **No fresh supply chain audit**: this brief only pins existing tags; doesn't add a real supply-chain lane. Image-supply lane remains an open follow-up.

## Verification Before Dispatch

```bash
docker build -f local/Dockerfile -t qm-sandbox-test .
docker build -f fly/Dockerfile -t qm-fly-test .
pnpm --filter @qm/sandbox test
```

## Acceptance Criteria

- [ ] Both Dockerfiles use digest-pinned base by default

  ```yaml
  verify:
    method: codebase
    pattern: "@sha256:"
    path: fly/Dockerfile
  ```

  ```yaml
  verify:
    method: codebase
    pattern: "@sha256:|@sha256\\+"
    path: local/Dockerfile
  ```

- [ ] Unpinned variant available via `UNPINNED=1`

  ```yaml
  verify:
    method: codebase
    pattern: "UNPINNED"
    path: local/Dockerfile
    expect: present
  ```

- [ ] Both Dockerfiles build green

  ```yaml
  verify:
    method: bash
    run: "docker build -f local/Dockerfile . && docker build -f fly/Dockerfile ."
  ```

## Context & Decisions

- Decision (this brief): use inline `FROM <image>@sha256:<digest>` rather than separate pinned + unpinned Dockerfiles. Single source of truth; `UNPINNED=1` overrides.
- Decision (out of scope): real supply-chain audit / SBOM generation — defer to image-supply lane.

## Relevant Files

- `local/Dockerfile` — local sandbox image
- `fly/Dockerfile` — fly sandbox image
- `aws/microvm-agent/agent.mjs` — runtime daemon (no changes)
- `parity-deviations.md:177-186` — #27 deferral

## Dependencies

- **Blocked by**: none
- **External**: requires access to registry for current digests (manual one-time fetch)

## Estimate

| Phase | Time |
|-------|------|
| Fetch current digests | 15m |
| Update Dockerfiles | 0.25 day |
| Build verification | 0.25 day |
| **Total** | **~0.5-1 day** |