import { describe, expect, it } from 'vitest'
import type { Project, Task } from '@pm/shared'
import { DEFAULT_STATUSES, makeProject, makeTask, today } from '@pm/shared'
import { buildDigestData, buildStatusEmbedData, collectDueReminders, duePhrase } from './content'

function projectWith(tasks: Task[]): Project {
  const p = makeProject('Capstone', 'Projects/Capstone.md')
  p.id = 'p1'
  p.tasks = tasks
  return p
}

const inDays = (n: number): string => today().add({ days: n }).toString()

describe('buildStatusEmbedData', () => {
  it('computes counts, percent complete, overdue, and milestones', () => {
    const p = projectWith([
      makeTask({ id: 'a', title: 'Done thing', status: 'done', completed: inDays(-1) }),
      makeTask({ id: 'b', title: 'Late thing', status: 'in-progress', due: inDays(-3) }),
      makeTask({ id: 'c', title: 'Gate', type: 'milestone', start: '', due: inDays(5) }),
      makeTask({ id: 'd', title: 'Future', due: inDays(10) })
    ])
    const data = buildStatusEmbedData(p, DEFAULT_STATUSES, 'https://pm.example', 'g1')
    expect(data.percentComplete).toBe(25)
    expect(data.totalOpen).toBe(3)
    expect(data.url).toBe('https://pm.example/g/g1/p/p1')
    expect(data.overdue).toHaveLength(1)
    expect(data.overdue[0].title).toBe('Late thing')
    expect(data.upcomingMilestones).toEqual([{ title: 'Gate', due: inDays(5) }])
    expect(data.countsLine).toContain('Done')
  })

  it('ignores archived tasks', () => {
    const p = projectWith([
      makeTask({ id: 'a', status: 'todo', due: inDays(-1), archived: true }),
      makeTask({ id: 'b', status: 'todo' })
    ])
    const data = buildStatusEmbedData(p, DEFAULT_STATUSES, 'u', 'g')
    expect(data.overdue).toHaveLength(0)
    expect(data.totalOpen).toBe(1)
  })
})

describe('collectDueReminders', () => {
  it('collects tasks due within lead days, skipping done and already-reminded', () => {
    const p = projectWith([
      makeTask({ id: 'soon', title: 'Soon', due: inDays(1) }),
      makeTask({ id: 'today', title: 'Today', due: inDays(0) }),
      makeTask({ id: 'far', title: 'Far', due: inDays(9) }),
      makeTask({ id: 'done', title: 'Done', due: inDays(1), status: 'done' }),
      makeTask({ id: 'pinged', title: 'Pinged', due: inDays(1) })
    ])
    const out = collectDueReminders(p, DEFAULT_STATUSES, 2, { pinged: today().toString() })
    expect(out.map((r) => r.task.id).sort()).toEqual(['soon', 'today'])
  })

  it('re-reminds on a later day', () => {
    const p = projectWith([makeTask({ id: 'x', due: inDays(0) })])
    const out = collectDueReminders(p, DEFAULT_STATUSES, 2, { x: inDays(-1) })
    expect(out).toHaveLength(1)
  })
})

describe('buildDigestData', () => {
  it('buckets completed, due, overdue, blocked, and hours', () => {
    const p = projectWith([
      makeTask({ id: 'a', title: 'Shipped', status: 'done', completed: inDays(-2) }),
      makeTask({ id: 'old', title: 'Old ship', status: 'done', completed: inDays(-20) }),
      makeTask({ id: 'b', title: 'Due soon', due: inDays(3) }),
      makeTask({ id: 'c', title: 'Late', due: inDays(-1) }),
      makeTask({ id: 'd', title: 'Stuck', status: 'blocked' }),
      makeTask({
        id: 'e',
        title: 'Logged',
        assignees: ['Alice'],
        timeLogs: [
          { date: inDays(-1), hours: 3, note: '' },
          { date: inDays(-30), hours: 99, note: 'too old' }
        ]
      })
    ])
    const d = buildDigestData(p, DEFAULT_STATUSES)
    expect(d.completedLastWeek).toEqual(['Shipped'])
    expect(d.dueThisWeek.map((t) => t.title)).toEqual(['Due soon'])
    expect(d.overdue.map((t) => t.title)).toEqual(['Late'])
    expect(d.blocked).toEqual(['Stuck'])
    expect(d.hoursByMember).toEqual({ Alice: 3 })
  })
})

describe('duePhrase', () => {
  it('phrases overdue, today, tomorrow, and future', () => {
    expect(duePhrase(inDays(-2))).toContain('2 days overdue')
    expect(duePhrase(inDays(0))).toContain('due today')
    expect(duePhrase(inDays(1))).toBe('due tomorrow')
    expect(duePhrase(inDays(4))).toBe('due in 4 days')
  })
})
