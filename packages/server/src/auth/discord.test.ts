import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from '../app'
import { VaultManager } from '../vault/VaultManager'
import type { DiscordGuildSummary, DiscordOAuthClient, DiscordUser } from './discord'
import { hasGuildManageAccess } from './discord'

describe('hasGuildManageAccess', () => {
  const summary = (over: Partial<DiscordGuildSummary>): DiscordGuildSummary => ({
    owner: false,
    permissions: '0',
    ...over
  })

  it('is true for the guild owner regardless of permissions', () => {
    expect(hasGuildManageAccess(summary({ owner: true, permissions: '0' }))).toBe(true)
  })

  it('is true when the ADMINISTRATOR bit (0x8) is set', () => {
    expect(hasGuildManageAccess(summary({ permissions: String(0x8) }))).toBe(true)
  })

  it('is true when the MANAGE_GUILD bit (0x20) is set among others', () => {
    expect(hasGuildManageAccess(summary({ permissions: String(0x20 | 0x400) }))).toBe(true)
  })

  it('is false for an ordinary member with unrelated permissions', () => {
    expect(hasGuildManageAccess(summary({ permissions: String(0x400) }))).toBe(false)
  })

  it('is false rather than throwing on a malformed permissions string', () => {
    expect(hasGuildManageAccess(summary({ permissions: 'not-a-number' }))).toBe(false)
  })
})

describe('login callback: bootstrap admin for a brand-new guild', () => {
  const SECRET = 'test-secret'
  const GUILD = 'fresh-guild'

  let root: string
  let vaults: VaultManager
  let app: FastifyInstance
  let mockGuildSummary: DiscordGuildSummary | null
  let mockRoles: string[]

  const mockOAuth: DiscordOAuthClient = {
    authorizeUrl: (clientId, redirectUri, state) => `https://discord.com/oauth2/authorize?state=${state}`,
    exchangeCode: async () => 'fake-access-token',
    fetchUser: async (): Promise<DiscordUser> => ({ id: 'user-1', username: 'tester' }),
    fetchMember: async () => ({ roles: mockRoles }),
    fetchGuildSummary: async () => mockGuildSummary
  }

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'pm-oauth-'))
    vaults = new VaultManager(root)
    mockGuildSummary = null
    mockRoles = []
    app = buildApp({
      vaults,
      jwtSecret: SECRET,
      publicUrl: 'http://localhost:3000',
      discordClientId: 'cid',
      discordClientSecret: 'csecret',
      oauth: mockOAuth
    })
  })

  afterEach(async () => {
    await app.close()
    await vaults.drainAll()
    await fs.rm(root, { recursive: true, force: true })
  })

  async function login(): Promise<{ statusCode: number; role?: string }> {
    const loginRes = await app.inject({ method: 'GET', url: `/auth/login?guild=${GUILD}` })
    const state = new URL(loginRes.headers.location as string).searchParams.get('state')
    const callbackRes = await app.inject({
      method: 'GET',
      url: `/auth/callback?code=abc&state=${state}`
    })
    if (callbackRes.statusCode !== 302) return { statusCode: callbackRes.statusCode }
    const setCookie = callbackRes.headers['set-cookie']
    const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie) as string
    const meRes = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })
    return { statusCode: callbackRes.statusCode, role: meRes.json().role }
  }

  it('grants admin to the guild owner on an empty role map', async () => {
    mockGuildSummary = { owner: true, permissions: '0' }
    const { role } = await login()
    expect(role).toBe('admin')
  })

  it('grants admin to a non-owner with Manage Server permission on an empty role map', async () => {
    mockGuildSummary = { owner: false, permissions: String(0x20) }
    const { role } = await login()
    expect(role).toBe('admin')
  })

  it('does not grant admin to an ordinary member on an empty role map', async () => {
    mockGuildSummary = { owner: false, permissions: '0' }
    const { role } = await login()
    expect(role).toBe('member')
  })

  it('stops applying once any role mapping exists, even for the owner', async () => {
    mockGuildSummary = { owner: true, permissions: '0' }
    const vault = await vaults.get(GUILD)
    // Any mapping at all — including one irrelevant to this owner's roles —
    // marks the guild as configured and switches bootstrap off.
    await vault.updateSettings({ discord: { ...vault.settings.discord, roleMap: { 'role-x': 'advisor' } } })
    const { role } = await login()
    expect(role).toBe('member')
  })

  it('an explicit role mapping to admin still works without needing bootstrap', async () => {
    mockGuildSummary = { owner: false, permissions: '0' }
    mockRoles = ['role-admin']
    const vault = await vaults.get(GUILD)
    await vault.updateSettings({ discord: { ...vault.settings.discord, roleMap: { 'role-admin': 'admin' } } })
    const { role } = await login()
    expect(role).toBe('admin')
  })
})
