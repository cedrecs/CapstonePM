import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { flattenTasks } from '@pm/shared'
import { ensureStarterProject, seedStarterProjectContent, STARTER_PROJECT_TITLE } from './onboarding'
import { GuildVault } from './vault/GuildVault'

let root: string
let vault: GuildVault

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'pm-onboarding-'))
  vault = await GuildVault.open('guild-1', root)
})

afterEach(async () => {
  await vault.drain()
  await fs.rm(root, { recursive: true, force: true })
})

describe('ensureStarterProject', () => {
  it('creates the starter project on an empty guild', async () => {
    const { project, created } = await ensureStarterProject(vault)
    expect(created).toBe(true)
    expect(project.title).toBe(STARTER_PROJECT_TITLE)
    expect(vault.projects.size).toBe(1)
  })

  it('returns the existing starter project instead of erroring on a second call', async () => {
    const first = await ensureStarterProject(vault)
    const second = await ensureStarterProject(vault)
    expect(second.created).toBe(false)
    expect(second.project.id).toBe(first.project.id)
    expect(vault.projects.size).toBe(1)
  })
})

describe('seedStarterProjectContent', () => {
  it('populates a milestone, a dependent task, a subtask, and a done task', async () => {
    const { project } = await ensureStarterProject(vault)
    await seedStarterProjectContent(vault, project)
    const live = vault.projects.get(project.id)!
    expect(live.icon).toBe('👋')
    expect(live.description).toContain('Table, Kanban, and Gantt')

    const flat = flattenTasks(live.tasks).map((f) => f.task)
    expect(flat).toHaveLength(4)

    const milestone = flat.find((t) => t.type === 'milestone')!
    expect(milestone.title).toBe('Project Proposal')
    expect(milestone.due).not.toBe('')

    const spec = flat.find((t) => t.title === 'Draft Requirements & Spec')!
    expect(spec.dependencies).toEqual([milestone.id])
    expect(spec.subtasks).toHaveLength(1)
    expect(spec.subtasks[0].title).toBe('Break the spec into smaller tasks')

    const done = flat.find((t) => t.status === 'done')!
    expect(done.title).toContain('Explore the Table')
  })
})
