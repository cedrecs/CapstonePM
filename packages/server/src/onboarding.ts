// First-run experience: a brand-new guild has zero projects, which meant a
// blank web page and a dead-end `/pm add` in Discord. Both surfaces now
// bootstrap the same "Getting Started" project instead of showing nothing.
import type { Project } from '@pm/shared'
import { today } from '@pm/shared'
import type { GuildVault } from './vault/GuildVault'
import { TaskFileNameConflictError } from './vault/paths'

export const STARTER_PROJECT_TITLE = 'Getting Started'

/**
 * Creates the starter project, or returns the one a concurrent request just
 * created (project filenames are unique, so the race resolves itself via the
 * same conflict error normal duplicate-name handling already throws).
 */
export async function ensureStarterProject(vault: GuildVault): Promise<{ project: Project; created: boolean }> {
  try {
    const project = await vault.createProject(STARTER_PROJECT_TITLE)
    return { project, created: true }
  } catch (e) {
    if (e instanceof TaskFileNameConflictError) {
      const existing = [...vault.projects.values()].find((p) => p.title === STARTER_PROJECT_TITLE)
      if (existing) return { project: existing, created: false }
    }
    throw e
  }
}

const inDays = (n: number): string => today().add({ days: n }).toString()

/** Populates a freshly-created starter project so all three views show something real. */
export async function seedStarterProjectContent(vault: GuildVault, project: Project): Promise<void> {
  await vault.updateProject(project.id, {
    icon: '👋',
    description:
      'A few example tasks so Table, Kanban, and Gantt show real data on your first visit. Rename, edit, or delete anything here — including this project.'
  })
  const { task: proposal } = await vault.insertTask(project.id, {
    title: 'Project Proposal',
    type: 'milestone',
    start: '',
    due: inDays(14)
  })
  const { task: spec } = await vault.insertTask(project.id, {
    title: 'Draft Requirements & Spec',
    dependencies: [proposal.id],
    start: inDays(15),
    due: inDays(21),
    priority: 'high'
  })
  await vault.insertTask(project.id, { title: 'Break the spec into smaller tasks' }, spec.id)
  await vault.insertTask(project.id, {
    title: 'Explore the Table, Kanban, and Gantt views',
    status: 'done',
    priority: 'low',
    description: 'Switch views with the buttons at the top of this project.'
  })
}
