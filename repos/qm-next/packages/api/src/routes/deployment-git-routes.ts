/**
 * /v1/deployments/:id/git/** — git smart-HTTP transport (cluster 1
 * phase 2, parity #45b remaining slice). Serves `git clone` / `git
 * fetch` (git-upload-pack) and `git push` (git-receive-pack) by
 * spawning the upstream `git http-backend` CGI against the per-
 * deployment bare repo owned by `DeployGitStore`.
 *
 * Auth: git clients cannot set arbitrary headers, so the token rides
 * `Authorization: Bearer`, `Authorization: Basic` (password = token),
 * or `?token=` / `?access_token=` query params. Tokens verify through
 * the 12.0 capability ladder (`verifyCapabilityToken`); anything else
 * gets the qm `401 + WWW-Authenticate: Basic` ladder.
 *
 * Raw lane: the handler hijacks the request (raw-framework) so pack
 * bytes pass through byte-exact; bodyLimit covers a generous push.
 */
import { spawn } from 'node:child_process'
import type { DeployGitStore } from '@qm/types'
import { verifyCapabilityToken } from '@qm/auth'
import { rawSendJson, type RawRoute, type RawRouteContext } from './raw-framework.ts'

export interface DeploymentGitDeps {
  git: DeployGitStore
  secrets: string[]
  /** Org id carried in minted tokens / log context. */
  orgId?: string
}

const GIT_BODY_LIMIT_BYTES = 100 * 1024 * 1024
const GIT_CGI_TIMEOUT_MS = 120_000

function gitTokenFrom(ctx: RawRouteContext): string | null {
  const authz = ctx.req.headers.authorization
  if (typeof authz === 'string') {
    const basic = /^basic\s+(.+)$/i.exec(authz)
    if (basic) {
      try {
        const decoded = Buffer.from(basic[1]!, 'base64').toString('utf8')
        const colon = decoded.indexOf(':')
        const pass = colon < 0 ? '' : decoded.slice(colon + 1)
        const user = colon < 0 ? decoded : decoded.slice(0, colon)
        return pass || user || null
      } catch {
        return null
      }
    }
    const bearer = /^bearer\s+(.+)$/i.exec(authz)
    if (bearer) return bearer[1]!
  }
  return ctx.query.token ?? ctx.query.access_token ?? null
}

function rejectGitAuth(ctx: Parameters<RawRoute['handle']>[0], message = 'deployment git token required'): void {
  ctx.reply.raw.writeHead(401, {
    'content-type': 'application/json',
    'www-authenticate': 'Basic realm="deployment git"',
  })
  ctx.reply.raw.end(JSON.stringify({ error: 'unauthorized', message }))
}

function gitQueryString(query: Record<string, string>): string {
  const qs = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (key === 'token' || key === 'access_token') continue
    qs.set(key, value)
  }
  return qs.toString()
}

function headerEnd(buf: Buffer): { headEnd: number; bodyStart: number } | null {
  const crlf = buf.indexOf('\r\n\r\n')
  if (crlf >= 0) return { headEnd: crlf, bodyStart: crlf + 4 }
  const lf = buf.indexOf('\n\n')
  if (lf >= 0) return { headEnd: lf, bodyStart: lf + 2 }
  return null
}

function gitServiceOf(tail: string, url: URL): 'git-upload-pack' | 'git-receive-pack' | null {
  if (tail === 'git-upload-pack' || tail === 'git-receive-pack') return tail
  if (tail === 'info/refs') {
    const s = url.searchParams.get('service')
    if (s === 'git-upload-pack' || s === 'git-receive-pack') return s
  }
  return null
}

