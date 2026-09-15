/**
 * `@qm/acl` — access-control store with per-scope authz and resource refs.
 *
 * ACL semantics: personal scopes are owned by a single principal,
 * channel/group scopes are membership-checked via a pluggable predicate,
 * org/team scopes are unguarded by default. `replaceGrantsIfCurrent` is
 * the compare-and-set primitive the admin routes rely on to keep grants
 * in lockstep across instances.
 *
 * Resource refs are namespaced by kind (`skill:`, `deployment:`,
 * `cron:`, `service-cred:`); file refs use the raw path verbatim so
 * handle-mount paths keep working without re-encoding.
 */
export {
  createAclStore,
  createMemoryGrantPersistence,
  type AclStore,
  type AclStoreOptions,
  type Grant,
  type GrantPersistence,
  type ScopeManagement,
} from './acl-store.ts'
export {
  createPostgresGrantStore,
  type PostgresGrantStore,
} from './postgres-grant-store.ts'
export {
  cronRef,
  deployRef,
  encodeRef,
  fileRef,
  parseRef,
  refPrefix,
  serviceCredRef,
  skillRef,
  type ResourceKind,
  type ResourceRef,
} from './resource-ref.ts'