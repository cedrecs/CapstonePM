import { describe, expect, it } from 'vitest'
import { DEFAULT_STATUSES, makeProject, makeTask, type Task } from '../types'
import { hydrateProjectFromFrontmatter, hydrateTaskFromFile } from './YamlHydrator'
import { parseFrontmatter } from './YamlParser'
import { serializeProject, serializeTask } from './YamlSerializer'

// Golden fixtures pin the exact bytes the reference plugin writes. If one of
// these fails after a change, on-disk compatibility with obsidian-pm broke.

const T = '2026-04-01T00:00:00.000Z'

function fixtureProject() {
  const project = makeProject('My Project', 'Projects/my-project.md')
  project.id = 'p-1'
  project.createdAt = T
  project.updatedAt = T
  return project
}

function fixtureTask(overrides: Partial<Task> = {}): Task {
  return makeTask({
    id: 't-1',
    title: 'Design API',
    description: 'Draft the endpoints.',
    status: 'in-progress',
    priority: 'high',
    start: '2026-04-01',
    due: '2026-04-10',
    progress: 50,
    assignees: ['Alice', 'Bob'],
    tags: ['api'],
    filePath: 'Projects/my-project_tasks/design-api.md',
    createdAt: T,
    updatedAt: T,
    ...overrides
  })
}

const GOLDEN_TASK = [
  '---',
  'pm-task: true',
  'projectId: "p-1"',
  'parentId:',
  'id: "t-1"',
  'title: "Design API"',
  'type: "task"',
  'status: "in-progress"',
  'priority: "high"',
  'start: "2026-04-01"',
  'due: "2026-04-10"',
  'progress: 50',
  'assignees: ["Alice", "Bob"]',
  'tags: ["api"]',
  'subtaskIds: []',
  'dependencies: []',
  `createdAt: "${T}"`,
  `updatedAt: "${T}"`,
  '---',
  '',
  'Draft the endpoints.',
  '',
  'Project: [[my-project|My Project]]'
].join('\n')

const GOLDEN_PROJECT = [
  '---',
  'pm-project: true',
  'id: "p-1"',
  'title: "My Project"',
  'description: ""',
  'color: "#8b72be"',
  'icon: "\u{1F4CB}"',
  'taskIds: ["t-1"]',
  'customFields: []',
  'teamMembers: []',
  'savedViews: []',
  `createdAt: "${T}"`,
  `updatedAt: "${T}"`,
  '---',
  '',
  '# \u{1F4CB} My Project',
  '',
  '## Tasks',
  '- [ ] [[design-api|Design API]]',
  ''
].join('\n')

describe('golden fixtures (exact reference-plugin bytes)', () => {
  it('serializes a task to the exact reference format', () => {
    expect(serializeTask(fixtureTask(), fixtureProject(), null, DEFAULT_STATUSES)).toBe(GOLDEN_TASK)
  })

  it('serializes a project to the exact reference format', () => {
    const project = fixtureProject()
    project.tasks = [fixtureTask()]
    expect(serializeProject(project, DEFAULT_STATUSES)).toBe(GOLDEN_PROJECT)
  })
})

describe('byte-stable round-trip (parse -> hydrate -> serialize)', () => {
  it('reproduces the task file byte-for-byte', () => {
    const { frontmatter, body } = parseFrontmatter(GOLDEN_TASK)
    if (!frontmatter) throw new Error('frontmatter missing')
    const { task } = hydrateTaskFromFile(frontmatter, body, 'Projects/my-project_tasks/design-api.md')
    expect(serializeTask(task, fixtureProject(), null, DEFAULT_STATUSES)).toBe(GOLDEN_TASK)
  })

  it('reproduces the project file byte-for-byte', () => {
    const { frontmatter, body } = parseFrontmatter(GOLDEN_PROJECT)
    if (!frontmatter) throw new Error('frontmatter missing')
    const project = hydrateProjectFromFrontmatter(frontmatter, body, 'Projects/my-project.md', 'my-project')
    project.tasks = [fixtureTask()]
    expect(serializeProject(project, DEFAULT_STATUSES)).toBe(GOLDEN_PROJECT)
  })
})

describe('serialization idempotence with all optional fields', () => {
  it('task with completed, recurrence, timeEstimate, timeLogs, customFields, and subtasks', () => {
    const sub = fixtureTask({
      id: 'sub-1',
      title: 'Write Spec',
      type: 'subtask',
      status: 'done',
      completed: '2026-04-05',
      filePath: 'Projects/my-project_tasks/write-spec.md'
    })
    const parent = fixtureTask({
      id: 't-2',
      title: 'Big Feature',
      subtasks: [sub],
      dependencies: ['t-1'],
      recurrence: { interval: 'weekly', every: 2, endDate: '2026-06-01' },
      timeEstimate: 12,
      timeLogs: [
        { date: '2026-04-01', hours: 2, note: 'setup' },
        { date: '2026-04-02', hours: 3.5, note: 'review "quotes" and \\slashes' }
      ],
      customFields: { impact: 'high', score: 42, shipped: false },
      filePath: 'Projects/my-project_tasks/big-feature.md'
    })
    const project = fixtureProject()
    project.tasks = [parent]

    const s1 = serializeTask(parent, project, null, DEFAULT_STATUSES)
    const { frontmatter, body } = parseFrontmatter(s1)
    if (!frontmatter) throw new Error('frontmatter missing')
    const { task } = hydrateTaskFromFile(frontmatter, body, 'Projects/my-project_tasks/big-feature.md')
    // The store reattaches subtasks from subtaskIds; mirror that here.
    task.subtasks = [sub]
    const s2 = serializeTask(task, project, null, DEFAULT_STATUSES)
    expect(s2).toBe(s1)
  })

  it('project with config overrides, custom fields, and saved views', () => {
    const project = fixtureProject()
    project.description = 'Capstone project.'
    project.customFields = [{ id: 'cf1', name: 'Sprint', type: 'text' }]
    project.teamMembers = ['Alice', 'Bob']
    project.savedViews = [
      {
        id: 'v1',
        name: 'High priority',
        filter: {
          text: '',
          statuses: ['in-progress'],
          priorities: ['high'],
          assignees: [],
          tags: [],
          dueDateFilter: 'any',
          showArchived: false
        },
        sortKey: 'due',
        sortDir: 'asc'
      }
    ]
    project.config = { autoSchedule: false, defaultView: 'kanban' }
    project.tasks = [fixtureTask()]

    const s1 = serializeProject(project, DEFAULT_STATUSES)
    const { frontmatter, body } = parseFrontmatter(s1)
    if (!frontmatter) throw new Error('frontmatter missing')
    const rehydrated = hydrateProjectFromFrontmatter(frontmatter, body, 'Projects/my-project.md', 'my-project')
    rehydrated.tasks = [fixtureTask()]
    const s2 = serializeProject(rehydrated, DEFAULT_STATUSES)
    expect(s2).toBe(s1)
  })
})
