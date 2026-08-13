import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseFrontmatter } from '@pm/shared'
import { GuildVault, RevConflictError } from './GuildVault'

let root: string
let vault: GuildVault

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'pm-vault-'))
  vault = await GuildVault.open('guild-1', root)
})

afterEach(async () => {
  await vault.drain()
  await fs.rm(root, { recursive: true, force: true })
})

async function read(vaultPath: string): Promise<string> {
  return fs.readFile(join(root, 'guild-1', ...vaultPath.split('/')), 'utf8')
}

async function fileExists(vaultPath: string): Promise<boolean> {
  try {
    await fs.access(join(root, 'guild-1', ...vaultPath.split('/')))
    return true
  } catch {
    return false
  }
}

describe('project lifecycle', () => {
  it('creates a project file with pm-project frontmatter in Projects/', async () => {
    const project = await vault.createProject('Senior Capstone')
    expect(project.filePath).toBe('Projects/Senior Capstone.md')
    const content = await read(project.filePath)
    const { frontmatter } = parseFrontmatter(content)
    expect(frontmatter?.['pm-project']).toBe(true)
    expect(frontmatter?.title).toBe('Senior Capstone')
    expect(await fileExists('Projects/Senior Capstone_tasks')).toBe(true)
  })

  it('rejects a duplicate project name', async () => {
    await vault.createProject('Twice')
    await expect(vault.createProject('Twice')).rejects.toThrow(/already exists/)
  })

  it('updates project fields and bumps rev', async () => {
    const project = await vault.createProject('P')
    expect(vault.rev(project.id)).toBe(1)
    await vault.updateProject(project.id, { description: 'It matters.', color: '#ff0000' })
    expect(vault.rev(project.id)).toBe(2)
    const { frontmatter } = parseFrontmatter(await read(project.filePath))
    expect(frontmatter?.description).toBe('It matters.')
    expect(frontmatter?.color).toBe('#ff0000')
  })

  it('trashes rather than hard-deletes a project', async () => {
    const project = await vault.createProject('Doomed')
    await vault.insertTask(project.id, { title: 'A task' })
    await vault.deleteProject(project.id)
    expect(await fileExists('Projects/Doomed.md')).toBe(false)
    const trash = await fs.readdir(join(root, 'guild-1', '.trash'))
    expect(trash.some((f) => f.endsWith('Doomed.md'))).toBe(true)
    expect(trash.some((f) => f.endsWith('Doomed_tasks'))).toBe(true)
  })
})

