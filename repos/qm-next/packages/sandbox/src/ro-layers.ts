import { createHash } from 'node:crypto'
import type { SandboxHandle, WorkspaceLayer } from '@qm/types'
import { shq } from '@qm/credentials'
import { swallow } from './util.ts'
import { makeTar } from './tar.ts'

export interface RoLayerNames {
  manifest: string
  tar: string
  label: string
}

export interface RoLayerData {
  layer: WorkspaceLayer
  files: ReadonlyArray<{ path: string; data: Uint8Array }>
}

export interface RoLayerIo {
  readFile(handle: SandboxHandle, relPath: string): Promise<string | null>
  writeFileBytes(handle: SandboxHandle, relPath: string, data: Uint8Array): Promise<void>
  exec(script: string, timeoutSec: number): Promise<{ code: number; stderr: string }>
}

export async function materializeRoLayers(
  layers: RoLayerData[],
  handle: SandboxHandle,
  io: RoLayerIo,
  names: RoLayerNames,
): Promise<void> {
  const roEntries: Array<{ path: string; data: Uint8Array }> = []
  for (const { layer, files } of layers) {
    if (layer.mode === 'rw') continue
    for (const file of files) {
      const destRel = layer.mountPath ? `${layer.mountPath}/${file.path}` : file.path
      roEntries.push({ path: destRel, data: file.data })
    }
  }
  if (!roEntries.length) return
  const fp = createHash('sha256')
  for (const e of [...roEntries].sort((a, b) => {
    if (a.path < b.path) return -1
    if (a.path > b.path) return 1
    return 0
  })) {
    fp.update(e.path)
    fp.update('\0')
    fp.update(createHash('sha256').update(e.data).digest())
    fp.update('\n')
  }
  const want = fp.digest('hex')
  let have: string | null = null
  try {
    have = await io.readFile(handle, names.manifest)
  } catch (err) {
    swallow(`${names.label}: ro-layers manifest probe`, err)
  }
  if (have === want) return
  const tar = await makeTar([...roEntries, { path: names.manifest, data: Buffer.from(want) }])
  await io.writeFileBytes(handle, names.tar, tar)
  const extract = await io.exec(
    `cd ${shq(handle.rootDir)} && tar -xf ${shq(names.tar)}; rc=$?; rm -f ${shq(names.tar)}; exit $rc`,
    120,
  )
  if (extract.code !== 0) throw new Error(`${names.label} read-only layer materialize failed: ${extract.stderr}`)
}
