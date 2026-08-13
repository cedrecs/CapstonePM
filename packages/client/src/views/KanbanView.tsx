import { DndContext, useDraggable, useDroppable, type DragEndEvent } from '@dnd-kit/core'
import type { PriorityConfig, StatusConfig, Task } from '@pm/shared'
import { flattenTasks } from '@pm/shared'

interface KanbanProps {
  tasks: Task[]
  statuses: StatusConfig[]
  priorities: PriorityConfig[]
  canWrite: boolean
  showSubtasks: boolean
  onSetStatus: (taskId: string, status: string) => void
  onToggleSubtasks: (show: boolean) => void
}

function Card({ task, priorities, canWrite }: { task: Task; priorities: PriorityConfig[]; canWrite: boolean }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: task.id,
    disabled: !canWrite
  })
  const priority = priorities.find((p) => p.id === task.priority)
  return (
    <div
      ref={setNodeRef}
      className="kanban-card"
      style={{
        transform: transform ? `translate(${transform.x}px, ${transform.y}px)` : undefined,
        opacity: isDragging ? 0.6 : 1,
        zIndex: isDragging ? 5 : undefined
      }}
      {...listeners}
      {...attributes}
    >
      <div className="card-title">
        {task.type === 'milestone' ? '◆ ' : ''}
        {task.title}
      </div>
      <div className="card-meta">
        {priority && (
          <span className="badge" style={{ borderColor: priority.color, color: priority.color }}>
            {priority.label}
          </span>
        )}
        {task.due && <span className="muted">{task.due}</span>}
      </div>
      {(task.assignees.length > 0 || task.tags.length > 0) && (
        <div className="card-meta muted">
          {task.assignees.join(', ')}
          {task.tags.length > 0 && <span> {task.tags.map((t) => `#${t}`).join(' ')}</span>}
        </div>
      )}
    </div>
  )
}

function Column({
  status,
  tasks,
  priorities,
  canWrite
}: {
  status: StatusConfig
  tasks: Task[]
  priorities: PriorityConfig[]
  canWrite: boolean
}) {
  const { setNodeRef, isOver } = useDroppable({ id: status.id })
  return (
    <div className="kanban-col" ref={setNodeRef} style={isOver ? { outline: `2px solid ${status.color}` } : undefined}>
      <div className="kanban-col-head" style={{ color: status.color }}>
        {status.label} <span className="muted">{tasks.length}</span>
      </div>
      {tasks.map((t) => (
        <Card key={t.id} task={t} priorities={priorities} canWrite={canWrite} />
      ))}
    </div>
  )
}

export function KanbanView({
  tasks,
  statuses,
  priorities,
  canWrite,
  showSubtasks,
  onSetStatus,
  onToggleSubtasks
}: KanbanProps) {
  const cards = showSubtasks
    ? flattenTasks(tasks).map((f) => f.task)
    : tasks

  const onDragEnd = (e: DragEndEvent): void => {
    const taskId = String(e.active.id)
    const status = e.over ? String(e.over.id) : null
    if (!status) return
    const task = cards.find((t) => t.id === taskId)
    if (task && task.status !== status) onSetStatus(taskId, status)
  }

  return (
    <>
      <label className="muted" style={{ display: 'inline-flex', gap: 6, alignItems: 'center', marginBottom: 10 }}>
        <input type="checkbox" checked={showSubtasks} onChange={(e) => onToggleSubtasks(e.target.checked)} />
        Show subtasks as cards
      </label>
      <DndContext onDragEnd={onDragEnd}>
        <div className="kanban-board">
          {statuses.map((s) => (
            <Column
              key={s.id}
              status={s}
              tasks={cards.filter((t) => t.status === s.id)}
              priorities={priorities}
              canWrite={canWrite}
            />
          ))}
        </div>
      </DndContext>
    </>
  )
}
