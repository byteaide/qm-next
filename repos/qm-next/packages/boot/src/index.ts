/**
 * Profile bootstrap for qm-next.
 *
 * Mirrors `vendor/cordis/bin.js`: create the root context, point `baseUrl` at
 * the profile file's directory, mount the loader, and register a file-backed
 * include entry (id `include`) that loads the profile's entry list (YAML/JSON,
 * `!!js` interpolation supported). Profile entries live in the include's
 * nested tree, addressable as `include:<entry-id>`.
 */
import { Context } from '@qm/cordis'
import Loader from '@qm/cordis-plugin-loader'
import { basename, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * Boot a cordis kernel from a profile file.
 *
 * @param profile - profile path (YAML/JSON entry list); relative paths resolve against `cwd`.
 * @param cwd - base directory for relative profile paths; defaults to `process.cwd()`.
 * @returns the root context once every entry in the profile has started.
 */
export async function bootProfile(profile: string, cwd: string = process.cwd()): Promise<Context> {
  const filename = resolve(cwd, profile)
  const ctx = new Context()
  ctx.baseUrl = new URL('.', pathToFileURL(filename)).href
  await ctx.plugin(Loader)
  await ctx.loader.create({
    id: 'include',
    name: '@qm/cordis-plugin-include',
    config: { path: `./${basename(filename)}` },
  })
  await ctx.loader.await()
  return ctx
}
