import { useEffect, useMemo, useState } from 'react'
import type { PriorityConfig, StatusConfig, Task } from '@pm/shared'
import { flattenTasks, statusSortOrder } from '@pm/shared'

export type SortKey = 'manual' | 'title' | 'status' | 'priority' | 'due' | 'progress'

const COLUMNS: { key: SortKey; label: string; mobile?: boolean }[] = [
  { key: 'title', label: 'Task', mobile: true },
  { key: 'status', label: 'Status', mobile: true },
  { key: 'priority', label: 'Priority' },
  { key: 'due', label: 'Due', mobile: true },
  { key: 'progress', label: 'Progress' }
]

interface TableViewProps {
  projectId: string
  tree: Task[]
  statuses: StatusConfig[]
  priorities: PriorityConfig[]
  assigneeOptions: string[]
  canWrite: boolean
  sortKey: SortKey
  sortDir: 'asc' | 'desc'
  onSort: (key: SortKey) => void
  onPatchTask: (tid: string, patch: Partial<Task>) => void
  onBulk: (ids: string[], patch: Partial<Task>) => void
  onBulkArchive: (ids: string[], archived: boolean) => void
  onBulkDelete: (ids: string[]) => void
  onOpenTask: (tid: string) => void
}

export function TableView({
  projectId,
  tree,
  statuses,
  priorities,
  assigneeOptions,
  canWrite,
  sortKey,
  sortDir,
  onSort,
  onPatchTask,
  onBulk,
  onBulkArchive,
  onBulkDelete,
  onOpenTask
}: TableViewProps) {
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem(`pm-collapsed-${projectId}`) ?? '[]') as string[])
    } catch {
      return new Set()
    }
  })

  useEffect(() => {
    localStorage.setItem(`pm-collapsed-${projectId}`, JSON.stringify([...collapsed]))
  }, [collapsed, projectId])

  const rows = useMemo(() => {
    let sorted = tree
    if (sortKey !== 'manual') {
      const dir = sortDir === 'asc' ? 1 : -1
      const cmp = (a: Task, b: Task): number => {
        switch (sortKey) {
          case 'title':
            return dir * a.title.localeCompare(b.title)
          case 'status':
            return dir * (statusSortOrder(a.status, statuses) - statusSortOrder(b.status, statuses))
          case 'priority': {
            const idx = (t: Task) => {
              const i = priorities.findIndex((pr) => pr.id === t.priority)
              return i < 0 ? 999 : i
            }
            return dir * (idx(a) - idx(b))
          }
          case 'due':
            // Empty dates sort last regardless of direction.
            if (!a.due && !b.due) return 0
            if (!a.due) return 1
            if (!b.due) return -1
            return dir * a.due.localeCompare(b.due)
          case 'progress':
            return dir * (a.progress - b.progress)
          default:
            return 0
        }
      }
      const sortTree = (tasks: Task[]): Task[] =>
        [...tasks].sort(cmp).map((t) => (t.subtasks.length ? { ...t, subtasks: sortTree(t.subtasks) } : t))
      sorted = sortTree(tree)
    }
    const withCollapse = (tasks: Task[]): Task[] =>
      tasks.map((t) => ({ ...t, collapsed: collapsed.has(t.id), subtasks: withCollapse(t.subtasks) }))
    return flattenTasks(withCollapse(sorted)).filter((r) => r.visible)
  }, [tree, sortKey, sortDir, collapsed, statuses, priorities])

  const toggleAll = (): void => {
    if (selected.size === rows.length) setSelected(new Set())
    else setSelected(new Set(rows.map((r) => r.task.id)))
  }

  const clearAnd = (fn: () => void): void => {
    fn()
    setSelected(new Set())
  }

  return (
    <>
      {canWrite && selected.size > 0 && (
        <div className="bulk-bar">
          <strong>{selected.size} selected</strong>
          <select
            defaultValue=""
            onChange={(e) => {
              if (e.target.value) clearAnd(() => onBulk([...selected], { status: e.target.value }))
              e.target.value = ''
            }}
          >
            <option value="">Set status…</option>
            {statuses.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
          <select
            defaultValue=""
            onChange={(e) => {
              if (e.target.value) clearAnd(() => onBulk([...selected], { priority: e.target.value }))
              e.target.value = ''
            }}
          >
            <option value="">Set priority…</option>
            {priorities.map((pr) => (
              <option key={pr.id} value={pr.id}>
                {pr.label}
              </option>
            ))}
          </select>
          <select
            defaultValue=""
            onChange={(e) => {
              if (e.target.value) clearAnd(() => onBulk([...selected], { assignees: [e.target.value] }))
              e.target.value = ''
            }}
          >
            <option value="">Assign to…</option>
            {assigneeOptions.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
          <input
            type="date"
            onChange={(e) => {
              if (e.target.value) clearAnd(() => onBulk([...selected], { due: e.target.value }))
            }}
            title="Set due date"
          />
          <button onClick={() => clearAnd(() => onBulkArchive([...selected], true))}>Archive</button>
          <button
            style={{ color: 'var(--danger)' }}
            onClick={() => {
              if (window.confirm(`Delete ${selected.size} task(s)? Files go to the vault trash.`)) {
                clearAnd(() => onBulkDelete([...selected]))
              }
            }}
          >
            Delete
          </button>
          <button onClick={() => setSelected(new Set())}>Clear</button>
        </div>
      )}

      <table className="task-table">
        <thead>
          <tr>
            {canWrite && (
              <th style={{ width: 28 }}>
                <input
                  type="checkbox"
                  checked={rows.length > 0 && selected.size === rows.length}
                  onChange={toggleAll}
                />
              </th>
            )}
            {COLUMNS.map((col) => (
              <th
                key={col.key}
                className={col.mobile ? '' : 'hide-mobile'}
                onClick={() => onSort(col.key)}
                style={{ cursor: 'pointer', userSelect: 'none' }}
              >
                {col.label}
                {sortKey === col.key ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ''}
              </th>
            ))}
            <th className="hide-mobile">Assignees</th>
            <th className="hide-mobile">Tags</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ task, depth }) => {
            const st = statuses.find((s) => s.id === task.status)
            return (
              <tr key={task.id} style={task.archived ? { opacity: 0.55 } : undefined}>
                {canWrite && (
                  <td>
                    <input
                      type="checkbox"
                      checked={selected.has(task.id)}
                      onChange={(e) => {
                        const next = new Set(selected)
                        if (e.target.checked) next.add(task.id)
                        else next.delete(task.id)
                        setSelected(next)
                      }}
                    />
                  </td>
                )}
                <td>
                  <span className="indent" style={{ width: depth * 20 }} />
                  {task.subtasks.length > 0 && (
                    <button
                      className="collapse-btn"
                      onClick={() => {
                        const next = new Set(collapsed)
                        if (next.has(task.id)) next.delete(task.id)
                        else next.add(task.id)
                        setCollapsed(next)
                      }}
                    >
                      {collapsed.has(task.id) ? '▸' : '▾'}
                    </button>
                  )}
                  {task.type === 'milestone' ? '◆ ' : ''}
                  <span className="task-title-link" onClick={() => onOpenTask(task.id)} title="Open task">
                    {task.title}
                  </span>
                  {task.archived && <span className="badge muted"> archived</span>}
                </td>
                <td>
                  {canWrite ? (
                    <select
                      value={task.status}
                      onChange={(e) => onPatchTask(task.id, { status: e.target.value })}
                    >
                      {statuses.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.label}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span className="badge" style={{ borderColor: st?.color, color: st?.color }}>
                      {st?.label ?? task.status}
                    </span>
                  )}
                </td>
                <td className="hide-mobile">
                  {canWrite ? (
                    <select
                      value={task.priority}
                      onChange={(e) => onPatchTask(task.id, { priority: e.target.value })}
                    >
                      {priorities.map((pr) => (
                        <option key={pr.id} value={pr.id}>
                          {pr.label}
                        </option>
                      ))}
                    </select>
                  ) : (
                    (priorities.find((pr) => pr.id === task.priority)?.label ?? task.priority)
                  )}
                </td>
                <td>
                  {canWrite ? (
                    <input
                      type="date"
                      value={task.due}
                      onChange={(e) => onPatchTask(task.id, { due: e.target.value })}
                      style={{ width: 130 }}
                    />
                  ) : (
                    <span className="muted">{task.due || '—'}</span>
                  )}
                </td>
                <td className="hide-mobile">
                  {canWrite ? (
                    <input
                      type="number"
                      min={0}
                      max={100}
                      defaultValue={task.progress}
                      key={`${task.id}-${task.progress}`}
                      onBlur={(e) => {
                        const v = Math.max(0, Math.min(100, Number(e.target.value)))
                        if (v !== task.progress) onPatchTask(task.id, { progress: v })
                      }}
                      style={{ width: 64 }}
                    />
                  ) : (
                    <span className="muted">{task.progress}%</span>
                  )}
                </td>
                <td className="hide-mobile muted">{task.assignees.join(', ')}</td>
                <td className="hide-mobile muted">{task.tags.map((t) => `#${t}`).join(' ')}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
      {rows.length === 0 && <p className="muted">No tasks match.</p>}
    </>
  )
}
