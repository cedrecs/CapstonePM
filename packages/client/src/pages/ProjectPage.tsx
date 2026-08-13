import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import type { FilterState, SavedView, Task } from '@pm/shared'
import {
  applyTaskFilterPromote,
  collectAllAssignees,
  collectAllTags,
  countActiveFilters,
  DEFAULT_PRIORITIES,
  DEFAULT_STATUSES,
  flattenTasks,
  makeDefaultFilter,
  makeId,
  statusSortOrder
} from '@pm/shared'
import { api, ApiError } from '../api'

type SortKey = 'manual' | 'title' | 'status' | 'priority' | 'due' | 'progress'

const COLUMNS: { key: SortKey; label: string; mobile?: boolean }[] = [
  { key: 'title', label: 'Task', mobile: true },
  { key: 'status', label: 'Status', mobile: true },
  { key: 'priority', label: 'Priority' },
  { key: 'due', label: 'Due', mobile: true },
  { key: 'progress', label: 'Progress' }
]

export function ProjectPage() {
  const { projectId } = useParams()
  const queryClient = useQueryClient()
  const me = useQuery({ queryKey: ['me'], queryFn: api.me })
  const project = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => api.project(projectId!),
    enabled: !!projectId
  })

  const [filter, setFilter] = useState<FilterState>(makeDefaultFilter())
  const [sortKey, setSortKey] = useState<SortKey>('manual')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem(`pm-collapsed-${projectId}`) ?? '[]') as string[])
    } catch {
      return new Set()
    }
  })
  const [activeViewId, setActiveViewId] = useState<string | null>(null)
  const [editingTitle, setEditingTitle] = useState<string | null>(null)
  const [quickTitle, setQuickTitle] = useState('')
  const [conflict, setConflict] = useState(false)

  useEffect(() => {
    localStorage.setItem(`pm-collapsed-${projectId}`, JSON.stringify([...collapsed]))
  }, [collapsed, projectId])

  const canWrite = me.data?.role === 'admin' || me.data?.role === 'member'
  const p = project.data
  const statuses = p?.config?.statuses?.length ? p.config.statuses : DEFAULT_STATUSES
  const priorities = p?.config?.priorities?.length ? p.config.priorities : DEFAULT_PRIORITIES

  const assigneeOptions = useMemo(
    () => (p ? collectAllAssignees(p.tasks, p.teamMembers) : []),
    [p]
  )
  const tagOptions = useMemo(() => (p ? collectAllTags(p.tasks) : []), [p])

  const rows = useMemo(() => {
    if (!p) return []
    let tree = applyTaskFilterPromote(p.tasks, filter, statuses)
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
          case 'due': {
            // Empty dates sort last regardless of direction.
            if (!a.due && !b.due) return 0
            if (!a.due) return 1
            if (!b.due) return -1
            return dir * a.due.localeCompare(b.due)
          }
          case 'progress':
            return dir * (a.progress - b.progress)
          default:
            return 0
        }
      }
      const sortTree = (tasks: Task[]): Task[] =>
        [...tasks].sort(cmp).map((t) => (t.subtasks.length ? { ...t, subtasks: sortTree(t.subtasks) } : t))
      tree = sortTree(tree)
    }
    const withCollapse = (tasks: Task[]): Task[] =>
      tasks.map((t) => ({ ...t, collapsed: collapsed.has(t.id), subtasks: withCollapse(t.subtasks) }))
    return flattenTasks(withCollapse(tree)).filter((r) => r.visible)
  }, [p, filter, sortKey, sortDir, collapsed, statuses, priorities])

  const refetch = () => queryClient.invalidateQueries({ queryKey: ['project', projectId] })
  const onMutationError = (e: unknown) => {
    if (e instanceof ApiError && e.status === 409) {
      setConflict(true)
      void refetch()
    }
  }
  const mutationOpts = {
    onSuccess: () => {
      setConflict(false)
      void refetch()
    },
    onError: onMutationError
  }

  const patchTask = useMutation({
    mutationFn: ({ tid, patch }: { tid: string; patch: Partial<Task> }) =>
      api.updateTask(projectId!, tid, patch, p?.rev),
    ...mutationOpts
  })
  const addTask = useMutation({
    mutationFn: (title: string) => api.addTask(projectId!, { title }, p?.rev),
    onSuccess: () => {
      setQuickTitle('')
      mutationOpts.onSuccess()
    },
    onError: onMutationError
  })
  const bulk = useMutation({
    mutationFn: ({ ids, patch }: { ids: string[]; patch: Partial<Task> }) =>
      api.bulkPatch(projectId!, ids, patch, p?.rev),
    onSuccess: () => {
      setSelected(new Set())
      mutationOpts.onSuccess()
    },
    onError: onMutationError
  })
  const bulkArchive = useMutation({
    mutationFn: async ({ ids, archived }: { ids: string[]; archived: boolean }) => {
      for (const tid of ids) await api.updateTask(projectId!, tid, { archived } as Partial<Task>)
    },
    onSuccess: () => {
      setSelected(new Set())
      mutationOpts.onSuccess()
    },
    onError: onMutationError
  })
  const bulkDelete = useMutation({
    mutationFn: (ids: string[]) => api.deleteTasks(projectId!, ids, p?.rev),
    onSuccess: () => {
      setSelected(new Set())
      mutationOpts.onSuccess()
    },
    onError: onMutationError
  })
  const saveViews = useMutation({
    mutationFn: (savedViews: SavedView[]) => api.updateProject(projectId!, { savedViews }, p?.rev),
    ...mutationOpts
  })

  if (project.isLoading) return <div className="page muted">Loading…</div>
  if (!p) return <div className="page muted">Project not found.</div>

  const applyView = (view: SavedView | null): void => {
    setActiveViewId(view?.id ?? null)
    setFilter(view ? { ...view.filter } : makeDefaultFilter())
    setSortKey(view ? ((view.sortKey || 'manual') as SortKey) : 'manual')
    setSortDir(view?.sortDir ?? 'asc')
  }

  const saveCurrentAsView = (): void => {
    const name = window.prompt('Name this view:')
    if (!name?.trim()) return
    const view: SavedView = {
      id: makeId(),
      name: name.trim(),
      filter: { ...filter },
      sortKey: sortKey === 'manual' ? 'status' : sortKey,
      sortDir
    }
    saveViews.mutate([...p.savedViews, view])
    setActiveViewId(view.id)
  }

  const deleteActiveView = (): void => {
    if (!activeViewId) return
    saveViews.mutate(p.savedViews.filter((v) => v.id !== activeViewId))
    applyView(null)
  }

  const headerSort = (key: SortKey): void => {
    if (sortKey === key) {
      if (sortDir === 'asc') setSortDir('desc')
      else {
        setSortKey('manual')
        setSortDir('asc')
      }
    } else {
      setSortKey(key)
      setSortDir('asc')
    }
  }

  const toggleAll = (): void => {
    if (selected.size === rows.length) setSelected(new Set())
    else setSelected(new Set(rows.map((r) => r.task.id)))
  }

  const single = <T,>(v: T | ''): T[] => (v === '' ? [] : [v as T])

  return (
    <div className="page">
      <h2>
        {p.icon} {p.title}
      </h2>
      {conflict && (
        <div className="error-banner">
          Someone else changed this project — the latest state has been reloaded. Try again.
        </div>
      )}

      <div className="filter-bar">
        <input
          value={filter.text}
          onChange={(e) => setFilter({ ...filter, text: e.target.value })}
          placeholder="Search…"
          style={{ minWidth: 140 }}
        />
        <select
          value={filter.statuses[0] ?? ''}
          onChange={(e) => setFilter({ ...filter, statuses: single(e.target.value) })}
        >
          <option value="">All statuses</option>
          {statuses.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
        <select
          value={filter.priorities[0] ?? ''}
          onChange={(e) => setFilter({ ...filter, priorities: single(e.target.value) })}
        >
          <option value="">All priorities</option>
          {priorities.map((pr) => (
            <option key={pr.id} value={pr.id}>
              {pr.label}
            </option>
          ))}
        </select>
        <select
          value={filter.assignees[0] ?? ''}
          onChange={(e) => setFilter({ ...filter, assignees: single(e.target.value) })}
        >
          <option value="">Anyone</option>
          {assigneeOptions.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
        {tagOptions.length > 0 && (
          <select
            value={filter.tags[0] ?? ''}
            onChange={(e) => setFilter({ ...filter, tags: single(e.target.value) })}
          >
            <option value="">All tags</option>
            {tagOptions.map((t) => (
              <option key={t} value={t}>
                #{t}
              </option>
            ))}
          </select>
        )}
        <select
          value={filter.dueDateFilter}
          onChange={(e) => setFilter({ ...filter, dueDateFilter: e.target.value as FilterState['dueDateFilter'] })}
        >
          <option value="any">Any due date</option>
          <option value="overdue">Overdue</option>
          <option value="this-week">This week</option>
          <option value="this-month">This month</option>
          <option value="no-date">No date</option>
        </select>
        <label className="muted" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <input
            type="checkbox"
            checked={filter.showArchived}
            onChange={(e) => setFilter({ ...filter, showArchived: e.target.checked })}
          />
          Archived
        </label>
        {countActiveFilters(filter) > 0 && (
          <button onClick={() => applyView(null)}>Clear</button>
        )}
        <span className="spacer" />
        <select
          value={activeViewId ?? ''}
          onChange={(e) => {
            const view = p.savedViews.find((v) => v.id === e.target.value) ?? null
            applyView(view)
          }}
        >
          <option value="">Views…</option>
          {p.savedViews.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name}
            </option>
          ))}
        </select>
        {canWrite && <button onClick={saveCurrentAsView}>Save view</button>}
        {canWrite && activeViewId && <button onClick={deleteActiveView}>Delete view</button>}
      </div>

      {canWrite && (
        <form
          className="quick-add"
          onSubmit={(e) => {
            e.preventDefault()
            if (quickTitle.trim()) addTask.mutate(quickTitle.trim())
          }}
        >
          <input
            value={quickTitle}
            onChange={(e) => setQuickTitle(e.target.value)}
            placeholder="Quick add a task…"
          />
          <button className="primary" type="submit" disabled={addTask.isPending}>
            Add
          </button>
        </form>
      )}

      {canWrite && selected.size > 0 && (
        <div className="bulk-bar">
          <strong>{selected.size} selected</strong>
          <select
            defaultValue=""
            onChange={(e) => {
              if (e.target.value) bulk.mutate({ ids: [...selected], patch: { status: e.target.value } })
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
              if (e.target.value) bulk.mutate({ ids: [...selected], patch: { priority: e.target.value } })
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
              if (e.target.value) bulk.mutate({ ids: [...selected], patch: { assignees: [e.target.value] } })
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
              if (e.target.value) bulk.mutate({ ids: [...selected], patch: { due: e.target.value } })
            }}
            title="Set due date"
          />
          <button onClick={() => bulkArchive.mutate({ ids: [...selected], archived: true })}>Archive</button>
          <button
            style={{ color: 'var(--danger)' }}
            onClick={() => {
              if (window.confirm(`Delete ${selected.size} task(s)? Files go to the vault trash.`)) {
                bulkDelete.mutate([...selected])
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
                onClick={() => headerSort(col.key)}
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
            const isEditing = editingTitle === task.id
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
                  {isEditing ? (
                    <input
                      autoFocus
                      defaultValue={task.title}
                      onBlur={(e) => {
                        setEditingTitle(null)
                        const title = e.target.value.trim()
                        if (title && title !== task.title) {
                          patchTask.mutate({ tid: task.id, patch: { title } })
                        }
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                        if (e.key === 'Escape') setEditingTitle(null)
                      }}
                    />
                  ) : (
                    <span
                      onDoubleClick={canWrite ? () => setEditingTitle(task.id) : undefined}
                      title={canWrite ? 'Double-click to rename' : undefined}
                    >
                      {task.title}
                    </span>
                  )}
                  {task.archived && <span className="badge muted"> archived</span>}
                </td>
                <td>
                  {canWrite ? (
                    <select
                      value={task.status}
                      onChange={(e) => patchTask.mutate({ tid: task.id, patch: { status: e.target.value } })}
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
                      onChange={(e) => patchTask.mutate({ tid: task.id, patch: { priority: e.target.value } })}
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
                      onChange={(e) => patchTask.mutate({ tid: task.id, patch: { due: e.target.value } })}
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
                        if (v !== task.progress) patchTask.mutate({ tid: task.id, patch: { progress: v } })
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
    </div>
  )
}
