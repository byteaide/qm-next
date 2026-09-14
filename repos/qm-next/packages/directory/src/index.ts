/**
 * @qm/directory — M3 lane 15.0: durable people/space roster store fed by
 * im-core `DirectorySyncPush`, query resolution, and the visibility filter.
 */
export * from './contract.ts'
export * from './person.ts'
export { applyPush, type DirectoryTables } from './apply-sync.ts'
export { createMemoryDirectoryStore } from './memory-directory-store.ts'
export { DIRECTORY_SCHEMA_STATEMENTS, createPostgresDirectoryStore } from './postgres-directory-store.ts'
