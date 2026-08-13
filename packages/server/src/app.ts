import { existsSync } from 'node:fs'
import { join } from 'node:path'
import cookie from '@fastify/cookie'
import fastifyStatic from '@fastify/static'
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import type { Project, ProjectPatch, Task, TimeLog } from '@pm/shared'
import { canWriteTasks, discordOAuth, isAdmin, resolveAppRole, type DiscordOAuthClient } from './auth/discord'
import { signOAuthState, signSession, verifyOAuthState, verifySession, type Session } from './auth/jwt'
import { DependencyCycleError, RevConflictError } from './vault/GuildVault'
import { TaskFileNameConflictError } from './vault/paths'
import type { VaultManager } from './vault/VaultManager'

export interface AppDeps {
  vaults: VaultManager
  jwtSecret: string
  publicUrl: string
  discordClientId: string
  discordClientSecret: string
  oauth?: DiscordOAuthClient
  /** DEV ONLY: enables /auth/dev to mint a session without Discord. */
  devAuth?: boolean
  /** Absolute path to the built SPA; when set, the server serves it with an SPA fallback. */
  clientDist?: string
}

declare module 'fastify' {
  interface FastifyRequest {
    session: Session
  }
}

const SESSION_COOKIE = 'pm_session'

/** Project DTO: the runtime-only taskIndex Map doesn't survive JSON. */
function projectDTO(project: Project, rev: number): Record<string, unknown> {
  const { taskIndex: _idx, ...rest } = project
  return { ...rest, rev }
}

