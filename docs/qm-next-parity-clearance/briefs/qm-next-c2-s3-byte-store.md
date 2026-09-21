# qm-next-c2-s3-byte-store

## Origin

- **Created**: 2026-09-21
- **Parent task**: `docs/qm-next-parity-clearance-2026-09-21.md` (cluster 2, item: S3 byte backend)
- **Blocked by**: none
- **Conversation context**: parity clearance identified S3 as the only missing `DurableByteStore` variant; local-FS + memory are in.

## What

Add a third implementation of `DurableByteStore` backed by S3 (or S3-compatible object stores via standard endpoint config). Local-FS and memory legs stay unchanged. The new leg is selected by composition root when a `S3_*` config block is present; otherwise the existing local-FS path is used.

## Why

`operations.md` §8 currently defers S3 to "local FS only". For any deployment that needs durable byte storage across hosts (multi-instance, blue-green), local-FS isn't viable. S3 is the standard swap target.

## Tier

`tier:simple` — exact port pattern from existing `createLocalByteStore` (`packages/store/src/byte-store.ts:61`); no design decisions remain.

## Files to Modify

- `EDIT: packages/store/src/byte-store.ts:60-80` — add `createS3ByteStore()` impl alongside `createLocalByteStore`
- `EDIT: packages/store/src/index.ts` — export `createS3ByteStore`
- `EDIT: packages/api/src/service.ts:870-880` — composition root picks S3 leg when `S3_BUCKET` env present
- `NEW: packages/store/src/s3-byte-store.ts` — impl (model on `byte-store.ts`)
- `NEW: packages/store/tests/s3-byte-store.test.ts` — uses minio or aws-sdk-testing

## Implementation Steps

1. Read `packages/store/src/byte-store.ts` end-to-end to absorb the interface contract.
2. Pick SDK: `@aws-sdk/client-s3` (Node 24 native). Pin in `packages/store/package.json`.
3. Write `createS3ByteStore({ bucket, region, endpoint?, accessKeyId?, secretAccessKey?, prefix? })` matching the existing `DurableByteStore` shape:
   - `put(sha256, bytes)` → `PutObjectCommand` with content-addressed key `${prefix}/${sha256}`
   - `get(sha256)` → `GetObjectCommand`; stream to buffer
   - `delete(sha256)` → `DeleteObjectCommand`
   - `has(sha256)` → `HeadObjectCommand`
4. In composition root (`packages/api/src/service.ts`), if `process.env.S3_BUCKET` set, swap `byteStore = createS3ByteStore(...)` for the existing `createLocalByteStore(this.config.filesDir)`.
5. Write unit tests using `aws-sdk-client-mock` (no real S3 needed).

```typescript
// packages/store/src/s3-byte-store.ts (skeleton)
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3'
import type { DurableByteStore } from './byte-store.ts'

export interface S3ByteStoreOptions {
  bucket: string
  region: string
  endpoint?: string
  accessKeyId?: string
  secretAccessKey?: string
  prefix?: string
}

export function createS3ByteStore(opts: S3ByteStoreOptions): DurableByteStore {
  const client = new S3Client({ ... })
  const keyFor = (sha256: string) => `${opts.prefix ?? 'files'}/${sha256}`
  return {
    async put(sha256, bytes) { /* PutObject */ },
    async get(sha256) { /* GetObject, stream to buffer */ },
    async delete(sha256) { /* DeleteObject */ },
    async has(sha256) { /* HeadObject, return boolean */ },
  }
}
```

## Hazards

- **Auth**: production uses IAM role; tests use mock creds. Don't commit real keys.
- **Endpoint config**: must support S3-compatible (minio, R2, etc.) via `endpoint` override.
- **Large files**: `GetObject` is streaming; cap with `maxBytes` from existing pattern.

## Verification Before Dispatch

```bash
pnpm --filter @qm/store test
pnpm --filter @qm/store typecheck
pnpm --filter @qm/api typecheck
```

## Acceptance Criteria

- [ ] `createS3ByteStore()` exported from `@qm/store`

  ```yaml
  verify:
    method: codebase
    pattern: "export function createS3ByteStore"
    path: packages/store/src
  ```

- [ ] Composition root wires S3 leg when `S3_BUCKET` env present

  ```yaml
  verify:
    method: codebase
    pattern: "S3_BUCKET"
    path: packages/api/src/service.ts
  ```

- [ ] Round-trip test (put → get → has → delete) green with mocked S3 client

  ```yaml
  verify:
    method: bash
    run: "pnpm --filter @qm/store test s3-byte-store"
  ```

- [ ] No new IM platform symbols in core (`pnpm check:im` still green)

  ```yaml
  verify:
    method: bash
    run: "pnpm check:im"
  ```

## Context & Decisions

- Memory + local-FS legs already productionised; S3 just completes the matrix
- AWS SDK v3 client-only import keeps cold-start cost low
- Decision deferred to this brief: whether to add `list()` to `DurableByteStore` — current interface lacks it; **do not add** unless a downstream caller needs it

## Relevant Files

- `packages/store/src/byte-store.ts:26-100` — interface + memory + local impls
- `packages/api/src/service.ts:870-880` — composition root
- `packages/api/src/services/file-store.ts:184-190` — consumer example
- `docs/operations.md` §8 — explicit deferral to be closed

## Dependencies

- **Blocked by**: none
- **External**: `@aws-sdk/client-s3` (new dep in `packages/store/package.json`)

## Estimate

| Phase | Time |
|-------|------|
| Read existing byte-store | 15m |
| Impl + tests | 1 day |
| Composition wiring | 30m |
| **Total** | **~1.5 days** |