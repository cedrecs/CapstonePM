import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Task } from '@pm/shared'
import { buildApp } from './app'
import { signSession } from './auth/jwt'
import type { AppRole } from './vault/sidecar'
import { VaultManager } from './vault/VaultManager'

const SECRET = 'test-secret'
const GUILD = 'guild-42'

let root: string
let vaults: VaultManager
let app: FastifyInstance

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'pm-api-'))
  vaults = new VaultManager(root)
  app = buildApp({
    vaults,
    jwtSecret: SECRET,
    publicUrl: 'http://localhost:3000',
    discordClientId: 'cid',
    discordClientSecret: 'csecret'
  })
})

afterEach(async () => {
  await app.close()
  await vaults.drainAll()
  await fs.rm(root, { recursive: true, force: true })
})

async function tokenFor(role: AppRole): Promise<string> {
  return signSession({ userId: `u-${role}`, userName: role, guildId: GUILD, role }, SECRET)
}

async function call(
  role: AppRole,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  body?: unknown
) {
  return app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${await tokenFor(role)}` },
    ...(body !== undefined ? { payload: body as Record<string, unknown> } : {})
  })
}

describe('auth guard', () => {
  it('rejects unauthenticated /api requests', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/projects' })
    expect(res.statusCode).toBe(401)
  })

  it('reports the session on /api/me', async () => {
    const res = await call('member', 'GET', '/api/me')
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ guildId: GUILD, role: 'member' })
  })

  it('redirects /auth/login to Discord with state', async () => {
    const res = await app.inject({ method: 'GET', url: '/auth/login?guild=g1&redirect=/g/g1' })
    expect(res.statusCode).toBe(302)
    const location = res.headers.location as string
    expect(location).toContain('discord.com/oauth2/authorize')
    expect(location).toContain('state=')
  })
})

describe('project + task CRUD', () => {
  it('admin creates a project; members add and edit tasks', async () => {
    const create = await call('admin', 'POST', '/api/projects', { title: 'Capstone' })
    expect(create.statusCode).toBe(201)
    const project = create.json() as { id: string; rev: number }
    expect(project.rev).toBe(1)

    const addTask = await call('member', 'POST', `/api/projects/${project.id}/tasks`, {
      title: 'Write proposal',
      priority: 'high',
      rev: 1
    })
    expect(addTask.statusCode).toBe(201)
    const { task } = addTask.json() as { task: Task; rev: number }
    expect(task.title).toBe('Write proposal')

    const patch = await call('member', 'PATCH', `/api/projects/${project.id}/tasks/${task.id}`, {
      status: 'done'
    })
    expect(patch.statusCode).toBe(200)

    const get = await call('sponsor', 'GET', `/api/projects/${project.id}`)
    const full = get.json() as { tasks: Task[] }
    expect(full.tasks[0].status).toBe('done')
    expect(full.tasks[0].completed).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('lists projects with counts', async () => {
    const created = await call('admin', 'POST', '/api/projects', { title: 'P1' })
    const pid = (created.json() as { id: string }).id
    await call('member', 'POST', `/api/projects/${pid}/tasks`, { title: 'A', status: 'done' })
    await call('member', 'POST', `/api/projects/${pid}/tasks`, { title: 'B' })
    const list = await call('advisor', 'GET', '/api/projects')
    const [summary] = list.json() as { taskCount: number; doneCount: number; tasks?: unknown }[]
    expect(summary.taskCount).toBe(2)
    expect(summary.doneCount).toBe(1)
    expect(summary.tasks).toBeUndefined()
  })

  it('bulk-patches and deletes tasks', async () => {
    const created = await call('admin', 'POST', '/api/projects', { title: 'P' })
    const pid = (created.json() as { id: string }).id
    const ids: string[] = []
    for (const title of ['A', 'B', 'C']) {
      const res = await call('member', 'POST', `/api/projects/${pid}/tasks`, { title })
      ids.push((res.json() as { task: Task }).task.id)
    }
    const bulk = await call('member', 'POST', `/api/projects/${pid}/tasks/bulk`, {
      taskIds: ids.slice(0, 2),
      patch: { priority: 'critical' }
    })
    expect(bulk.statusCode).toBe(200)
    const del = await call('member', 'POST', `/api/projects/${pid}/tasks/delete`, {
      taskIds: [ids[2]]
    })
    expect(del.statusCode).toBe(200)
    const full = (await call('member', 'GET', `/api/projects/${pid}`)).json() as { tasks: Task[] }
    expect(full.tasks).toHaveLength(2)
    expect(full.tasks.every((t) => t.priority === 'critical')).toBe(true)
  })
})

describe('role enforcement', () => {
  it.each([
    ['advisor', 'POST', '/api/projects', { title: 'X' }],
    ['sponsor', 'POST', '/api/projects', { title: 'X' }],
    ['member', 'POST', '/api/projects', { title: 'X' }],
    ['member', 'DELETE', '/api/projects/whatever', undefined],
    ['member', 'PATCH', '/api/settings', {}]
  ] as const)('%s cannot %s %s', async (role, method, url, body) => {
    const res = await call(role, method, url, body)
    expect(res.statusCode).toBe(403)
  })

  it('advisor and sponsor cannot write tasks', async () => {
    const created = await call('admin', 'POST', '/api/projects', { title: 'P' })
    const pid = (created.json() as { id: string }).id
    for (const role of ['advisor', 'sponsor'] as const) {
      const res = await call(role, 'POST', `/api/projects/${pid}/tasks`, { title: 'nope' })
      expect(res.statusCode).toBe(403)
    }
  })

  it('read access works for every role', async () => {
    await call('admin', 'POST', '/api/projects', { title: 'P' })
    for (const role of ['admin', 'member', 'advisor', 'sponsor'] as const) {
      const res = await call(role, 'GET', '/api/projects')
      expect(res.statusCode).toBe(200)
    }
  })
})

describe('optimistic concurrency over HTTP', () => {
  it('returns 409 with the current rev on a stale write', async () => {
    const created = await call('admin', 'POST', '/api/projects', { title: 'P' })
    const pid = (created.json() as { id: string }).id
    await call('member', 'PATCH', `/api/projects/${pid}`, { description: 'first', rev: 1 })
    const stale = await call('member', 'PATCH', `/api/projects/${pid}`, { description: 'second', rev: 1 })
    expect(stale.statusCode).toBe(409)
    expect(stale.json()).toMatchObject({ error: 'rev-conflict', actual: 2 })
    // Omitting rev = last write wins.
    const override = await call('member', 'PATCH', `/api/projects/${pid}`, { description: 'third' })
    expect(override.statusCode).toBe(200)
  })
})

describe('time logs', () => {
  it('member logs time; advisor cannot', async () => {
    const created = await call('admin', 'POST', '/api/projects', { title: 'P' })
    const pid = (created.json() as { id: string }).id
    const task = ((await call('member', 'POST', `/api/projects/${pid}/tasks`, { title: 'T' })).json() as {
      task: Task
    }).task
    const log = await call('member', 'POST', `/api/projects/${pid}/tasks/${task.id}/timelogs`, {
      date: '2026-04-01',
      hours: 3,
      note: 'research'
    })
    expect(log.statusCode).toBe(201)
    const denied = await call('advisor', 'POST', `/api/projects/${pid}/tasks/${task.id}/timelogs`, {
      date: '2026-04-01',
      hours: 1
    })
    expect(denied.statusCode).toBe(403)
  })
})