function projectSummaryDTO(project: Project, rev: number): Record<string, unknown> {
  const { taskIndex: _idx, tasks, ...rest } = project
  let done = 0
  let total = 0
  for (const t of tasks) {
    if (t.archived) continue
    total++
    if (t.completed) done++
  }
  return { ...rest, rev, taskCount: total, doneCount: done }
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const oauth = deps.oauth ?? discordOAuth
  const app = Fastify({ logger: false })
  void app.register(cookie)

  app.get('/healthz', async () => ({ ok: true }))

  // Production: serve the built SPA, falling back to index.html for app routes.
  if (deps.clientDist && existsSync(join(deps.clientDist, 'index.html'))) {
    void app.register(fastifyStatic, { root: deps.clientDist, wildcard: false })
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api') && !req.url.startsWith('/auth')) {
        return reply.sendFile('index.html')
      }
      return reply.code(404).send({ error: 'not found' })
    })
  }

  const redirectUri = `${deps.publicUrl}/auth/callback`

  // ---------- auth ----------

  app.get('/auth/login', async (req, reply) => {
    const { guild, redirect } = req.query as { guild?: string; redirect?: string }
    if (!guild) return reply.code(400).send({ error: 'guild query param required' })
    const state = await signOAuthState(guild, redirect ?? '/', deps.jwtSecret)
    return reply.redirect(oauth.authorizeUrl(deps.discordClientId, redirectUri, state))
  })

  app.get('/auth/callback', async (req, reply) => {
    const { code, state } = req.query as { code?: string; state?: string }
    if (!code || !state) return reply.code(400).send({ error: 'missing code or state' })
    const parsed = await verifyOAuthState(state, deps.jwtSecret)
    if (!parsed) return reply.code(400).send({ error: 'invalid state' })

    const accessToken = await oauth.exchangeCode(code, redirectUri, deps.discordClientId, deps.discordClientSecret)
    const user = await oauth.fetchUser(accessToken)
    const member = await oauth.fetchMember(accessToken, parsed.guildId)
    if (!member) return reply.code(403).send({ error: 'not a member of this server' })

    const vault = await deps.vaults.get(parsed.guildId)
    const role = resolveAppRole(member.roles, vault.settings)
    const session: Session = {
      userId: user.id,
      userName: member.nick ?? user.global_name ?? user.username,
      guildId: parsed.guildId,
      role
    }
    const token = await signSession(session, deps.jwtSecret)
    reply.setCookie(SESSION_COOKIE, token, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: deps.publicUrl.startsWith('https'),
      maxAge: 7 * 24 * 3600
    })
    return reply.redirect(parsed.redirect.startsWith('/') ? parsed.redirect : '/')
  })

  if (deps.devAuth) {
    // Local development bypass (DEV_AUTH=1): /auth/dev?guild=g&role=member
    app.get('/auth/dev', async (req, reply) => {
      const { guild, role, name } = req.query as { guild?: string; role?: string; name?: string }
      if (!guild) return reply.code(400).send({ error: 'guild required' })
      const session: Session = {
        userId: 'dev-user',
        userName: name ?? 'Dev User',
        guildId: guild,
        role: (['admin', 'member', 'advisor', 'sponsor'].includes(role ?? '') ? role : 'admin') as Session['role']
      }
      const token = await signSession(session, deps.jwtSecret)
      reply.setCookie(SESSION_COOKIE, token, { path: '/', httpOnly: true, sameSite: 'lax' })
      return reply.redirect(`/g/${guild}/p`)
    })
  }

  app.post('/auth/logout', async (_req, reply) => {
    reply.clearCookie(SESSION_COOKIE, { path: '/' })
    return { ok: true }
  })

  // ---------- session guard for /api ----------

  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.url.startsWith('/api/')) return
    const bearer = req.headers.authorization?.replace(/^Bearer /, '')
    const token = bearer ?? req.cookies[SESSION_COOKIE]
    const session = token ? await verifySession(token, deps.jwtSecret) : null
    if (!session) return reply.code(401).send({ error: 'unauthenticated' })
    req.session = session
  })

  const requireWrite = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!canWriteTasks(req.session.role)) return reply.code(403).send({ error: 'read-only role' })
  }

  const requireAdmin = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!isAdmin(req.session.role)) return reply.code(403).send({ error: 'admin only' })
  }

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof RevConflictError) {
      return reply.code(409).send({ error: 'rev-conflict', expected: err.expected, actual: err.actual })
    }
    if (err instanceof TaskFileNameConflictError) {
      return reply.code(409).send({ error: 'file-conflict', fileName: err.fileName })
    }
    if (err instanceof DependencyCycleError) {
      return reply.code(409).send({ error: 'dependency-cycle', message: err.message })
    }
    const message = err instanceof Error ? err.message : String(err)
    if (message.startsWith('unknown project') || message.startsWith('unknown task')) {
      return reply.code(404).send({ error: message })
    }
    console.error('[api]', err)
    return reply.code(500).send({ error: 'internal error' })
  })

  const vaultOf = (req: FastifyRequest) => deps.vaults.get(req.session.guildId)

  // ---------- session info ----------

  app.get('/api/me', async (req) => ({ ...req.session }))

  // ---------- projects ----------

  app.get('/api/projects', async (req) => {
    const vault = await vaultOf(req)
    return [...vault.projects.values()].map((p) => projectSummaryDTO(p, vault.rev(p.id)))
  })

  app.post('/api/projects', { preHandler: requireAdmin }, async (req, reply) => {
    const { title } = req.body as { title?: string }
    if (!title?.trim()) return reply.code(400).send({ error: 'title required' })
    const vault = await vaultOf(req)
    const project = await vault.createProject(title.trim())
    return reply.code(201).send(projectDTO(project, vault.rev(project.id)))
  })

  app.get('/api/projects/:pid', async (req, reply) => {
    const vault = await vaultOf(req)
    const project = vault.projects.get((req.params as { pid: string }).pid)
    if (!project) return reply.code(404).send({ error: 'unknown project' })
    return projectDTO(project, vault.rev(project.id))
  })

  app.patch('/api/projects/:pid', { preHandler: requireWrite }, async (req) => {
    const { pid } = req.params as { pid: string }
    const { rev, ...patch } = req.body as ProjectPatch & { rev?: number }
    const vault = await vaultOf(req)
    const newRev = await vault.updateProject(pid, patch, rev)
    return { rev: newRev }
  })

  app.delete('/api/projects/:pid', { preHandler: requireAdmin }, async (req) => {
    const { pid } = req.params as { pid: string }
    const vault = await vaultOf(req)
    await vault.deleteProject(pid)
    return { ok: true }
  })

  // ---------- tasks ----------

  app.post('/api/projects/:pid/tasks', { preHandler: requireWrite }, async (req, reply) => {
    const { pid } = req.params as { pid: string }
    const { rev, parentId, ...init } = req.body as Partial<Task> & { rev?: number; parentId?: string | null }
    const vault = await vaultOf(req)
    const result = await vault.insertTask(pid, init, parentId ?? null, rev)
    return reply.code(201).send({ task: result.task, rev: result.rev })
  })

  app.patch('/api/projects/:pid/tasks/:tid', { preHandler: requireWrite }, async (req) => {
    const { pid, tid } = req.params as { pid: string; tid: string }
    const { rev, archived, ...patch } = req.body as Partial<Task> & { rev?: number }
    const vault = await vaultOf(req)
    let newRev: number | undefined
    if (Object.keys(patch).length > 0) {
      newRev = await vault.updateTask(pid, tid, patch, rev)
    }
    if (archived !== undefined) {
      newRev = await vault.setArchived(pid, tid, archived, undefined)
    }
    return { rev: newRev ?? vault.rev(pid) }
  })

  app.post('/api/projects/:pid/tasks/bulk', { preHandler: requireWrite }, async (req) => {
    const { pid } = req.params as { pid: string }
    const { taskIds, patch, rev } = req.body as { taskIds: string[]; patch: Partial<Task>; rev?: number }
    const vault = await vaultOf(req)
    const newRev = await vault.updateTasks(pid, taskIds ?? [], patch ?? {}, rev)
    return { rev: newRev }
  })

  app.post('/api/projects/:pid/tasks/delete', { preHandler: requireWrite }, async (req) => {
    const { pid } = req.params as { pid: string }
    const { taskIds, rev } = req.body as { taskIds: string[]; rev?: number }
    const vault = await vaultOf(req)
    const newRev = await vault.deleteTasks(pid, taskIds ?? [], rev)
    return { rev: newRev }
  })

  app.post('/api/projects/:pid/tasks/:tid/move', { preHandler: requireWrite }, async (req) => {
    const { pid, tid } = req.params as { pid: string; tid: string }
    const { parentId, rev } = req.body as { parentId: string | null; rev?: number }
    const vault = await vaultOf(req)
    const newRev = await vault.moveTask(pid, tid, parentId ?? null, rev)
    return { rev: newRev }
  })

  app.post('/api/projects/:pid/tasks/:tid/reorder', { preHandler: requireWrite }, async (req, reply) => {
    const { pid, tid } = req.params as { pid: string; tid: string }
    const { targetId, position, rev } = req.body as {
      targetId: string
      position: 'before' | 'after'
      rev?: number
    }
    if (!targetId || (position !== 'before' && position !== 'after')) {
      return reply.code(400).send({ error: 'targetId and position required' })
    }
    const vault = await vaultOf(req)
    const newRev = await vault.reorderTask(pid, tid, targetId, position, rev)
    return { rev: newRev }
  })

  app.post('/api/projects/:pid/tasks/:tid/duplicate', { preHandler: requireWrite }, async (req, reply) => {
    const { pid, tid } = req.params as { pid: string; tid: string }
    const { includeSubtasks, rev } = req.body as { includeSubtasks?: boolean; rev?: number }
    const vault = await vaultOf(req)
    const result = await vault.duplicateTask(pid, tid, includeSubtasks ?? false, rev)
    return reply.code(201).send({ task: result.task, rev: result.rev })
  })

  app.post('/api/projects/:pid/tasks/:tid/timelogs', { preHandler: requireWrite }, async (req, reply) => {
    const { pid, tid } = req.params as { pid: string; tid: string }
    const { date, hours, note, rev } = req.body as Partial<TimeLog> & { rev?: number }
    if (!date || typeof hours !== 'number') {
      return reply.code(400).send({ error: 'date and hours required' })
    }
    const vault = await vaultOf(req)
    const newRev = await vault.addTimeLog(pid, tid, { date, hours, note: note ?? '' }, rev)
    return reply.code(201).send({ rev: newRev })
  })

  // ---------- settings ----------

  app.get('/api/settings', async (req) => {
    const vault = await vaultOf(req)
    return vault.settings
  })

  app.patch('/api/settings', { preHandler: requireAdmin }, async (req) => {
    const vault = await vaultOf(req)
    await vault.updateSettings(req.body as Record<string, never>)
    return vault.settings
  })

  // ---------- git sync ----------

  app.post('/api/git/sync', { preHandler: requireAdmin }, async (req) => {
    const vault = await vaultOf(req)
    await vault.syncWithRemote()
    return { ok: true }
  })

  return app
}
