import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import type { FilterState, SavedView, Task, ViewMode } from '@pm/shared'
import {
  applyTaskFilterPromote,
  collectAllAssignees,
  collectAllTags,
  countActiveFilters,
  DEFAULT_PRIORITIES,
  DEFAULT_STATUSES,
  makeDefaultFilter,
  makeId
} from '@pm/shared'
import { api, ApiError } from '../api'
import { GanttView } from '../views/GanttView'
import { KanbanView } from '../views/KanbanView'
import { TableView, type SortKey } from '../views/TableView'

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
  const [activeViewId, setActiveViewId] = useState<string | null>(null)
  const [viewMode, setViewMode] = useState<ViewMode | null>(null)
  const [showSubtaskCards, setShowSubtaskCards] = useState(false)
  const [quickTitle, setQuickTitle] = useState('')
  const [conflict, setConflict] = useState(false)

  const canWrite = me.data?.role === 'admin' || me.data?.role === 'member'
  const p = project.data
  const statuses = p?.config?.statuses?.length ? p.config.statuses : DEFAULT_STATUSES
  const priorities = p?.config?.priorities?.length ? p.config.priorities : DEFAULT_PRIORITIES
  const activeView: ViewMode = viewMode ?? p?.config?.defaultView ?? 'table'

  const assigneeOptions = useMemo(() => (p ? collectAllAssignees(p.tasks, p.teamMembers) : []), [p])
  const tagOptions = useMemo(() => (p ? collectAllTags(p.tasks) : []), [p])
  const filteredTree = useMemo(
    () => (p ? applyTaskFilterPromote(p.tasks, filter, statuses) : []),
    [p, filter, statuses]
  )

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
    ...mutationOpts
  })
  const bulkArchive = useMutation({
    mutationFn: async ({ ids, archived }: { ids: string[]; archived: boolean }) => {
      for (const tid of ids) await api.updateTask(projectId!, tid, { archived } as Partial<Task>)
    },
    ...mutationOpts
  })
  const bulkDelete = useMutation({
    mutationFn: (ids: string[]) => api.deleteTasks(projectId!, ids, p?.rev),
    ...mutationOpts
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
    if (view?.viewMode) setViewMode(view.viewMode)
  }

  const saveCurrentAsView = (): void => {
    const name = window.prompt('Name this view:')
    if (!name?.trim()) return
    const view: SavedView = {
      id: makeId(),
      name: name.trim(),
      filter: { ...filter },
      sortKey: sortKey === 'manual' ? 'status' : sortKey,
      sortDir,
      viewMode: activeView
    }
    saveViews.mutate([...p.savedViews, view])
    setActiveViewId(view.id)
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

  const single = <T,>(v: T | ''): T[] => (v === '' ? [] : [v as T])

  return (
    <div className="page">
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
        <h2 style={{ marginRight: 'auto' }}>
          {p.icon} {p.title}
        </h2>
        <div className="view-switcher">
          {(['table', 'kanban', 'gantt'] as ViewMode[]).map((mode) => (
            <button
              key={mode}
              className={activeView === mode ? 'primary' : ''}
              onClick={() => setViewMode(mode)}
            >
              {mode === 'table' ? 'Table' : mode === 'kanban' ? 'Kanban' : 'Gantt'}
            </button>
          ))}
        </div>
      </div>

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
          onChange={(e) =>
            setFilter({ ...filter, dueDateFilter: e.target.value as FilterState['dueDateFilter'] })
          }
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
        {countActiveFilters(filter) > 0 && <button onClick={() => applyView(null)}>Clear</button>}
        <span className="spacer" />
        <select
          value={activeViewId ?? ''}
          onChange={(e) => applyView(p.savedViews.find((v) => v.id === e.target.value) ?? null)}
        >
          <option value="">Views…</option>
          {p.savedViews.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name}
            </option>
          ))}
        </select>
        {canWrite && <button onClick={saveCurrentAsView}>Save view</button>}
        {canWrite && activeViewId && (
          <button
            onClick={() => {
              saveViews.mutate(p.savedViews.filter((v) => v.id !== activeViewId))
              applyView(null)
            }}
          >
            Delete view
          </button>
        )}
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

      {activeView === 'gantt' ? (
        <GanttView
          tasks={filteredTree}
          statuses={statuses}
          canWrite={canWrite}
          onPatchTask={(tid, patch) => patchTask.mutate({ tid, patch })}
        />
      ) : activeView === 'kanban' ? (
        <KanbanView
          tasks={filteredTree}
          statuses={statuses}
          priorities={priorities}
          canWrite={canWrite}
          showSubtasks={showSubtaskCards}
          onSetStatus={(tid, status) => patchTask.mutate({ tid, patch: { status } })}
          onToggleSubtasks={setShowSubtaskCards}
        />
      ) : (
        <TableView
          projectId={projectId!}
          tree={filteredTree}
          statuses={statuses}
          priorities={priorities}
          assigneeOptions={assigneeOptions}
          canWrite={canWrite}
          sortKey={sortKey}
          sortDir={sortDir}
          onSort={headerSort}
          onPatchTask={(tid, patch) => patchTask.mutate({ tid, patch })}
          onBulk={(ids, patch) => bulk.mutate({ ids, patch })}
          onBulkArchive={(ids, archived) => bulkArchive.mutate({ ids, archived })}
          onBulkDelete={(ids) => bulkDelete.mutate(ids)}
        />
      )}
    </div>
  )
}
