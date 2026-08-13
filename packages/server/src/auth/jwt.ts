import { jwtVerify, SignJWT } from 'jose'
import type { AppRole } from '../vault/sidecar'

export interface Session {
  userId: string
  userName: string
  guildId: string
  role: AppRole
}

const SESSION_TTL = '7d'

function key(secret: string): Uint8Array {
  return new TextEncoder().encode(secret)
}

export async function signSession(session: Session, secret: string): Promise<string> {
  return new SignJWT({ ...session })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(SESSION_TTL)
    .sign(key(secret))
}

export async function verifySession(token: string, secret: string): Promise<Session | null> {
  try {
    const { payload } = await jwtVerify(token, key(secret))
    if (
      typeof payload.userId !== 'string' ||
      typeof payload.guildId !== 'string' ||
      typeof payload.role !== 'string'
    ) {
      return null
    }
    return {
      userId: payload.userId,
      userName: typeof payload.userName === 'string' ? payload.userName : '',
      guildId: payload.guildId,
      role: payload.role as Session['role']
    }
  } catch {
    return null
  }
}

/** Short-lived state token for the OAuth round-trip (CSRF + deep-link carry). */
export async function signOAuthState(guildId: string, redirect: string, secret: string): Promise<string> {
  return new SignJWT({ guildId, redirect })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(key(secret))
}

export async function verifyOAuthState(
  token: string,
  secret: string
): Promise<{ guildId: string; redirect: string } | null> {
  try {
    const { payload } = await jwtVerify(token, key(secret))
    if (typeof payload.guildId !== 'string') return null
    return {
      guildId: payload.guildId,
      redirect: typeof payload.redirect === 'string' ? payload.redirect : '/'
    }
  } catch {
    return null
  }
}
