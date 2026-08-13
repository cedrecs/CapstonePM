import { useMemo, useRef, useState } from 'react'
import type { GanttGranularity, StatusConfig, Task } from '@pm/shared'
import { flattenTasks, isTerminalStatus, parsePlainDate, Temporal, today } from '@pm/shared'
import {
  BAR_PADDING,
  BAR_BORDER_RADIUS,
  buildTimelineConfig,
  dateToX,
  getSnapPoints,
  HEADER_HEIGHT,
  LABEL_WIDTH,
  ROW_HEIGHT,
  snapX,
  type TimelineCfg,
  xToDate
} from './timelineConfig'

interface GanttProps {
  tasks: Task[]
  statuses: StatusConfig[]
  canWrite: boolean
  onPatchTask: (tid: string, patch: Partial<Task>) => void
}

type DragMode = 'move' | 'resize-start' | 'resize-end'

interface DragState {
  taskId: string
  mode: DragMode
  originX: number
  dx: number
}

interface Row {
  task: Task
  depth: number
  y: number
}

/** A task renders as a diamond when it has no span: explicit milestones and due-only tasks. */
function isDiamond(task: Task): boolean {
  return task.type === 'milestone' || (!task.start && !!task.due)
}

function monthSegments(cfg: TimelineCfg): { label: string; x: number; width: number }[] {
  const segs: { label: string; x: number; width: number }[] = []
  let cursor = cfg.startDate
  while (Temporal.PlainDate.compare(cursor, cfg.endDate) < 0) {
    const monthStart = cursor.with({ day: 1 })
    const nextMonth = monthStart.add({ months: 1 })
    const from = Temporal.PlainDate.compare(monthStart, cfg.startDate) < 0 ? cfg.startDate : monthStart
    const to = Temporal.PlainDate.compare(nextMonth, cfg.endDate) > 0 ? cfg.endDate : nextMonth
    segs.push({
      label:
        cfg.granularity === 'quarter'
          ? monthStart.toLocaleString('en', { month: 'short' })
          : monthStart.toLocaleString('en', { month: 'short', year: 'numeric' }),
      x: dateToX(cfg, from),
      width: dateToX(cfg, to) - dateToX(cfg, from)
    })
    cursor = nextMonth
  }
  return segs
}

function subLabels(cfg: TimelineCfg): { label: string; x: number }[] {
  const labels: { label: string; x: number }[] = []
  for (let i = 0; i < cfg.totalDays; i++) {
    const d = cfg.startDate.add({ days: i })
    if (cfg.granularity === 'day') {
      labels.push({ label: String(d.day), x: i * cfg.dayWidth + cfg.dayWidth / 2 })
    } else if (cfg.granularity === 'week' && d.dayOfWeek === 1) {
      labels.push({ label: `W${d.weekOfYear ?? ''}`, x: i * cfg.dayWidth + 2 })
    }
  }
  return labels
}

