import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { api, type AppRole, type GuildSettings } from '../api'

const APP_ROLES: AppRole[] = ['admin', 'member', 'advisor', 'sponsor']

/**
 * Admin-only guild settings. Discord role/user IDs are entered by hand for
 * now; Phase 3's bot will offer pickers with real names.
 */
export function SettingsPage() {
  const queryClient = useQueryClient()
  const me = useQuery({ queryKey: ['me'], queryFn: api.me })
  const settings = useQuery({ queryKey: ['settings'], queryFn: api.settings })
  const [draft, setDraft] = useState<GuildSettings | null>(null)
  const [savedAt, setSavedAt] = useState<number | null>(null)

  useEffect(() => {
    if (settings.data && !draft) setDraft(structuredClone(settings.data))
  }, [settings.data, draft])

  const save = useMutation({
    mutationFn: (patch: Partial<GuildSettings>) => api.updateSettings(patch),
    onSuccess: (fresh) => {
      queryClient.setQueryData(['settings'], fresh)
      setDraft(structuredClone(fresh))
      setSavedAt(Date.now())
    }
  })

  if (me.data && me.data.role !== 'admin') {
    return <div className="page muted">Settings are admin-only.</div>
  }
  if (!draft) return <div className="page muted">Loading…</div>

  const pm = draft.pm
  const setPm = (patch: Partial<GuildSettings['pm']>): void =>
    setDraft({ ...draft, pm: { ...pm, ...patch } })
  const setDiscord = (patch: Partial<GuildSettings['discord']>): void =>
    setDraft({ ...draft, discord: { ...draft.discord, ...patch } })

  return (
    <div className="page" style={{ maxWidth: 760 }}>
      <h2>Settings</h2>

      <section className="settings-section">
        <h3>Team roster</h3>
        <p className="muted">Names usable as assignees, in addition to anyone already on tasks.</p>
        <ListEditor
          items={pm.globalTeamMembers}
          placeholder="Add teammate name…"
          onChange={(globalTeamMembers) => setPm({ globalTeamMembers })}
        />
      </section>

      <section className="settings-section">
        <h3>Statuses</h3>
        <table className="task-table">
          <thead>
            <tr>
              <th>Id</th>
              <th>Label</th>
              <th>Color</th>
              <th>Counts as done</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {pm.statuses.map((s, i) => (
              <tr key={s.id}>
                <td className="muted">{s.id}</td>
                <td>
                  <input
                    value={s.label}
                    onChange={(e) => {
                      const statuses = [...pm.statuses]
                      statuses[i] = { ...s, label: e.target.value }
                      setPm({ statuses })
                    }}
                  />
                </td>
                <td>
                  <input
                    type="color"
                    value={s.color}
                    onChange={(e) => {
                      const statuses = [...pm.statuses]
                      statuses[i] = { ...s, color: e.target.value }
                      setPm({ statuses })
                    }}
                  />
                </td>
                <td>
                  <input
                    type="checkbox"
                    checked={s.complete}
                    onChange={(e) => {
                      const statuses = [...pm.statuses]
                      statuses[i] = { ...s, complete: e.target.checked }
                      setPm({ statuses })
                    }}
                  />
                </td>
                <td>
                  <button
                    onClick={() => setPm({ statuses: pm.statuses.filter((x) => x.id !== s.id) })}
                    disabled={pm.statuses.length <= 1}
                  >
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <AddIdRow
          placeholder="new-status-id"
          onAdd={(id) =>
            setPm({
              statuses: [...pm.statuses, { id, label: id, color: '#8a94a0', icon: '', complete: false }]
            })
          }
          taken={pm.statuses.map((s) => s.id)}
        />
      </section>

      <section className="settings-section">
        <h3>Priorities</h3>
        <table className="task-table">
          <tbody>
            {pm.priorities.map((p, i) => (
              <tr key={p.id}>
                <td className="muted">{p.id}</td>
                <td>
                  <input
                    value={p.label}
                    onChange={(e) => {
                      const priorities = [...pm.priorities]
                      priorities[i] = { ...p, label: e.target.value }
                      setPm({ priorities })
                    }}
                  />
                </td>
                <td>
                  <input
                    type="color"
                    value={p.color}
                    onChange={(e) => {
                      const priorities = [...pm.priorities]
                      priorities[i] = { ...p, color: e.target.value }
                      setPm({ priorities })
                    }}
                  />
                </td>
                <td>
                  <button
                    onClick={() => setPm({ priorities: pm.priorities.filter((x) => x.id !== p.id) })}
                    disabled={pm.priorities.length <= 1}
                  >
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <AddIdRow
          placeholder="new-priority-id"
          onAdd={(id) =>
            setPm({ priorities: [...pm.priorities, { id, label: id, color: '#8a94a0', icon: '' }] })
          }
          taken={pm.priorities.map((p) => p.id)}
        />
      </section>

      <section className="settings-section">
        <h3>Scheduling & notifications</h3>
        <label className="settings-row">
          <input
            type="checkbox"
            checked={pm.autoSchedule}
            onChange={(e) => setPm({ autoSchedule: e.target.checked })}
          />
          Auto-shift dependent tasks when dates change
        </label>
        <label className="settings-row">
          <input
            type="checkbox"
            checked={pm.pullForwardOnEarlyFinish}
            onChange={(e) => setPm({ pullForwardOnEarlyFinish: e.target.checked })}
          />
          Pull dependents forward when a task finishes early
        </label>
        <label className="settings-row">
          <input
            type="checkbox"
            checked={pm.notificationsEnabled}
            onChange={(e) => setPm({ notificationsEnabled: e.target.checked })}
          />
          Due-date reminders in Discord
        </label>
        <label className="settings-row">
          Remind
          <input
            type="number"
            min={0}
            max={14}
            value={pm.notificationLeadDays}
            onChange={(e) => setPm({ notificationLeadDays: Number(e.target.value) })}
            style={{ width: 60, margin: '0 6px' }}
          />
          days before due
        </label>
      </section>

      <section className="settings-section">
        <h3>Discord role mapping</h3>
        <p className="muted">
          Discord role ID → app role. Members with no mapped role default to <code>member</code>.
          (Right-click a role in Discord → Copy Role ID, with developer mode on.)
        </p>
        <MapEditor
          entries={draft.discord.roleMap}
          valueOptions={APP_ROLES}
          keyPlaceholder="Discord role ID"
          onChange={(roleMap) => setDiscord({ roleMap: roleMap as Record<string, AppRole> })}
        />
      </section>

      <section className="settings-section">
        <h3>Discord user → assignee name</h3>
        <p className="muted">Used to @mention the right person in reminders.</p>
        <MapEditor
          entries={draft.discord.userMap}
          keyPlaceholder="Discord user ID"
          valuePlaceholder="Assignee name"
          onChange={(userMap) => setDiscord({ userMap })}
        />
      </section>

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', margin: '20px 0' }}>
        <button
          className="primary"
          disabled={save.isPending}
          onClick={() => save.mutate({ pm: draft.pm, discord: draft.discord })}
        >
          Save settings
        </button>
        {savedAt && Date.now() - savedAt < 4000 && <span style={{ color: 'var(--ok)' }}>Saved ✓</span>}
        {save.isError && <span style={{ color: 'var(--danger)' }}>Save failed</span>}
      </div>
    </div>
  )
}

function ListEditor({
  items,
  placeholder,
  onChange
}: {
  items: string[]
  placeholder: string
  onChange: (items: string[]) => void
}) {
  const [value, setValue] = useState('')
  return (
    <div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
        {items.map((item) => (
          <span key={item} className="badge" style={{ borderColor: 'var(--border)' }}>
            {item}{' '}
            <button
              style={{ border: 'none', background: 'none', padding: 0, color: 'var(--text-dim)' }}
              onClick={() => onChange(items.filter((x) => x !== item))}
              aria-label={`Remove ${item}`}
            >
              ×
            </button>
          </span>
        ))}
      </div>
      <form
        style={{ display: 'flex', gap: 6 }}
        onSubmit={(e) => {
          e.preventDefault()
          const v = value.trim()
          if (v && !items.includes(v)) onChange([...items, v])
          setValue('')
        }}
      >
        <input value={value} onChange={(e) => setValue(e.target.value)} placeholder={placeholder} />
        <button type="submit">Add</button>
      </form>
    </div>
  )
}

function AddIdRow({
  placeholder,
  taken,
  onAdd
}: {
  placeholder: string
  taken: string[]
  onAdd: (id: string) => void
}) {
  const [value, setValue] = useState('')
  return (
    <form
      style={{ display: 'flex', gap: 6, marginTop: 8 }}
      onSubmit={(e) => {
        e.preventDefault()
        const id = value.trim().toLowerCase().replace(/\s+/g, '-')
        if (id && !taken.includes(id)) onAdd(id)
        setValue('')
      }}
    >
      <input value={value} onChange={(e) => setValue(e.target.value)} placeholder={placeholder} />
      <button type="submit">Add</button>
    </form>
  )
}

function MapEditor({
  entries,
  onChange,
  keyPlaceholder,
  valuePlaceholder,
  valueOptions
}: {
  entries: Record<string, string>
  onChange: (entries: Record<string, string>) => void
  keyPlaceholder: string
  valuePlaceholder?: string
  valueOptions?: string[]
}) {
  const [key, setKey] = useState('')
  const [value, setValue] = useState(valueOptions?.[0] ?? '')
  return (
    <div>
      {Object.entries(entries).map(([k, v]) => (
        <div key={k} style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
          <code>{k}</code>
          <span className="muted">→</span>
          {valueOptions ? (
            <select
              value={v}
              onChange={(e) => onChange({ ...entries, [k]: e.target.value })}
            >
              {valueOptions.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          ) : (
            <input value={v} onChange={(e) => onChange({ ...entries, [k]: e.target.value })} />
          )}
          <button
            onClick={() => {
              const next = { ...entries }
              delete next[k]
              onChange(next)
            }}
          >
            Remove
          </button>
        </div>
      ))}
      <form
        style={{ display: 'flex', gap: 6 }}
        onSubmit={(e) => {
          e.preventDefault()
          const k = key.trim()
          if (k && !(k in entries) && value) onChange({ ...entries, [k]: value })
          setKey('')
        }}
      >
        <input value={key} onChange={(e) => setKey(e.target.value)} placeholder={keyPlaceholder} />
        {valueOptions ? (
          <select value={value} onChange={(e) => setValue(e.target.value)}>
            {valueOptions.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        ) : (
          <input value={value} onChange={(e) => setValue(e.target.value)} placeholder={valuePlaceholder} />
        )}
        <button type="submit">Add</button>
      </form>
    </div>
  )
}