describe('task lifecycle', () => {
  it('writes task files into the _tasks folder with reference frontmatter', async () => {
    const project = await vault.createProject('P')
    const { task } = await vault.insertTask(project.id, { title: 'Ship v1.0', status: 'in-progress' })
    // Note: the reference slugger keeps dots — "Ship v1.0" -> ship-v1.0.md.
    expect(task.filePath).toBe('Projects/P_tasks/ship-v1.0.md')
    const { frontmatter } = parseFrontmatter(await read(task.filePath!))
    expect(frontmatter?.['pm-task']).toBe(true)
    expect(frontmatter?.projectId).toBe(project.id)
    expect(frontmatter?.status).toBe('in-progress')
    // The project file's taskIds now lists the task.
    const projectFm = parseFrontmatter(await read(project.filePath)).frontmatter
    expect(projectFm?.taskIds).toEqual([task.id])
  })

  it('renames the file when the title changes and updates children Parent links', async () => {
    const project = await vault.createProject('P')
    const { task: parent } = await vault.insertTask(project.id, { title: 'Old Name' })
    const { task: child } = await vault.insertTask(project.id, { title: 'Child' }, parent.id)
    await vault.updateTask(project.id, parent.id, { title: 'New Name' })
    expect(await fileExists('Projects/P_tasks/old-name.md')).toBe(false)
    expect(await fileExists('Projects/P_tasks/new-name.md')).toBe(true)
    const childContent = await read(child.filePath!)
    expect(childContent).toContain('Parent: [[new-name|New Name]]')
  })

  it('stamps completed when status crosses into terminal', async () => {
    const project = await vault.createProject('P')
    const { task } = await vault.insertTask(project.id, { title: 'T' })
    await vault.updateTask(project.id, task.id, { status: 'done' })
    const { frontmatter } = parseFrontmatter(await read('Projects/P_tasks/t.md'))
    expect(frontmatter?.completed).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    await vault.updateTask(project.id, task.id, { status: 'todo' })
    const after = parseFrontmatter(await read('Projects/P_tasks/t.md')).frontmatter
    expect(after?.completed).toBeUndefined()
  })

  it('archives by moving the file into Archive/ without storing archived in frontmatter', async () => {
    const project = await vault.createProject('P')
    const { task } = await vault.insertTask(project.id, { title: 'Done Deal' })
    await vault.setArchived(project.id, task.id, true)
    expect(await fileExists('Projects/P_tasks/done-deal.md')).toBe(false)
    expect(await fileExists('Projects/P_tasks/Archive/done-deal.md')).toBe(true)
    const { frontmatter } = parseFrontmatter(await read('Projects/P_tasks/Archive/done-deal.md'))
    expect(frontmatter?.archived).toBeUndefined()
    await vault.setArchived(project.id, task.id, false)
    expect(await fileExists('Projects/P_tasks/done-deal.md')).toBe(true)
  })

  it('auto-schedules dependents when a predecessor due date moves', async () => {
    const project = await vault.createProject('P')
    const { task: a } = await vault.insertTask(project.id, {
      title: 'A',
      start: '2026-04-01',
      due: '2026-04-05'
    })
    const { task: b } = await vault.insertTask(project.id, {
      title: 'B',
      start: '2026-04-06',
      due: '2026-04-08',
      dependencies: [a.id]
    })
    // Push A's due past B's start; B must shift to start the day after.
    await vault.updateTask(project.id, a.id, { due: '2026-04-10' })
    const fm = parseFrontmatter(await read(b.filePath!)).frontmatter
    expect(fm?.start).toBe('2026-04-11')
    expect(fm?.due).toBe('2026-04-13')
  })

  it('deletes task files into .trash including subtasks', async () => {
    const project = await vault.createProject('P')
    const { task: parent } = await vault.insertTask(project.id, { title: 'Parent' })
    await vault.insertTask(project.id, { title: 'Child' }, parent.id)
    await vault.deleteTasks(project.id, [parent.id])
    expect(await fileExists('Projects/P_tasks/parent.md')).toBe(false)
    expect(await fileExists('Projects/P_tasks/child.md')).toBe(false)
    const trash = await fs.readdir(join(root, 'guild-1', '.trash'))
    expect(trash.some((f) => f.endsWith('parent.md'))).toBe(true)
    expect(trash.some((f) => f.endsWith('child.md'))).toBe(true)
  })

  it('appends time logs', async () => {
    const project = await vault.createProject('P')
    const { task } = await vault.insertTask(project.id, { title: 'T' })
    await vault.addTimeLog(project.id, task.id, { date: '2026-04-01', hours: 2.5, note: 'kickoff' })
    const { frontmatter } = parseFrontmatter(await read(task.filePath!))
    expect(frontmatter?.timeLogs).toEqual([{ date: '2026-04-01', hours: 2.5, note: 'kickoff' }])
  })
})

describe('optimistic concurrency', () => {
  it('rejects a stale rev with RevConflictError', async () => {
    const project = await vault.createProject('P')
    const rev = vault.rev(project.id)
    await vault.updateProject(project.id, { description: 'first' }, rev)
    await expect(vault.updateProject(project.id, { description: 'second' }, rev)).rejects.toThrow(
      RevConflictError
    )
    // Omitting the rev is an explicit last-write-wins override.
    await expect(vault.updateProject(project.id, { description: 'third' })).resolves.toBeGreaterThan(rev)
  })
})

describe('reload from disk (Obsidian bridge)', () => {
  it('a fresh open reproduces projects, task order, nesting, and archive state', async () => {
    const project = await vault.createProject('Capstone')
    const { task: t1 } = await vault.insertTask(project.id, { title: 'First', status: 'in-progress' })
    const { task: t2 } = await vault.insertTask(project.id, { title: 'Second' })
    const { task: sub } = await vault.insertTask(project.id, { title: 'Nested' }, t2.id)
    await vault.insertTask(project.id, { title: 'Milestone', type: 'milestone', start: '', due: '2026-05-01' })
    await vault.setArchived(project.id, t1.id, true)
    await vault.drain()

    const reopened = await GuildVault.open('guild-1', root)
    const loaded = [...reopened.projects.values()][0]
    expect(loaded.title).toBe('Capstone')
    expect(loaded.tasks.map((t) => t.title)).toEqual(['First', 'Second', 'Milestone'])
    const first = loaded.tasks.find((t) => t.title === 'First')!
    expect(first.archived).toBe(true)
    const second = loaded.tasks.find((t) => t.title === 'Second')!
    expect(second.subtasks.map((t) => t.title)).toEqual(['Nested'])
    expect(second.subtasks[0].id).toBe(sub.id)
    const milestone = loaded.tasks.find((t) => t.title === 'Milestone')!
    expect(milestone.type).toBe('milestone')
    expect(milestone.due).toBe('2026-05-01')
    expect(t2.id).toBe(second.id)
  })
})