async function runGitHttpBackend(input: {
  repoPath: string
  tail: string
  method: string
  query: string
  contentType?: string
  body: Buffer
}): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> {
  const repoRoot = input.repoPath.slice(0, input.repoPath.lastIndexOf('/'))
  const repoName = input.repoPath.slice(input.repoPath.lastIndexOf('/') + 1)
  const env: NodeJS.ProcessEnv = {
    PATH: '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin',
    GIT_PROJECT_ROOT: repoRoot,
    GIT_HTTP_EXPORT_ALL: '1',
    PATH_INFO: `/${repoName}/${input.tail}`,
    REQUEST_METHOD: input.method,
    QUERY_STRING: input.query,
    CONTENT_TYPE: input.contentType ?? '',
    CONTENT_LENGTH: String(input.body.length),
    REMOTE_USER: 'deployment-git',
  }
  return await new Promise((resolve, reject) => {
    const child = spawn('git', ['-c', 'http.receivepack=true', 'http-backend'], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      killSignal: 'SIGKILL',
      timeout: GIT_CGI_TIMEOUT_MS,
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout.on('data', (d) => stdout.push(Buffer.from(d)))
    child.stderr.on('data', (d) => stderr.push(Buffer.from(d)))
    child.on('error', reject)
    child.on('close', (code) => {
      const out = Buffer.concat(stdout)
      const split = headerEnd(out)
      if ((code ?? 0) !== 0 || !split) {
        reject(new Error(`git http-backend exited ${code}: ${Buffer.concat(stderr).toString('utf8').trim()}`))
        return
      }
      const headers: Record<string, string> = {}
      let status = 200
      for (const line of out.subarray(0, split.headEnd).toString('utf8').split(/\r?\n/)) {
        const i = line.indexOf(':')
        if (i < 0) continue
        const name = line.slice(0, i).trim()
        const value = line.slice(i + 1).trim()
        if (name.toLowerCase() === 'status') {
          status = Number(value.split(/\s+/)[0]) || 200
        } else if (name) {
          headers[name] = value
        }
      }
      resolve({ status, headers, body: out.subarray(split.bodyStart) })
    })
    child.stdin.end(input.body)
  })
}

function contentTypeOf(ctx: Parameters<RawRoute['handle']>[0]): string | undefined {
  const value = ctx.req.headers['content-type']
  if (Array.isArray(value)) return value[0]
  return typeof value === 'string' ? value : undefined
}

export function deploymentGitRoutes(deps: DeploymentGitDeps): ReadonlyArray<RawRoute> {
  async function handle(ctx: Parameters<RawRoute['handle']>[0]): Promise<void> {
    const token = gitTokenFrom(ctx)
    if (!token) return rejectGitAuth(ctx)
    const capability = await verifyCapabilityToken(token, deps.secrets)
    if (!capability) return rejectGitAuth(ctx, 'invalid or expired deployment git token')

    const id = ctx.params.id
    if (!id) return rawSendJson(ctx, 404, { error: 'not_found' })
    const prefix = `/v1/deployments/${id}/git/`
    if (!ctx.req.url || !ctx.req.url.startsWith(prefix)) {
      return rawSendJson(ctx, 404, { error: 'not_found' })
    }
    const tail = ctx.req.url.slice(prefix.length).split('?')[0] ?? ''
    const isGitRoute =
      (ctx.req.method === 'GET' && tail === 'info/refs') ||
      (ctx.req.method === 'POST' && (tail === 'git-upload-pack' || tail === 'git-receive-pack'))
    if (!isGitRoute) return rawSendJson(ctx, 404, { error: 'not_found' })
    const service = gitServiceOf(tail, ctx.url)
    if (ctx.req.method === 'POST' && !service) return rawSendJson(ctx, 404, { error: 'not_found' })

    let repoPath: string
    try {
      repoPath = await deps.git.repoUrl(id)
    } catch {
      return rawSendJson(ctx, 404, { error: 'not_found' })
    }

    try {
      const contentType = contentTypeOf(ctx)
      const result = await runGitHttpBackend({
        repoPath,
        tail,
        method: ctx.req.method ?? 'GET',
        query: gitQueryString(ctx.query),
        ...(contentType !== undefined ? { contentType } : {}),
        body: ctx.rawBody,
      })
      ctx.reply.raw.writeHead(result.status, result.headers)
      ctx.reply.raw.end(result.body)
    } catch (error) {
      rawSendJson(ctx, 502, {
        error: 'upstream_unreachable',
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return [
    { method: 'GET', path: '/v1/deployments/:id/git/info/refs', auth: 'public', readBody: false, handle },
    { method: 'POST', path: '/v1/deployments/:id/git/git-upload-pack', auth: 'public', readBody: true, bodyLimitBytes: GIT_BODY_LIMIT_BYTES, handle },
    { method: 'POST', path: '/v1/deployments/:id/git/git-receive-pack', auth: 'public', readBody: true, bodyLimitBytes: GIT_BODY_LIMIT_BYTES, handle },
  ]
}