export function GanttView({ tasks, statuses, canWrite, onPatchTask }: GanttProps) {
  const [granularity, setGranularity] = useState<GanttGranularity>('week')
  const [hideDone, setHideDone] = useState(false)
  const [drag, setDrag] = useState<DragState | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  const rows: Row[] = useMemo(() => {
    let flat = flattenTasks(tasks).filter((f) => f.visible)
    if (hideDone) flat = flat.filter((f) => !isTerminalStatus(f.task.status, statuses))
    return flat.map((f, i) => ({ task: f.task, depth: f.depth, y: HEADER_HEIGHT + i * ROW_HEIGHT }))
  }, [tasks, hideDone, statuses])

  const cfg = useMemo(
    () => buildTimelineConfig(rows.map((r) => r.task), granularity),
    [rows, granularity]
  )
  const snapPoints = useMemo(() => getSnapPoints(cfg), [cfg])
  const byId = useMemo(() => new Map(rows.map((r) => [r.task.id, r])), [rows])

  const totalHeight = HEADER_HEIGHT + rows.length * ROW_HEIGHT

  /** Bar geometry for a row, drag offset applied. */
  const geometry = (row: Row): { x: number; width: number; diamond: boolean } => {
    const t = row.task
    const start = parsePlainDate(t.start)
    const due = parsePlainDate(t.due)
    const dxMove = drag && drag.taskId === t.id && drag.mode === 'move' ? drag.dx : 0
    const dxStart = drag && drag.taskId === t.id && drag.mode === 'resize-start' ? drag.dx : 0
    const dxEnd = drag && drag.taskId === t.id && drag.mode === 'resize-end' ? drag.dx : 0

    if (isDiamond(t)) {
      const at = due ?? start ?? today()
      return { x: dateToX(cfg, at) + dxMove + dxEnd, width: 0, diamond: true }
    }
    const s = start ?? due ?? today()
    const e = due ?? start ?? today()
    let x = dateToX(cfg, s) + dxMove + dxStart
    let x2 = dateToX(cfg, e) + cfg.dayWidth + dxMove + dxEnd
    if (x2 < x + cfg.dayWidth) x2 = x + cfg.dayWidth
    return { x, width: x2 - x, diamond: false }
  }

  const beginDrag = (e: React.PointerEvent, task: Task, mode: DragMode): void => {
    if (!canWrite) return
    e.preventDefault()
    ;(e.target as Element).setPointerCapture(e.pointerId)
    setDrag({ taskId: task.id, mode, originX: e.clientX, dx: 0 })
  }

  const onPointerMove = (e: React.PointerEvent): void => {
    if (!drag) return
    setDrag({ ...drag, dx: e.clientX - drag.originX })
  }

  const onPointerUp = (): void => {
    if (!drag) return
    const row = byId.get(drag.taskId)
    setDrag(null)
    if (!row || Math.abs(drag.dx) < 3) return
    const t = row.task
    const start = parsePlainDate(t.start)
    const due = parsePlainDate(t.due)
    const threshold = cfg.dayWidth

    const shift = (date: Temporal.PlainDate, dx: number): string =>
      xToDate(cfg, snapX(dateToX(cfg, date) + dx, snapPoints, threshold)).toString()

    if (isDiamond(t)) {
      const at = due ?? start
      if (at) onPatchTask(t.id, { due: shift(at, drag.dx) })
      return
    }
    if (drag.mode === 'move') {
      const patch: Partial<Task> = {}
      if (start) patch.start = shift(start, drag.dx)
      if (due) patch.due = shift(due, drag.dx)
      if (patch.start || patch.due) onPatchTask(t.id, patch)
    } else if (drag.mode === 'resize-start' && start) {
      const next = shift(start, drag.dx)
      if (!t.due || next <= t.due) onPatchTask(t.id, { start: next })
    } else if (drag.mode === 'resize-end' && (due ?? start)) {
      const next = shift(due ?? start!, drag.dx)
      if (!t.start || next >= t.start) onPatchTask(t.id, { due: next })
    }
  }

  const todayX = dateToX(cfg, today())
  const months = monthSegments(cfg)
  const subs = subLabels(cfg)

  const statusColor = (task: Task): string =>
    statuses.find((s) => s.id === task.status)?.color ?? '#8a94a0'

  /** Elbow path from a predecessor's bar end to this task's bar start. */
  const arrows = useMemo(() => {
    const paths: { d: string; key: string }[] = []
    for (const row of rows) {
      for (const depId of row.task.dependencies) {
        const from = byId.get(depId)
        if (!from) continue
        const fromGeom = geometry(from)
        const toGeom = geometry(row)
        const x1 = fromGeom.diamond ? fromGeom.x + 7 : fromGeom.x + fromGeom.width
        const y1 = from.y + ROW_HEIGHT / 2
        const x2 = toGeom.diamond ? toGeom.x - 7 : toGeom.x
        const y2 = row.y + ROW_HEIGHT / 2
        const midX = x1 + 10
        const d =
          x2 - 6 > midX
            ? `M ${x1} ${y1} L ${midX} ${y1} L ${midX} ${y2} L ${x2 - 6} ${y2}`
            : `M ${x1} ${y1} L ${midX} ${y1} L ${midX} ${(y1 + y2) / 2} L ${x2 - 16} ${(y1 + y2) / 2} L ${x2 - 16} ${y2} L ${x2 - 6} ${y2}`
        paths.push({ d, key: `${depId}->${row.task.id}` })
      }
    }
    return paths
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, byId, cfg, drag])

  return (
    <div>
      <div className="gantt-toolbar">
        {(['day', 'week', 'month', 'quarter'] as GanttGranularity[]).map((g) => (
          <button key={g} className={granularity === g ? 'primary' : ''} onClick={() => setGranularity(g)}>
            {g[0].toUpperCase() + g.slice(1)}
          </button>
        ))}
        <label className="muted" style={{ display: 'inline-flex', gap: 6, alignItems: 'center', marginLeft: 12 }}>
          <input type="checkbox" checked={hideDone} onChange={(e) => setHideDone(e.target.checked)} />
          Hide done
        </label>
      </div>
      <div className="gantt-wrap">
        <div className="gantt-labels" style={{ width: LABEL_WIDTH, paddingTop: HEADER_HEIGHT }}>
          {rows.map((r) => (
            <div key={r.task.id} className="gantt-label" style={{ height: ROW_HEIGHT }}>
              <span style={{ paddingLeft: r.depth * 16 }}>
                {isDiamond(r.task) ? '◆ ' : ''}
                {r.task.title}
              </span>
            </div>
          ))}
        </div>
        <div className="gantt-scroll" ref={scrollRef}>
          <svg
            width={cfg.totalWidth}
            height={totalHeight}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
          >
            <defs>
              <marker id="dep-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--text-dim)" />
              </marker>
            </defs>

            {/* header */}
            {months.map((m) => (
              <g key={`m-${m.x}`}>
                <line x1={m.x} y1={0} x2={m.x} y2={totalHeight} stroke="var(--border)" strokeWidth={1} />
                <text x={m.x + 6} y={20} fill="var(--text-dim)" fontSize={12}>
                  {m.width > 40 ? m.label : ''}
                </text>
              </g>
            ))}
            {subs.map((s) => (
              <text key={`s-${s.x}`} x={s.x} y={44} fill="var(--text-dim)" fontSize={10} textAnchor="middle">
                {s.label}
              </text>
            ))}
            <line x1={0} y1={HEADER_HEIGHT} x2={cfg.totalWidth} y2={HEADER_HEIGHT} stroke="var(--border)" />

            {/* row separators */}
            {rows.map((r) => (
              <line
                key={`row-${r.task.id}`}
                x1={0}
                y1={r.y + ROW_HEIGHT}
                x2={cfg.totalWidth}
                y2={r.y + ROW_HEIGHT}
                stroke="var(--border)"
                strokeOpacity={0.4}
              />
            ))}

            {/* today line */}
            <line x1={todayX} y1={HEADER_HEIGHT - 8} x2={todayX} y2={totalHeight} stroke="var(--danger)" strokeWidth={1.5} />

            {/* dependency arrows */}
            {arrows.map((a) => (
              <path key={a.key} d={a.d} fill="none" stroke="var(--text-dim)" strokeWidth={1.2} markerEnd="url(#dep-arrow)" />
            ))}

            {/* bars */}
            {rows.map((row) => {
              const { x, width, diamond } = geometry(row)
              const color = statusColor(row.task)
              const y = row.y + BAR_PADDING
              const h = ROW_HEIGHT - BAR_PADDING * 2
              if (diamond) {
                const cy = row.y + ROW_HEIGHT / 2
                const r = 9
                return (
                  <g key={row.task.id} style={{ cursor: canWrite ? 'grab' : 'default' }}
                    onPointerDown={(e) => beginDrag(e, row.task, 'move')}>
                    <polygon
                      points={`${x},${cy - r} ${x + r},${cy} ${x},${cy + r} ${x - r},${cy}`}
                      fill={color}
                    />
                  </g>
                )
              }
              return (
                <g key={row.task.id}>
                  <rect
                    x={x}
                    y={y}
                    width={width}
                    height={h}
                    rx={BAR_BORDER_RADIUS}
                    fill={color}
                    fillOpacity={row.task.archived ? 0.35 : 0.85}
                    style={{ cursor: canWrite ? 'grab' : 'default' }}
                    onPointerDown={(e) => beginDrag(e, row.task, 'move')}
                  />
                  {row.task.progress > 0 && (
                    <rect
                      x={x}
                      y={y + h - 4}
                      width={(width * Math.min(row.task.progress, 100)) / 100}
                      height={4}
                      rx={2}
                      fill="#ffffff"
                      fillOpacity={0.7}
                      pointerEvents="none"
                    />
                  )}
                  {canWrite && (
                    <>
                      <rect
                        x={x - 3}
                        y={y}
                        width={8}
                        height={h}
                        fill="transparent"
                        style={{ cursor: 'ew-resize' }}
                        onPointerDown={(e) => beginDrag(e, row.task, 'resize-start')}
                      />
                      <rect
                        x={x + width - 5}
                        y={y}
                        width={8}
                        height={h}
                        fill="transparent"
                        style={{ cursor: 'ew-resize' }}
                        onPointerDown={(e) => beginDrag(e, row.task, 'resize-end')}
                      />
                    </>
                  )}
                  {width > 60 && (
                    <text x={x + 8} y={row.y + ROW_HEIGHT / 2 + 4} fontSize={11} fill="#fff" pointerEvents="none">
                      {row.task.title.slice(0, Math.floor(width / 8))}
                    </text>
                  )}
                </g>
              )
            })}
          </svg>
        </div>
      </div>
    </div>
  )
}
