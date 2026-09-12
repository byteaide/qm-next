/**
 * Profile smoke tests: boot a kernel from YAML entry lists via `bootProfile`,
 * covering mounting, `!!js` interpolation, failed imports, and the repository
 * profile.
 *
 * Fixtures are copied into `tests/.tmp/` before booting: each run gets a fresh
 * file (Include writes back on unmount), and the copy keeps module resolution
 * inside the workspace so `@qm/demo` resolves through `packages/boot`.
 */
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { copyFile, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { bootProfile } from '@qm/boot'

async function stageFixture(name: string): Promise<string> {
  const tmpDir = new URL('./.tmp/', import.meta.url)
  await mkdir(tmpDir, { recursive: true })
  const target = new URL(`./.tmp/${name}-${randomBytes(4).toString('hex')}.yml`, import.meta.url)
  await copyFile(new URL(`./fixtures/${name}.yml`, import.meta.url), target)
  return fileURLToPath(target)
}

test('bootProfile mounts entries from a YAML profile', async () => {
  const profile = await stageFixture('basic')
  const ctx = await bootProfile(profile)
  assert.equal(ctx.demo.greet('qm'), 'config-loaded, qm! config-loaded, qm!')

  // Unmounting the include entry cascades through its nested tree.
  await ctx.loader.remove('include')
  assert.equal(ctx.reflect.get('demo'), undefined)
})

test('!!js interpolation evaluates against the loader context', async () => {
  const profile = await stageFixture('interpolate')
  const ctx = await bootProfile(profile)
  assert.equal(ctx.demo.greet('qm'), 'greeting-2, qm!')

  await ctx.loader.remove('include')
})

test('a failing import rejects boot with the entry error', async () => {
  const profile = await stageFixture('bad-import')
  await assert.rejects(
    () => bootProfile(profile),
    /failed to import loader entry demo-bad \(@qm\/nonexistent-plugin\)/,
  )
})

test('the repository profile boots end to end', async () => {
  const profile = fileURLToPath(new URL('../../../profiles/cordis.yml', import.meta.url))
  const ctx = await bootProfile(profile)
  assert.equal(ctx.demo.greet('qm'), 'hello-2, qm! hello-2, qm! hello-2, qm!')

  await ctx.loader.remove('include')
  assert.equal(ctx.reflect.get('demo'), undefined)
})
