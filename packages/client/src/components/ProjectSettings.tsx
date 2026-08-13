import { useState } from 'react'
import type { CustomFieldDef, PriorityConfig, ProjectConfig, StatusConfig, ViewMode } from '@pm/shared'
import { DEFAULT_PRIORITIES, DEFAULT_STATUSES, makeId } from '@pm/shared'
import type { ProjectDTO } from '../api'

const FIELD_TYPES: CustomFieldDef['type'][] = [
  'text',
  'number',
  'date',
  'select',
  'multiselect',
  'person',
  'checkbox',
  'url'
]

interface ProjectSettingsProps {
  project: ProjectDTO
  onPatch: (patch: Record<string, unknown>) => void
  onDeleteProject: (() => void) | null
  onClose: () => void
}

export function ProjectSettings({ project, onPatch, onDeleteProject, onClose }: ProjectSettingsProps) {
  const [fieldName, setFieldName] = useState('')
  const [fieldType, setFieldType] = useState<CustomFieldDef['type']>('text')
  const config: ProjectConfig = project.config ?? {}

  const setConfig = (patch: Partial<ProjectConfig>): void => {
    const next = { ...config, ...patch }
    for (const key of Object.keys(next) as (keyof ProjectConfig)[]) {
      if (next[key] === undefined) delete next[key]
    }
    onPatch({ config: next })
  }

  return (
    <div className="task-editor">
      <div className="task-editor-head">
        <strong>Project settings</strong>
        <button onClick={onClose} aria-label="Close">
          ✕
        </button>
      </div>

      <div className="field-row">
        <label className="field">
          <span>Icon</span>
          <input
            defaultValue={project.icon}
            key={`icon-${project.icon}`}
            style={{ width: 60 }}
            onBlur={(e) => {
              if (e.target.value && e.target.value !== project.icon) onPatch({ icon: e.target.value })
            }}
          />
        </label>
        <label className="field" style={{ flex: 1 }}>
          <span>Title</span>
          <input
            defaultValue={project.title}
            key={`title-${project.title}`}
            onBlur={(e) => {
              const v = e.target.value.trim()
              if (v && v !== project.title) onPatch({ title: v })
            }}
          />
        </label>
        <label className="field">
          <span>Color</span>
          <input type="color" value={project.color} onChange={(e) => onPatch({ color: e.target.value })} />
        </label>
      </div>

      <label className="field">
        <span>Description</span>
        <textarea
          defaultValue={project.description}
          key={`desc-${project.id}`}
          rows={3}
          onBlur={(e) => {
            if (e.target.value !== project.description) onPatch({ description: e.target.value })
          }}
        />
      </label>

      <label className="field">
        <span>Team members</span>
        <TeamEditor members={project.teamMembers} onChange={(teamMembers) => onPatch({ teamMembers })} />
      </label>

      <div className="field">
        <span>Custom fields</span>
        {project.customFields.map((def) => (
          <div key={def.id} className="field-row" style={{ alignItems: 'center' }}>
            <code style={{ minWidth: 90 }}>{def.type}</code>
            <span style={{ flex: 1 }}>{def.name}</span>
            {(def.type === 'select' || def.type === 'multiselect') && (
              <input
                placeholder="options, comma-separated"
                defaultValue={(def.options ?? []).join(', ')}
                key={`opts-${def.id}`}
                onBlur={(e) => {
                  const options = e.target.value
                    .split(',')
                    .map((s) => s.trim())
                    .filter(Boolean)
                  onPatch({
                    customFields: project.customFields.map((f) => (f.id === def.id ? { ...f, options } : f))
                  })
                }}
              />
            )}
            <button
              onClick={() => onPatch({ customFields: project.customFields.filter((f) => f.id !== def.id) })}
            >
              Remove
            </button>
          </div>
        ))}
        <form
          className="field-row"
          onSubmit={(e) => {
            e.preventDefault()
            const name = fieldName.trim()
            if (!name) return
            const def: CustomFieldDef = { id: makeId(), name, type: fieldType }
            if (fieldType === 'select' || fieldType === 'multiselect') def.options = []
            onPatch({ customFields: [...project.customFields, def] })
            setFieldName('')
          }}
        >
          <input placeholder="Field name" value={fieldName} onChange={(e) => setFieldName(e.target.value)} />
          <select value={fieldType} onChange={(e) => setFieldType(e.target.value as CustomFieldDef['type'])}>
            {FIELD_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <button type="submit">Add field</button>
        </form>
      </div>

      <div className="field">
        <span>Overrides (inherit global unless set)</span>
        <label className="settings-row">
          Default view
          <select
            value={config.defaultView ?? ''}
            onChange={(e) => setConfig({ defaultView: (e.target.value || undefined) as ViewMode | undefined })}
          >
            <option value="">(inherit)</option>
            <option value="table">Table</option>
            <option value="kanban">Kanban</option>
            <option value="gantt">Gantt</option>
          </select>
        </label>
        <TriState
          label="Auto-schedule dependents"
          value={config.autoSchedule}
          onChange={(autoSchedule) => setConfig({ autoSchedule })}
        />
        <TriState
          label="Pull forward on early finish"
          value={config.pullForwardOnEarlyFinish}
          onChange={(pullForwardOnEarlyFinish) => setConfig({ pullForwardOnEarlyFinish })}
        />
        <TriState
          label="Kanban: subtasks as cards"
          value={config.kanbanShowSubtasks}
          onChange={(kanbanShowSubtasks) => setConfig({ kanbanShowSubtasks })}
        />
        <label className="settings-row">
          <input
            type="checkbox"
            checked={!!config.statuses?.length}
            onChange={(e) =>
              setConfig({ statuses: e.target.checked ? structuredClone(DEFAULT_STATUSES) : undefined })
            }
          />
          Project-specific statuses
        </label>
        {config.statuses?.length ? (
          <PaletteEditor
            items={config.statuses}
            withComplete
            onChange={(statuses) => setConfig({ statuses: statuses as StatusConfig[] })}
          />
        ) : null}
        <label className="settings-row">
          <input
            type="checkbox"
            checked={!!config.priorities?.length}
            onChange={(e) =>
              setConfig({ priorities: e.target.checked ? structuredClone(DEFAULT_PRIORITIES) : undefined })
            }
          />
          Project-specific priorities
        </label>
        {config.priorities?.length ? (
          <PaletteEditor
            items={config.priorities}
            onChange={(priorities) => setConfig({ priorities: priorities as PriorityConfig[] })}
          />
        ) : null}
      </div>

      {onDeleteProject && (
        <div className="task-editor-actions">
          <button
            style={{ color: 'var(--danger)' }}
            onClick={() => {
              if (
                window.confirm(
                  `Delete project "${project.title}" and all its tasks? Files go to the vault trash.`
                )
              ) {
                onDeleteProject()
              }
            }}
          >
            Delete project
          </button>
        </div>
      )}
    </div>
  )
}

function TeamEditor({ members, onChange }: { members: string[]; onChange: (m: string[]) => void }) {
  const [value, setValue] = useState('')
  return (
    <div className="chips">
      {members.map((m) => (
        <span key={m} className="badge" style={{ borderColor: 'var(--border)' }}>
          {m}
          <button className="chip-x" onClick={() => onChange(members.filter((x) => x !== m))}>
            ×
          </button>
        </span>
      ))}
      <input
        value={value}
        placeholder="Add…"
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            const v = value.trim()
            if (v && !members.includes(v)) onChange([...members, v])
            setValue('')
          }
        }}
        style={{ width: 120 }}
      />
    </div>
  )
}

