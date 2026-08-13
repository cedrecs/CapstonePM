import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useParams } from 'react-router-dom'
import type { Task } from '@pm/shared'
import { DEFAULT_PRIORITIES, DEFAULT_STATUSES, flattenTasks } from '@pm/shared'
import { api, ApiError, type ProjectDTO } from '../api'

function statusConfig(project: ProjectDTO | undefined, id: string) {
  const list = project?.config?.statuses?.length ? project.config.statuses : DEFAULT_STATUSES
  return list.find((s) => s.id === id)
}

export function ProjectPage() {
  const { projectId } = useParams()
  const queryClient = useQueryClient()
  const me = useQuery({ queryKey: ['me'], queryFn: api.me })
  const project = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => api.project(projectId!),
    enabled: !!projectId
  })
  const [quickTitle, setQuickTitle] = useState('')
  const [conflict, setConflict] = useState(false)

  const canWrite = me.data?.role === 'admin' || me.data?.role === 'member'
  const statuses = project.data?.config?.statuses?.length
    ? project.data.config.statuses
    : DEFAULT_STATUSES
  const priorities = project.data?.config?.priorities?.length
    ? project.data.config.priorities
    : DEFAULT_PRIORITIES

  const refetch = () => queryClient.invalidateQueries({ queryKey: ['project', projectId] })

  const onMutationError = (e: unknown) => {
    if (e instanceof ApiError && e.status === 409) {
      setConflict(true)
      void refetch()
    }
  }

  const patchTask = useMutation({
    mutationFn: ({ tid, patch }: { tid: string; patch: Partial<Task> }) =>
      api.updateTask(projectId!, tid, patch, project.data?.rev),
    onSuccess: () => {
      setConflict(false)
      void refetch()
    },
    onError: onMutationError
  })

  const addTask = useMutation({
    mutationFn: (title: string) => api.addTask(projectId!, { title }, project.data?.rev),
    onSuccess: () => {
      setQuickTitle('')
      setConflict(false)
      void refetch()
    },
    onError: onMutationError
  })

  if (project.isLoading) return <div className="page muted">Loading…</div>
  if (!project.data) return <div className="page muted">Project not found.</div>

  const p = project.data
  const rows = flattenTasks(p.tasks).filter((r) => !r.task.archived)

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
      <table className="task-table">
        <thead>
          <tr>
            <th style={{ width: '40%' }}>Task</th>
            <th>Status</th>
            <th className="hide-mobile">Priority</th>
            <th className="hide-mobile">Assignees</th>
            <th>Due</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ task, depth }) => {
            const st = statusConfig(p, task.status)
            return (
              <tr key={task.id}>
                <td>
                  <span className="indent" style={{ width: depth * 20 }} />
                  {task.type === 'milestone' ? '◆ ' : ''}
                  {task.title}
                </td>
                <td>
                  {canWrite ? (
                    <select
                      value={task.status}
                      onChange={(e) =>
                        patchTask.mutate({ tid: task.id, patch: { status: e.target.value } })
                      }
                    >
                      {statuses.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.label}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span
                      className="badge"
                      style={{ borderColor: st?.color, color: st?.color }}
                    >
                      {st?.label ?? task.status}
                    </span>
                  )}
                </td>
                <td className="hide-mobile">
                  {canWrite ? (
                    <select
                      value={task.priority}
                      onChange={(e) =>
                        patchTask.mutate({ tid: task.id, patch: { priority: e.target.value } })
                      }
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
                <td className="hide-mobile muted">{task.assignees.join(', ')}</td>
                <td className="muted">{task.due || '—'}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
      {rows.length === 0 && <p className="muted">No tasks yet.</p>}
    </div>
  )
}
