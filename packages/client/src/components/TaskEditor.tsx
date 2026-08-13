import { useState } from 'react'
import type { CustomFieldDef, PriorityConfig, Recurrence, StatusConfig, Task } from '@pm/shared'
import { flattenTasks, findTask, totalLoggedHours } from '@pm/shared'

interface TaskEditorProps {
  task: Task
  allTasks: Task[]
  customFields: CustomFieldDef[]
  statuses: StatusConfig[]
  priorities: PriorityConfig[]
  assigneeOptions: string[]
  canWrite: boolean
  cycleError: boolean
  onPatch: (patch: Partial<Task>) => void
  onAddTimeLog: (log: { date: string; hours: number; note: string }) => void
  onArchive: (archived: boolean) => void
  onDuplicate: () => void
  onDelete: () => void
  onClose: () => void
}

/** Ids the task may not depend on: itself and its whole subtree. */
function forbiddenDeps(task: Task): Set<string> {
  const set = new Set([task.id])
  for (const f of flattenTasks(task.subtasks)) set.add(f.task.id)
  return set
}

export function TaskEditor({
  task,
  allTasks,
  customFields,
  statuses,
  priorities,
  assigneeOptions,
  canWrite,
  cycleError,
  onPatch,
  onAddTimeLog,
  onArchive,
  onDuplicate,
  onDelete,
  onClose
}: TaskEditorProps) {
  const [logDate, setLogDate] = useState(new Date().toISOString().slice(0, 10))
  const [logHours, setLogHours] = useState('')
  const [logNote, setLogNote] = useState('')
  const [newTag, setNewTag] = useState('')
  const [newAssignee, setNewAssignee] = useState('')

  const ro = !canWrite
  const forbidden = forbiddenDeps(task)
  const depCandidates = flattenTasks(allTasks)
    .map((f) => f.task)
    .filter((t) => !forbidden.has(t.id) && !task.dependencies.includes(t.id) && !t.archived)

  const logged = totalLoggedHours(task)
  const estimate = task.timeEstimate ?? 0

  const setRecurrence = (patch: Partial<Recurrence> | null): void => {
    if (patch === null) {
      onPatch({ recurrence: undefined })
    } else {
      onPatch({
        recurrence: {
          interval: task.recurrence?.interval ?? 'weekly',
          every: task.recurrence?.every ?? 1,
          ...task.recurrence,
          ...patch
        }
      })
    }
  }

  const customValue = (def: CustomFieldDef): unknown => task.customFields[def.id]
  const setCustom = (def: CustomFieldDef, value: unknown): void => {
    const next = { ...task.customFields }
    if (value === '' || value === undefined || (Array.isArray(value) && value.length === 0)) {
      delete next[def.id]
    } else {
      next[def.id] = value
    }
    onPatch({ customFields: next })
  }

  return (
    <div className="task-editor">
      <div className="task-editor-head">
        <input
          className="task-editor-title"
          defaultValue={task.title}
          key={`title-${task.id}-${task.title}`}
          disabled={ro}
          onBlur={(e) => {
            const v = e.target.value.trim()
            if (v && v !== task.title) onPatch({ title: v })
          }}
        />
        <button onClick={onClose} aria-label="Close">
          ✕
        </button>
      </div>

      {cycleError && (
        <div className="error-banner">That dependency would create a cycle — not applied.</div>
      )}

      <label className="field">
        <span>Description</span>
        <textarea
          defaultValue={task.description}
          key={`desc-${task.id}`}
          rows={4}
          disabled={ro}
          onBlur={(e) => {
            if (e.target.value !== task.description) onPatch({ description: e.target.value })
          }}
        />
      </label>

      <div className="field-row">
        <label className="field">
          <span>Type</span>
          <select value={task.type} disabled={ro} onChange={(e) => onPatch({ type: e.target.value as Task['type'] })}>
            <option value="task">Task</option>
            <option value="milestone">Milestone</option>
            {task.type === 'subtask' && <option value="subtask">Subtask</option>}
          </select>
        </label>
        <label className="field">
          <span>Status</span>
          <select value={task.status} disabled={ro} onChange={(e) => onPatch({ status: e.target.value })}>
            {statuses.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Priority</span>
          <select value={task.priority} disabled={ro} onChange={(e) => onPatch({ priority: e.target.value })}>
            {priorities.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="field-row">
        <label className="field">
          <span>Start</span>
          <input type="date" value={task.start} disabled={ro} onChange={(e) => onPatch({ start: e.target.value })} />
        </label>
        <label className="field">
          <span>Due</span>
          <input type="date" value={task.due} disabled={ro} onChange={(e) => onPatch({ due: e.target.value })} />
        </label>
        <label className="field">
          <span>Progress %</span>
          <input
            type="number"
            min={0}
            max={100}
            defaultValue={task.progress}
            key={`prog-${task.id}-${task.progress}`}
            disabled={ro}
            onBlur={(e) => {
              const v = Math.max(0, Math.min(100, Number(e.target.value)))
              if (v !== task.progress) onPatch({ progress: v })
            }}
          />
        </label>
      </div>

      <label className="field">
        <span>Assignees</span>
        <div className="chips">
          {task.assignees.map((a) => (
            <span key={a} className="badge" style={{ borderColor: 'var(--border)' }}>
              {a}
              {!ro && (
                <button className="chip-x" onClick={() => onPatch({ assignees: task.assignees.filter((x) => x !== a) })}>
                  ×
                </button>
              )}
            </span>
          ))}
          {!ro && (
            <>
              <input
                list="assignee-options"
                value={newAssignee}
                placeholder="Add…"
                onChange={(e) => setNewAssignee(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    const v = newAssignee.trim()
                    if (v && !task.assignees.includes(v)) onPatch({ assignees: [...task.assignees, v] })
                    setNewAssignee('')
                  }
                }}
                style={{ width: 120 }}
              />
              <datalist id="assignee-options">
                {assigneeOptions.map((a) => (
                  <option key={a} value={a} />
                ))}
              </datalist>
            </>
          )}
        </div>
      </label>

      <label className="field">
        <span>Tags</span>
        <div className="chips">
          {task.tags.map((t) => (
            <span key={t} className="badge" style={{ borderColor: 'var(--border)' }}>
              #{t}
              {!ro && (
                <button className="chip-x" onClick={() => onPatch({ tags: task.tags.filter((x) => x !== t) })}>
                  ×
                </button>
              )}
            </span>
          ))}
          {!ro && (
            <input
              value={newTag}
              placeholder="Add…"
              onChange={(e) => setNewTag(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  const v = newTag.trim().replace(/^#/, '')
                  if (v && !task.tags.includes(v)) onPatch({ tags: [...task.tags, v] })
                  setNewTag('')
                }
              }}
              style={{ width: 120 }}
            />
          )}
        </div>
      </label>

      <label className="field">
        <span>Depends on</span>
        <div className="chips">
          {task.dependencies.map((depId) => {
            const dep = findTask(allTasks, depId)
            return (
              <span key={depId} className="badge" style={{ borderColor: 'var(--border)' }}>
                {dep?.title ?? depId}
                {!ro && (
                  <button
                    className="chip-x"
                    onClick={() => onPatch({ dependencies: task.dependencies.filter((d) => d !== depId) })}
                  >
                    ×
                  </button>
                )}
              </span>
            )
          })}
          {!ro && depCandidates.length > 0 && (
            <select
              value=""
              onChange={(e) => {
                if (e.target.value) onPatch({ dependencies: [...task.dependencies, e.target.value] })
              }}
            >
              <option value="">Add dependency…</option>
              {depCandidates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.title}
                </option>
              ))}
            </select>
          )}
        </div>
      </label>

      <div className="field-row">
        <label className="field">
          <span>Repeat</span>
          <select
            value={task.recurrence?.interval ?? 'none'}
            disabled={ro}
            onChange={(e) => {
              const v = e.target.value
              if (v === 'none') setRecurrence(null)
              else setRecurrence({ interval: v as Recurrence['interval'] })
            }}
          >
            <option value="none">Never</option>
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
            <option value="monthly">Monthly</option>
            <option value="yearly">Yearly</option>
          </select>
        </label>
        {task.recurrence && (
          <>
            <label className="field">
              <span>Every</span>
              <input
                type="number"
                min={1}
                value={task.recurrence.every}
                disabled={ro}
                onChange={(e) => setRecurrence({ every: Math.max(1, Number(e.target.value)) })}
                style={{ width: 70 }}
              />
            </label>
            <label className="field">
              <span>Until</span>
              <input
                type="date"
                value={task.recurrence.endDate ?? ''}
                disabled={ro}
                onChange={(e) => setRecurrence({ endDate: e.target.value || undefined })}
              />
            </label>
          </>
        )}
      </div>

      <div className="field">
        <span>Time</span>
        <div className="field-row" style={{ alignItems: 'center' }}>
          <label className="field">
            <span className="muted">Estimate (h)</span>
            <input
              type="number"
              min={0}
              step={0.5}
              defaultValue={task.timeEstimate ?? ''}
              key={`est-${task.id}-${task.timeEstimate}`}
              disabled={ro}
              onBlur={(e) => {
                const v = e.target.value === '' ? undefined : Math.max(0, Number(e.target.value))
                if (v !== task.timeEstimate) onPatch({ timeEstimate: v })
              }}
              style={{ width: 90 }}
            />
          </label>
          <div style={{ flex: 1 }}>
            <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
              {logged.toFixed(1)}h logged{estimate ? ` of ${estimate}h` : ''}
            </div>
            {estimate > 0 && (
              <div className="time-bar">
                <div
                  className="time-bar-fill"
                  style={{
                    width: `${Math.min(100, (logged / estimate) * 100)}%`,
                    background: logged > estimate ? 'var(--danger)' : 'var(--ok)'
                  }}
                />
              </div>
            )}
          </div>
        </div>
        {(task.timeLogs ?? []).length > 0 && (
          <ul className="time-logs">
            {(task.timeLogs ?? []).map((log, i) => (
              <li key={i} className="muted">
                {log.date} — {log.hours}h{log.note ? ` · ${log.note}` : ''}
              </li>
            ))}
          </ul>
        )}
        {!ro && (
          <form
            className="field-row"
            onSubmit={(e) => {
              e.preventDefault()
              const hours = Number(logHours)
              if (!logDate || !hours) return
              onAddTimeLog({ date: logDate, hours, note: logNote })
              setLogHours('')
              setLogNote('')
            }}
          >
            <input type="date" value={logDate} onChange={(e) => setLogDate(e.target.value)} />
            <input
              type="number"
              min={0.25}
              step={0.25}
              placeholder="h"
              value={logHours}
              onChange={(e) => setLogHours(e.target.value)}
              style={{ width: 70 }}
            />
            <input placeholder="note" value={logNote} onChange={(e) => setLogNote(e.target.value)} />
            <button type="submit">Log</button>
          </form>
        )}
      </div>

      {customFields.length > 0 && (
        <div className="field">
          <span>Fields</span>
          {customFields.map((def) => (
            <label key={def.id} className="field-row" style={{ alignItems: 'center' }}>
              <span className="muted" style={{ minWidth: 110 }}>
                {def.icon ? `${def.icon} ` : ''}
                {def.name}
              </span>
              <CustomFieldInput
                def={def}
                value={customValue(def)}
                disabled={ro}
                assigneeOptions={assigneeOptions}
                onChange={(v) => setCustom(def, v)}
              />
            </label>
          ))}
        </div>
      )}

      {canWrite && (
        <div className="task-editor-actions">
          <button onClick={() => onArchive(!task.archived)}>{task.archived ? 'Unarchive' : 'Archive'}</button>
          <button onClick={onDuplicate}>Duplicate</button>
          <button
            style={{ color: 'var(--danger)' }}
            onClick={() => {
              if (window.confirm('Delete this task (and its subtasks)? Files go to the vault trash.')) onDelete()
            }}
          >
            Delete
          </button>
        </div>
      )}
    </div>
  )
}

