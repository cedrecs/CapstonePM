import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api } from '../api'

export function ProjectsPage() {
  const { guildId } = useParams()
  const queryClient = useQueryClient()
  const projects = useQuery({ queryKey: ['projects'], queryFn: api.projects })
  const me = useQuery({ queryKey: ['me'], queryFn: api.me })
  const [title, setTitle] = useState('')

  const create = useMutation({
    mutationFn: (t: string) => api.createProject(t),
    onSuccess: () => {
      setTitle('')
      void queryClient.invalidateQueries({ queryKey: ['projects'] })
    }
  })

  return (
    <div className="page">
      <h2>Projects</h2>
      {me.data?.role === 'admin' && (
        <form
          className="quick-add"
          onSubmit={(e) => {
            e.preventDefault()
            if (title.trim()) create.mutate(title.trim())
          }}
        >
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="New project name…"
          />
          <button className="primary" type="submit" disabled={create.isPending}>
            Create
          </button>
        </form>
      )}
      {projects.isLoading && <p className="muted">Loading…</p>}
      <div className="project-grid">
        {projects.data?.map((p) => (
          <Link key={p.id} to={`/g/${guildId}/p/${p.id}`} className="project-card">
            <div className="title">
              {p.icon} {p.title}
            </div>
            <div className="meta">
              {p.doneCount}/{p.taskCount} tasks done
            </div>
          </Link>
        ))}
      </div>
      {projects.data?.length === 0 && <p className="muted">No projects yet.</p>}
    </div>
  )
}
