import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { Link, Outlet, useParams } from 'react-router-dom'
import { api, openChangeSocket } from '../api'

export function GuildLayout() {
  const { guildId } = useParams()
  const queryClient = useQueryClient()
  const me = useQuery({ queryKey: ['me'], queryFn: api.me })

  // The session cookie is scoped to whichever guild was last logged into and
  // stays valid across any URL for up to 7 days. Without this check, opening
  // a different guild's link while an old session is still active would
  // silently render THAT guild's data under THIS guild's URL — no error, no
  // visible sign anything was wrong, just the wrong server's content.
  const guildMismatch = !!me.data && me.data.guildId !== guildId
  useEffect(() => {
    if (guildMismatch && guildId) {
      location.href = `/auth/login?guild=${guildId}&redirect=${encodeURIComponent(location.pathname)}`
    }
  }, [guildMismatch, guildId])

  // Live updates: any vault change invalidates the affected queries.
  useEffect(() => {
    return openChangeSocket((change) => {
      void queryClient.invalidateQueries({ queryKey: ['projects'] })
      if (change.projectId) {
        void queryClient.invalidateQueries({ queryKey: ['project', change.projectId] })
      }
    })
  }, [queryClient])

  // Block rendering while loading or mid-redirect, so a flash of the wrong
  // guild's data never appears before the corrected login completes.
  if (me.isLoading || guildMismatch) return null

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
