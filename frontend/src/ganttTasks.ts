export type ApiPbiForGantt = {
  id: number
  number: number
  name: string
}

export type GanttTaskInput = {
  id: number
  jira_key: string
  title: string
  user_start_day?: string | null
  user_end_day?: string | null
  duration_days?: number | null
  hidden_by_user: boolean
  pbi_id?: number | null
}

/**
 * Связь блокировки: blockerId блокирует blockedId.
 * На диаграмме: стрелка от правого края blockerId к левому краю blockedId.
 */
export type BlockEdge = { blockerId: number; blockedId: number }

export function collectBlockEdges(
  tasks: {
    id: number
    jira_key: string
    blocks: { jira_key: string }[]
    blocked_by: { jira_key: string }[]
  }[]
): BlockEdge[] {
  const byKey = new Map<string, number>()
  for (const t of tasks) {
    byKey.set(t.jira_key, t.id)
  }
  const seen = new Set<string>()
  const out: BlockEdge[] = []

  const add = (blockerId: number, blockedId: number) => {
    if (blockerId === blockedId) return
    const key = `${blockerId}->${blockedId}`
    if (seen.has(key)) return
    seen.add(key)
    out.push({ blockerId, blockedId })
  }

  for (const t of tasks) {
    // t.blocks: кого блокирует t (t — блокирующая)
    for (const b of t.blocks) {
      const blockedId = byKey.get(b.jira_key)
      if (blockedId == null) continue
      add(t.id, blockedId)
    }
    // t.blocked_by: кто блокирует t (t — заблокированная)
    for (const b of t.blocked_by) {
      const blockerId = byKey.get(b.jira_key)
      if (blockerId == null) continue
      add(blockerId, t.id)
    }
  }
  return out
}

export function groupTasksForGantt<T extends GanttTaskInput>(tasks: T[], pbis: ApiPbiForGantt[]) {
  const pbisSorted = [...pbis].sort((a, b) => a.number - b.number)
  const validPbiIds = new Set(pbis.map((p) => p.id))
  const tasksByPbiId = new Map<number, T[]>()
  for (const t of tasks) {
    if (t.pbi_id != null && validPbiIds.has(t.pbi_id)) {
      const list = tasksByPbiId.get(t.pbi_id) ?? []
      list.push(t)
      tasksByPbiId.set(t.pbi_id, list)
    }
  }
  for (const list of tasksByPbiId.values()) {
    list.sort((a, b) => a.jira_key.localeCompare(b.jira_key))
  }
  const ungrouped = tasks
    .filter((t) => t.pbi_id == null || !validPbiIds.has(t.pbi_id as number))
    .sort((a, b) => a.jira_key.localeCompare(b.jira_key))
  return { pbisSorted, tasksByPbiId, ungrouped }
}

function inclusiveDaysBetween(start: string, end: string): number | null {
  const ps = /^(\d{4})-(\d{2})-(\d{2})$/.exec(start.trim())
  const pe = /^(\d{4})-(\d{2})-(\d{2})$/.exec(end.trim())
  if (!ps || !pe) return null
  const a = new Date(Number(ps[1]), Number(ps[2]) - 1, Number(ps[3]))
  const b = new Date(Number(pe[1]), Number(pe[2]) - 1, Number(pe[3]))
  if (b < a) return null
  return Math.round((b.getTime() - a.getTime()) / 86400000) + 1
}

function parseYmd(iso: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim())
  if (!m) return null
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
}

function toGanttEndExclusive(start: Date, inclusiveDays: number): Date {
  const end = new Date(start)
  end.setDate(end.getDate() + inclusiveDays)
  return end
}

function mergedDurationDays(
  task: GanttTaskInput,
  editingDuration: Record<number, string>,
  editingStart: Record<number, string>,
  editingEnd: Record<number, string>
): number | null {
  const rawManual = editingDuration[task.id]
  const manualTrim = rawManual !== undefined ? String(rawManual).trim() : ''
  if (manualTrim !== '') {
    const v = parseInt(manualTrim, 10)
    return Number.isNaN(v) || v < 0 ? null : v
  }
  const start = String(editingStart[task.id] ?? task.user_start_day ?? '').trim()
  const end = String(editingEnd[task.id] ?? task.user_end_day ?? '').trim()
  if (start && end) {
    return inclusiveDaysBetween(start, end)
  }
  if (task.duration_days != null) return task.duration_days
  return null
}

