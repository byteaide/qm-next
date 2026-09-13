import type { FastifyRequest } from 'fastify'

export const COOKIE_NAME = 'webuiuser'

/** The dev principal behind a request, from the `webuiuser` cookie. */
export function cookieUser(req: FastifyRequest): string | null {
  const header = req.headers.cookie
  if (!header) return null
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    if (part.slice(0, eq).trim() !== COOKIE_NAME) continue
    const value = decodeURIComponent(part.slice(eq + 1).trim())
    return value || null
  }
  return null
}

export function sessionCookie(user: string): string {
  return `${COOKIE_NAME}=${encodeURIComponent(user)}; HttpOnly; Path=/; Max-Age=31536000; SameSite=Lax`
}

export function clearSessionCookie(): string {
  return `${COOKIE_NAME}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`
}
