declare module 'tar-stream' {
  export interface TarEntry {
    name: string
    mode?: number
    mtime?: Date
    type?: string
    size?: number
  }

  export interface TarPack {
    entry(header: TarEntry, data?: Uint8Array): void
    finalize(): void
    [Symbol.asyncIterator](): AsyncIterableIterator<Buffer>
  }

  export interface TarExtractStream {
    on(event: 'data', cb: (chunk: Buffer) => void): void
    on(event: 'end', cb: () => void): void
    on(event: 'error', cb: (err: Error) => void): void
  }

  export interface TarExtractor {
    on(
      event: 'entry',
      cb: (header: TarEntry, stream: TarExtractStream, next: (err?: Error | null) => void) => void,
    ): TarExtractor
    on(event: 'finish', cb: () => void): TarExtractor
    on(event: 'error', cb: (err: Error) => void): TarExtractor
    destroy(err?: Error): void
    end(data?: Uint8Array): void
  }

  export function pack(): TarPack
  export function extract(): TarExtractor
}