export function getTaskBarBounds(
  task: GanttTaskInput,
  editingStart: Record<number, string>,
  editingEnd: Record<number, string>,
  editingDuration: Record<number, string>
): { start: Date; end: Date } | null {
  const startStr = String(editingStart[task.id] ?? task.user_start_day ?? '').trim()
  const endStr = String(editingEnd[task.id] ?? task.user_end_day ?? '').trim()
  const start = parseYmd(startStr)
  if (!start) return null

  if (endStr) {
    const endIncl = parseYmd(endStr)
    if (!endIncl || endIncl < start) return null
    const inclusive = inclusiveDaysBetween(startStr, endStr)
    if (inclusive == null || inclusive < 1) return null
    return { start, end: toGanttEndExclusive(start, inclusive) }
  }

  const dur = mergedDurationDays(task, editingDuration, editingStart, editingEnd)
  if (dur == null || dur < 1) return null
  return { start, end: toGanttEndExclusive(start, dur) }
}

const MS_DAY = 86400000
const MAX_TIMELINE_DAYS = 120
const DEFAULT_EMPTY_DAYS = 21

function atMidnight(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

export function formatYmd(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** end — эксклюзивный конец из getTaskBarBounds; последний включительный день */
export function exclusiveBarEndToInclusiveYmd(endExclusive: Date): string {
  const d = atMidnight(new Date(endExclusive))
  d.setDate(d.getDate() - 1)
  return formatYmd(d)
}

export function addDaysYmd(ymd: string, deltaDays: number): string | null {
  const d = parseYmd(ymd)
  if (!d) return null
  d.setDate(d.getDate() + deltaDays)
  return formatYmd(d)
}

export function pointerXToDayIndex(
  trackRect: DOMRect,
  clientX: number,
  dayWidthPx: number,
  totalDays: number
): number {
  const x = clientX - trackRect.left
  const idx = Math.floor(x / dayWidthPx)
  return Math.max(0, Math.min(Math.max(0, totalDays - 1), idx))
}

export function enumerateDays(rangeStart: Date, rangeEndExclusive: Date): Date[] {
  const out: Date[] = []
  const c = atMidnight(rangeStart)
  const end = atMidnight(rangeEndExclusive)
  while (c < end) {
    out.push(new Date(c))
    c.setDate(c.getDate() + 1)
  }
  return out
}

export type TimelineModel = {
  rangeStart: Date
  rangeEndExclusive: Date
  days: Date[]
  hasScheduledTasks: boolean
}

export function buildTimelineModel(
  tasks: GanttTaskInput[],
  editingStart: Record<number, string>,
  editingEnd: Record<number, string>,
  editingDuration: Record<number, string>
): TimelineModel {
  let minS: Date | null = null
  let maxE: Date | null = null
  for (const task of tasks) {
    const b = getTaskBarBounds(task, editingStart, editingEnd, editingDuration)
    if (!b) continue
    const s = atMidnight(b.start)
    const e = new Date(b.end)
    if (!minS || s < minS) minS = s
    if (!maxE || e > maxE) maxE = e
  }

  if (!minS || !maxE) {
    const today = new Date()
    const start = atMidnight(today)
    const endEx = new Date(start)
    endEx.setDate(endEx.getDate() + DEFAULT_EMPTY_DAYS)
    const days = enumerateDays(start, endEx)
    return {
      rangeStart: start,
      rangeEndExclusive: endEx,
      days,
      hasScheduledTasks: false,
    }
  }

  const pad = 2
  let rs = new Date(minS)
  rs.setDate(rs.getDate() - pad)
  rs = atMidnight(rs)
  let re = new Date(maxE)
  re.setDate(re.getDate() + pad)

  const spanDays = Math.ceil((re.getTime() - rs.getTime()) / MS_DAY)
  if (spanDays > MAX_TIMELINE_DAYS) {
    rs = atMidnight(minS)
    rs.setDate(rs.getDate() - 1)
    re = new Date(rs)
    re.setDate(re.getDate() + MAX_TIMELINE_DAYS)
  }

  const days = enumerateDays(rs, re)
  return {
    rangeStart: rs,
    rangeEndExclusive: re,
    days,
    hasScheduledTasks: true,
  }
}

/** Fractions of total timeline width [0,1] */
export function barLayoutInTimeline(
  bounds: { start: Date; end: Date },
  rangeStart: Date,
  totalDays: number
): { left: number; width: number } | null {
  if (totalDays < 1) return null
  const t0 = atMidnight(rangeStart).getTime()
  const s = atMidnight(bounds.start).getTime()
  const e = bounds.end.getTime()
  const span = (e - s) / MS_DAY
  if (span <= 0) return null
  const offset = (s - t0) / MS_DAY
  const left = offset / totalDays
  const width = span / totalDays
  return {
    left: Math.max(0, Math.min(1, left)),
    width: Math.max(0, Math.min(1 - Math.max(0, left), width)),
  }
}