function TriState({
  label,
  value,
  onChange
}: {
  label: string
  value: boolean | undefined
  onChange: (v: boolean | undefined) => void
}) {
  return (
    <label className="settings-row">
      {label}
      <select
        value={value === undefined ? '' : String(value)}
        onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value === 'true')}
      >
        <option value="">(inherit)</option>
        <option value="true">On</option>
        <option value="false">Off</option>
      </select>
    </label>
  )
}

function PaletteEditor({
  items,
  withComplete,
  onChange
}: {
  items: { id: string; label: string; color: string; icon: string; complete?: boolean }[]
  withComplete?: boolean
  onChange: (items: { id: string; label: string; color: string; icon: string; complete?: boolean }[]) => void
}) {
  const [newId, setNewId] = useState('')
  return (
    <div style={{ marginLeft: 12 }}>
      {items.map((item, i) => (
        <div key={item.id} className="field-row" style={{ alignItems: 'center' }}>
          <code style={{ minWidth: 90 }}>{item.id}</code>
          <input
            value={item.label}
            onChange={(e) => {
              const next = [...items]
              next[i] = { ...item, label: e.target.value }
              onChange(next)
            }}
          />
          <input
            type="color"
            value={item.color}
            onChange={(e) => {
              const next = [...items]
              next[i] = { ...item, color: e.target.value }
              onChange(next)
            }}
          />
          {withComplete && (
            <label className="muted" style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
              <input
                type="checkbox"
                checked={item.complete === true}
                onChange={(e) => {
                  const next = [...items]
                  next[i] = { ...item, complete: e.target.checked }
                  onChange(next)
                }}
              />
              done
            </label>
          )}
          <button onClick={() => onChange(items.filter((x) => x.id !== item.id))} disabled={items.length <= 1}>
            Remove
          </button>
        </div>
      ))}
      <form
        className="field-row"
        onSubmit={(e) => {
          e.preventDefault()
          const id = newId.trim().toLowerCase().replace(/\s+/g, '-')
          if (id && !items.some((x) => x.id === id)) {
            onChange([...items, { id, label: id, color: '#8a94a0', icon: '', ...(withComplete ? { complete: false } : {}) }])
          }
          setNewId('')
        }}
      >
        <input placeholder="new-id" value={newId} onChange={(e) => setNewId(e.target.value)} />
        <button type="submit">Add</button>
      </form>
    </div>
  )
}
