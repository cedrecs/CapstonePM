import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { Link, Outlet, useParams } from 'react-router-dom'
import { api, openChangeSocket } from '../api'

export function GuildLayout() {
  const { guildId } = useParams()
  const queryClient = useQueryClient()
  const me = useQuery({ queryKey: ['me'], queryFn: api.me })

  // Live updates: any vault change invalidates the affected queries.
  useEffect(() => {
    return openChangeSocket((change) => {
      void queryClient.invalidateQueries({ queryKey: ['projects'] })
      if (change.projectId) {
        void queryClient.invalidateQueries({ queryKey: ['project', change.projectId] })
      }
    })
  }, [queryClient])

  return (
    <>
      <header className="topbar">
        <Link to={`/g/${guildId}/p`} style={{ fontWeight: 700, color: 'var(--text)' }}>
          📋 PM
        </Link>
        <span className="spacer" />
        {me.data?.role === 'admin' && (
          <Link to={`/g/${guildId}/settings`} className="muted" title="Settings">
            ⚙️
          </Link>
        )}
        {me.data && (
          <span className="muted">
            {me.data.userName} · {me.data.role}
          </span>
        )}
      </header>
      <Outlet />
    </>
  )
}