function CustomFieldInput({
  def,
  value,
  disabled,
  assigneeOptions,
  onChange
}: {
  def: CustomFieldDef
  value: unknown
  disabled: boolean
  assigneeOptions: string[]
  onChange: (v: unknown) => void
}) {
  switch (def.type) {
    case 'checkbox':
      return (
        <input
          type="checkbox"
          checked={value === true}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
        />
      )
    case 'number':
      return (
        <input
          type="number"
          defaultValue={typeof value === 'number' ? value : ''}
          key={String(value)}
          disabled={disabled}
          onBlur={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
        />
      )
    case 'date':
      return (
        <input
          type="date"
          value={typeof value === 'string' ? value : ''}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
        />
      )
    case 'select':
      return (
        <select
          value={typeof value === 'string' ? value : ''}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
        >
          <option value="">—</option>
          {(def.options ?? []).map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      )
    case 'multiselect': {
      const selected = Array.isArray(value) ? (value as string[]) : []
      return (
        <div className="chips">
          {(def.options ?? []).map((o) => (
            <label key={o} className="badge" style={{ borderColor: 'var(--border)', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={selected.includes(o)}
                disabled={disabled}
                onChange={(e) =>
                  onChange(e.target.checked ? [...selected, o] : selected.filter((x) => x !== o))
                }
                style={{ marginRight: 4 }}
              />
              {o}
            </label>
          ))}
        </div>
      )
    }
    case 'person':
      return (
        <select
          value={typeof value === 'string' ? value : ''}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
        >
          <option value="">—</option>
          {assigneeOptions.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
      )
    case 'url':
      return (
        <input
          type="url"
          placeholder="https://…"
          defaultValue={typeof value === 'string' ? value : ''}
          key={String(value)}
          disabled={disabled}
          onBlur={(e) => onChange(e.target.value)}
        />
      )
    default:
      return (
        <input
          defaultValue={typeof value === 'string' ? value : ''}
          key={String(value)}
          disabled={disabled}
          onBlur={(e) => onChange(e.target.value)}
        />
      )
  }
}
