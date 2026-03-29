import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type PointerEvent as ReactPointerEvent,
  type SVGProps,
} from 'react'
import axios from 'axios'
import {
  addDaysYmd,
  barLayoutInTimeline,
  buildTimelineModel,
  collectBlockEdges,
  exclusiveBarEndToInclusiveYmd,
  formatYmd,
  getTaskBarBounds,
  groupTasksForGantt,
  pointerXToDayIndex,
} from './ganttTasks'

type RelatedTaskBrief = {
  jira_key: string
  jira_status?: string | null
  summary?: string | null
  link_type: string
}

type ApiPbi = {
  id: number
  number: number
  name: string
}

type ApiTask = {
  id: number
  jira_key: string
  jira_summary?: string
  jira_type?: string
  jira_status?: string
  title: string
  user_start_day?: string | null
  user_end_day?: string | null
  duration_days?: number | null
  missing_in_source: boolean
  hidden_by_user: boolean
  pbi_id?: number | null
  pbi_number?: number | null
  pbi_name?: string | null
  list_order?: number
  blocked_by: RelatedTaskBrief[]
  blocks: RelatedTaskBrief[]
  other_links: RelatedTaskBrief[]
}

const API = 'http://localhost:8000'

const GANTT_DAY_PX = 26
/** Колонок в режиме «все параметры» (без Ганта), включая ручку DnD */
const COLS_FULL = 15
/** Колонок в режиме «планирование» без колонки Ганта: ручка + 4 sticky + действия */
const COLS_DIAGRAM = 6

const TASK_DRAG_MIME = 'application/x-planner-task-id'

function taskIdFromDragEvent(e: ReactDragEvent): number | null {
  const raw = e.dataTransfer.getData(TASK_DRAG_MIME) || e.dataTransfer.getData('text/plain')
  const n = parseInt(String(raw).trim(), 10)
  return Number.isFinite(n) ? n : null
}

function IconTrash(props: SVGProps<SVGSVGElement>) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden {...props}>
      <path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6h14zM10 11v6M14 11v6" />
    </svg>
  )
}

function IconPencil(props: SVGProps<SVGSVGElement>) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden {...props}>
      <path d="M12 20h9M16.5 3.5a2.121 2.121 0 013 3L8 18l-4 1 1-4 11.5-11.5z" />
    </svg>
  )
}

function IconSave(props: SVGProps<SVGSVGElement>) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden {...props}>
      <path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z" />
      <path d="M17 21v-8H7v8M7 3v5h8" />
    </svg>
  )
}

function IconEye(props: SVGProps<SVGSVGElement>) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden {...props}>
      <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  )
}

function IconTable(props: SVGProps<SVGSVGElement>) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden {...props}>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M3 9h18M9 21V9" />
    </svg>
  )
}

function IconChart(props: SVGProps<SVGSVGElement>) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden {...props}>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M7 15l3-4 3 3 4-6" />
    </svg>
  )
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

function App() {
  const [tasks, setTasks] = useState<ApiTask[]>([])
  const [pbis, setPbis] = useState<ApiPbi[]>([])
  const [uploading, setUploading] = useState(false)
  const [message, setMessage] = useState('')
  const [editingStart, setEditingStart] = useState<Record<number, string>>({})
  const [editingEnd, setEditingEnd] = useState<Record<number, string>>({})
  const [editingDuration, setEditingDuration] = useState<Record<number, string>>({})
  const [newPbiNumber, setNewPbiNumber] = useState('')
  const [newPbiName, setNewPbiName] = useState('')
  const [backlogView, setBacklogView] = useState<'diagram' | 'table'>('diagram')
  const diagramMode = backlogView === 'diagram'
  /** В режиме «Планирование» полосу Ганта нужно сначала выбрать кликом, затем переносить/растягивать */
  const [ganttSelectedTaskId, setGanttSelectedTaskId] = useState<number | null>(null)
  const [editingPbiId, setEditingPbiId] = useState<number | null>(null)
  const [pbiDraftNumber, setPbiDraftNumber] = useState('')
  const [pbiDraftName, setPbiDraftName] = useState('')
  /** DnD: перенос задачи между группами PBI */
  const [draggingTaskId, setDraggingTaskId] = useState<number | null>(null)
  const [dropHoverKey, setDropHoverKey] = useState<string | null>(null)

  const loadData = async (silent = false) => {
    try {
      const [t, p] = await Promise.all([axios.get(`${API}/api/tasks`), axios.get(`${API}/api/pbis`)])
      setTasks(t.data)
      setPbis(p.data)
      if (!silent) {
        setMessage('Данные обновлены')
      }
    } catch {
      setMessage('Не удалось загрузить данные')
    }
  }

  useEffect(() => {
    loadData(true)
  }, [])

  useEffect(() => {
    if (backlogView !== 'diagram') setGanttSelectedTaskId(null)
  }, [backlogView])

  const upload = async (f: File) => {
    setUploading(true)
    const form = new FormData()
    form.append('file', f)
    try {
      const res = await axios.post(`${API}/api/import`, form)
      setMessage(`Импорт завершен. Создано: ${res.data.stats.created}, обновлено: ${res.data.stats.updated}`)
      await loadData(true)
    } catch (e: any) {
      setMessage(e?.response?.data?.detail || 'Ошибка импорта XML')
    } finally {
      setUploading(false)
    }
  }

  const createPbi = async () => {
    const num = parseInt(newPbiNumber.trim(), 10)
    if (Number.isNaN(num)) {
      setMessage('Номер PBI должен быть числом')
      return
    }
    const name = newPbiName.trim()
    if (!name) {
      setMessage('Введите название PBI')
      return
    }
    try {
      await axios.post(`${API}/api/pbis`, { number: num, name })
      setNewPbiNumber('')
      setNewPbiName('')
      setMessage('PBI добавлен')
      await loadData(true)
    } catch (e: any) {
      setMessage(e?.response?.data?.detail || 'Не удалось создать PBI')
    }
  }

  const assignPbi = async (taskId: number, pbiId: number | null) => {
    try {
      await axios.patch(`${API}/api/tasks/${taskId}`, { pbi_id: pbiId })
      setMessage(pbiId == null ? 'Задача без группы PBI' : 'Группа PBI обновлена')
      await loadData(true)
    } catch (e: any) {
      setMessage(e?.response?.data?.detail || 'Не удалось назначить PBI')
    }
  }

  const deletePbi = async (pbiId: number, label: string) => {
    if (
      !window.confirm(
        `Удалить PBI «${label}»?\nЗадачи не удалятся — у них только снимется привязка к этой группе.`
      )
    ) {
      return
    }
    try {
      await axios.delete(`${API}/api/pbis/${pbiId}`)
      setMessage('PBI удалён')
      setEditingPbiId(null)
      await loadData(true)
    } catch (e: any) {
      setMessage(e?.response?.data?.detail || 'Не удалось удалить PBI')
    }
  }

  const startEditPbi = (pbi: ApiPbi) => {
    setEditingPbiId(pbi.id)
    setPbiDraftNumber(String(pbi.number))
    setPbiDraftName(pbi.name)
  }

  const cancelEditPbi = () => {
    setEditingPbiId(null)
  }

  const savePbiEdit = async () => {
    if (editingPbiId == null) return
    const num = parseInt(pbiDraftNumber.trim(), 10)
    if (Number.isNaN(num)) {
      setMessage('Номер PBI должен быть числом')
      return
    }
    const name = pbiDraftName.trim()
    if (!name) {
      setMessage('Введите название PBI')
      return
    }
    try {
      await axios.patch(`${API}/api/pbis/${editingPbiId}`, { number: num, name })
      setMessage('PBI обновлён')
      setEditingPbiId(null)
      await loadData(true)
    } catch (e: any) {
      setMessage(e?.response?.data?.detail || 'Не удалось сохранить PBI')
    }
  }

  const durationFieldValue = (task: ApiTask): string => {
    const rawManual = editingDuration[task.id]
    const manualTrim = rawManual !== undefined ? String(rawManual).trim() : ''
    if (manualTrim !== '') {
      return manualTrim
    }
    const start = String(editingStart[task.id] ?? task.user_start_day ?? '').trim()
    const end = String(editingEnd[task.id] ?? task.user_end_day ?? '').trim()
    if (start && end) {
      const auto = inclusiveDaysBetween(start, end)
      if (auto != null) return String(auto)
    }
    if (task.duration_days != null) return String(task.duration_days)
    return ''
  }

  const patchTaskDates = async (taskId: number, startTrim: string, endTrim: string) => {
    const duration_days = inclusiveDaysBetween(startTrim, endTrim)
    if (duration_days == null || duration_days < 1) {
      setMessage('Некорректный интервал дат')
      await loadData(true)
      return
    }
    try {
      await axios.patch(`${API}/api/tasks/${taskId}`, {
        user_start_day: startTrim,
        user_end_day: endTrim,
        duration_days,
      })
      setMessage('Сроки обновлены')
      await loadData(true)
    } catch (e: any) {
      setMessage(e?.response?.data?.detail || 'Не удалось сохранить сроки')
      await loadData(true)
    }
  }

  const saveTask = async (taskId: number) => {
    const task = tasks.find((t) => t.id === taskId)
    if (!task) return

    const startTrim = String(editingStart[taskId] ?? task.user_start_day ?? '').trim()
    const endTrim = String(editingEnd[taskId] ?? task.user_end_day ?? '').trim()
    const durRaw = String(editingDuration[taskId] ?? '').trim()

    let duration_days: number | null
    if (durRaw !== '') {
      const value = parseInt(durRaw, 10)
      if (Number.isNaN(value) || value < 0) {
        setMessage('Продолжительность должна быть целым числом дней')
        return
      }
      duration_days = value
    } else if (startTrim && endTrim) {
      duration_days = inclusiveDaysBetween(startTrim, endTrim)
    } else {
      duration_days = null
    }

    const payload = {
      user_start_day: startTrim || null,
      user_end_day: endTrim || null,
      duration_days,
    }

    try {
      await axios.patch(`${API}/api/tasks/${taskId}`, payload)
      setMessage('Изменения сохранены')
      await loadData(true)
    } catch (e: any) {
      setMessage(e?.response?.data?.detail || 'Не удалось сохранить изменения')
    }
  }

  const toggleHidden = async (task: ApiTask) => {
    try {
      if (task.hidden_by_user) {
        await axios.post(`${API}/api/tasks/${task.id}/unhide`)
      } else {
        await axios.post(`${API}/api/tasks/${task.id}/hide`)
      }
      await loadData(true)
      setMessage(task.hidden_by_user ? 'Задача снова отображается' : 'Задача скрыта')
    } catch (e: any) {
      setMessage(e?.response?.data?.detail || 'Не удалось изменить видимость')
    }
  }

  /** Подпись к связи Blocks: с точки зрения текущей задачи — «блокирует» других или «блокируется» указанными. */
  const formatBlocksLinkCaption = (linkType: string, role: 'blocked_by' | 'blocks' | 'other') => {
    if (role === 'other') return linkType
    const t = (linkType || '').trim().toLowerCase()
    if (t.includes('duplicate') || t.includes('clone') || t === 'relates' || t.startsWith('relates')) {
      return linkType
    }
    const isBlocks =
      t === 'blocks' || t.includes('is blocked') || (t.includes('block') && !t.includes('non-block'))
    if (!isBlocks) return linkType
    return role === 'blocked_by' ? 'Блокируется' : 'Блокирует'
  }

  const formatLinkList = (items: RelatedTaskBrief[], role: 'blocked_by' | 'blocks' | 'other' = 'other') => {
    if (items.length === 0) return '—'
    return items.map((x, i) => (
      <div key={`${x.jira_key}-${i}`} className="link-line" title={x.summary || undefined}>
        <div className="link-row-main">
          <span className="link-key">{x.jira_key}</span>
          <span className="link-status">{x.jira_status?.trim() || '—'}</span>
        </div>
        <span className="link-type">{formatBlocksLinkCaption(x.link_type, role)}</span>
      </div>
    ))
  }

  const { pbisSorted, tasksByPbiId, ungrouped } = useMemo(
    () => groupTasksForGantt<ApiTask>(tasks, pbis),
    [tasks, pbis]
  )

  const validPbiIds = useMemo(() => new Set(pbis.map((p) => p.id)), [pbis])

  const effectivePbiId = (task: ApiTask): number | null =>
    task.pbi_id != null && validPbiIds.has(task.pbi_id) ? task.pbi_id : null

  const reorderTask = async (
    taskId: number,
    targetPbiId: number | null,
    beforeTaskId: number | null
  ) => {
    try {
      await axios.post(`${API}/api/tasks/reorder`, {
        task_id: taskId,
        target_pbi_id: targetPbiId,
        before_task_id: beforeTaskId,
      })
      setMessage('Порядок обновлён')
      await loadData(true)
    } catch (e: any) {
      setMessage(e?.response?.data?.detail || 'Не удалось изменить порядок')
    }
  }

  const handleTaskDragStart = (e: ReactDragEvent, taskId: number) => {
    e.dataTransfer.setData(TASK_DRAG_MIME, String(taskId))
    e.dataTransfer.setData('text/plain', String(taskId))
    e.dataTransfer.effectAllowed = 'move'
    setDraggingTaskId(taskId)
    setDropHoverKey(null)
  }

  const handleTaskDragEnd = () => {
    setDraggingTaskId(null)
    setDropHoverKey(null)
  }

  const handleRowDragOver = (e: ReactDragEvent, key: string) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setDropHoverKey(key)
  }

  const handleDropOnPbi = async (e: ReactDragEvent, pbiId: number) => {
    e.preventDefault()
    const tid = taskIdFromDragEvent(e)
    if (tid == null) return
    await reorderTask(tid, pbiId, null)
  }

  const handleDropUngrouped = async (e: ReactDragEvent) => {
    e.preventDefault()
    const tid = taskIdFromDragEvent(e)
    if (tid == null) return
    await reorderTask(tid, null, null)
  }

  const handleDropOnTaskRow = async (e: ReactDragEvent, target: ApiTask) => {
    e.preventDefault()
    const tid = taskIdFromDragEvent(e)
    if (tid == null || tid === target.id) return
    await reorderTask(tid, effectivePbiId(target), target.id)
  }

  const timeline = useMemo(
    () => buildTimelineModel(tasks, editingStart, editingEnd, editingDuration),
    [tasks, editingStart, editingEnd, editingDuration]
  )

  const totalDays = timeline.days.length
  const timelineWidthPx = totalDays * GANTT_DAY_PX

  const timelineRef = useRef(timeline)
  timelineRef.current = timeline

  const blockEdges = useMemo(() => collectBlockEdges(tasks), [tasks])
  const ganttWrapRef = useRef<HTMLDivElement>(null)
  const ganttLinksSvgRef = useRef<SVGSVGElement | null>(null)
  const [ganttLinksOverlay, setGanttLinksOverlay] = useState<{
    left: number
    width: number
    height: number
    paths: { d: string; key: string; endX: number; endY: number; arrowTipEast: boolean }[]
  } | null>(null)

  const tryBeginGanttDrag = (
    task: ApiTask,
    mode: 'move' | 'resize-left' | 'resize-right',
    e: ReactPointerEvent
  ) => {
    e.preventDefault()
    e.stopPropagation()
    if (backlogView !== 'diagram') return
    if (ganttSelectedTaskId !== task.id) {
      setGanttSelectedTaskId(task.id)
      return
    }
    beginGanttDrag(task, mode, e)
  }

  const beginGanttDrag = (
    task: ApiTask,
    mode: 'move' | 'resize-left' | 'resize-right',
    e: ReactPointerEvent
  ) => {
    e.preventDefault()
    e.stopPropagation()
    if (backlogView !== 'diagram') return
    const el = e.currentTarget as HTMLElement
    const track = el.closest('.gantt-track') as HTMLElement | null
    if (!track) return

    const bounds = getTaskBarBounds(task, editingStart, editingEnd, editingDuration)
    if (!bounds) return

    const anchorStartYmd = formatYmd(bounds.start)
    const anchorEndInclusiveYmd = exclusiveBarEndToInclusiveYmd(bounds.end)
    const initialStart = anchorStartYmd
    const initialEnd = anchorEndInclusiveYmd

    const pointerId = e.pointerId
    const startClientX = e.clientX
    const prevBodyUserSelect = document.body.style.userSelect
    document.body.style.userSelect = 'none'

    setEditingDuration((prev) => {
      const n = { ...prev }
      delete n[task.id]
      return n
    })

    const outcome = { start: anchorStartYmd, end: anchorEndInclusiveYmd }

    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return
      const days = timelineRef.current.days
      const nDays = days.length
      if (nDays < 1) return
      const rect = track.getBoundingClientRect()

      let newStart = outcome.start
      let newEnd = outcome.end

      if (mode === 'move') {
        const deltaDays = Math.round((ev.clientX - startClientX) / GANTT_DAY_PX)
        const ns = addDaysYmd(anchorStartYmd, deltaDays)
        const ne = addDaysYmd(anchorEndInclusiveYmd, deltaDays)
        if (ns && ne && ns <= ne) {
          newStart = ns
          newEnd = ne
        }
      } else if (mode === 'resize-left') {
        const idx = pointerXToDayIndex(rect, ev.clientX, GANTT_DAY_PX, nDays)
        const ns = formatYmd(days[idx])
        if (ns <= anchorEndInclusiveYmd) {
          newStart = ns
          newEnd = anchorEndInclusiveYmd
        }
      } else {
        const idx = pointerXToDayIndex(rect, ev.clientX, GANTT_DAY_PX, nDays)
        const ne = formatYmd(days[idx])
        if (ne >= anchorStartYmd) {
          newStart = anchorStartYmd
          newEnd = ne
        }
      }

      outcome.start = newStart
      outcome.end = newEnd
      setEditingStart((p) => ({ ...p, [task.id]: newStart }))
      setEditingEnd((p) => ({ ...p, [task.id]: newEnd }))
    }

    const finish = async (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return
      try {
        track.releasePointerCapture(pointerId)
      } catch {
        /* ignore */
      }
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
      document.body.style.userSelect = prevBodyUserSelect

      if (outcome.start !== initialStart || outcome.end !== initialEnd) {
        await patchTaskDates(task.id, outcome.start, outcome.end)
      }
    }

    try {
      track.setPointerCapture(pointerId)
    } catch {
      /* ignore */
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', finish)
  }

  /** Фаза 1: размеры колонки Ганта; пути считаются во втором эффекте относительно SVG в DOM */
  useLayoutEffect(() => {
    if (!diagramMode || blockEdges.length === 0) {
      setGanttLinksOverlay(null)
      return
    }
    const wrap = ganttWrapRef.current
    if (!wrap) return

    const measureBox = () => {
      const wrapRect = wrap.getBoundingClientRect()
      const anchorTd =
        (wrap.querySelector('td.gantt-cell [data-gantt-task-id]') as HTMLElement | null)?.closest(
          'td'
        ) ?? (wrap.querySelector('th.gantt-col-head') as HTMLElement | null)
      if (!anchorTd) {
        setGanttLinksOverlay(null)
        return
      }
      const ar = anchorTd.getBoundingClientRect()
      const colLeft = ar.left - wrapRect.left + wrap.scrollLeft
      const colW = ar.width
      const h = wrap.scrollHeight
      /* Не сбрасывать paths: [] — measureBox дергается при scroll/ResizeObserver; иначе стрелки
       * пропадают до следующего rAF во фазе 2. Координаты обновит фаза 2 по тем же deps. */
      setGanttLinksOverlay((prev) => ({
        left: colLeft,
        width: colW,
        height: h,
        paths: prev?.paths ?? [],
      }))
    }

    const schedule = () => requestAnimationFrame(() => measureBox())
    schedule()
    const ro = new ResizeObserver(schedule)
    ro.observe(wrap)
    wrap.addEventListener('scroll', schedule, { passive: true })
    window.addEventListener('resize', schedule)
    return () => {
      ro.disconnect()
      wrap.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', schedule)
    }
  }, [diagramMode, blockEdges])

  /** Фаза 2: точки выхода/входа в координатах слоя SVG (getBoundingClientRect относительно svg) */
  useLayoutEffect(() => {
    if (!diagramMode || blockEdges.length === 0 || !ganttLinksOverlay) {
      return
    }
    const wrap = ganttWrapRef.current
    if (!wrap) return

    let svgAttempts = 0
    const computePaths = () => {
      const svg = ganttLinksSvgRef.current
      if (!svg) {
        if (svgAttempts++ < 12) requestAnimationFrame(computePaths)
        return
      }
      const sbr = svg.getBoundingClientRect()
      const paths: { d: string; key: string; endX: number; endY: number; arrowTipEast: boolean }[] = []
      const elbow = 12

      for (const edge of blockEdges) {
        const blockerTrack = wrap.querySelector(`[data-gantt-task-id="${edge.blockerId}"]`) as HTMLElement | null
        const blockedTrack = wrap.querySelector(`[data-gantt-task-id="${edge.blockedId}"]`) as HTMLElement | null
        if (!blockerTrack || !blockedTrack) continue
        const blockerBar = blockerTrack.querySelector('.gantt-bar') as HTMLElement | null
        const blockedBar = blockedTrack.querySelector('.gantt-bar') as HTMLElement | null
        if (!blockerBar || !blockedBar) continue

        const rb = blockerBar.getBoundingClientRect()
        const rd = blockedBar.getBoundingClientRect()
        const xOut = rb.right - sbr.left
        const xIn = rd.left - sbr.left
        const yOut = rb.top + rb.height / 2 - sbr.top
        const yIn = rd.top + rd.height / 2 - sbr.top

        let d: string
        /** Последний горизонтальный шаг к (xIn,yIn): слева направо → наконечник «вправо» в полосу; справа налево — «влево», иначе стрелка смотрит против хода линии. */
        let arrowTipEast: boolean
        if (xIn >= xOut + elbow) {
          const midX = (xOut + xIn) / 2
          d = `M ${xOut} ${yOut} L ${midX} ${yOut} L ${midX} ${yIn} L ${xIn} ${yIn}`
          arrowTipEast = midX < xIn
        } else {
          const xEl = xOut + elbow
          d = `M ${xOut} ${yOut} L ${xEl} ${yOut} L ${xEl} ${yIn} L ${xIn} ${yIn}`
          arrowTipEast = xEl < xIn
        }
        paths.push({
          d,
          key: `${edge.blockerId}-${edge.blockedId}`,
          endX: xIn,
          endY: yIn,
          arrowTipEast,
        })
      }

      setGanttLinksOverlay((prev) => (prev ? { ...prev, paths } : null))
    }

    requestAnimationFrame(() => {
      requestAnimationFrame(computePaths)
    })
  }, [
    diagramMode,
    blockEdges,
    ganttLinksOverlay?.left,
    ganttLinksOverlay?.width,
    ganttLinksOverlay?.height,
    tasks,
    editingStart,
    editingEnd,
    editingDuration,
    timeline,
    ganttSelectedTaskId,
  ])

  const fmtDayHeader = (d: Date) =>
    new Intl.DateTimeFormat('ru-RU', { weekday: 'short' }).format(d).replace('.', '')

  const fmtMonth = (d: Date) => new Intl.DateTimeFormat('ru-RU', { month: 'short' }).format(d)

  const ganttHeaderCells = timeline.days.map((d, i) => {
    const wk = d.getDay()
    const isWeekend = wk === 0 || wk === 6
    const showMonth = i === 0 || d.getDate() === 1
    return (
      <div
        key={`${d.getTime()}-${i}`}
        className={`gantt-head-day${isWeekend ? ' gantt-head-wknd' : ''}`}
        style={{ width: GANTT_DAY_PX, minWidth: GANTT_DAY_PX }}
        title={d.toLocaleDateString('ru-RU')}
      >
        {showMonth && <span className="gantt-head-month">{fmtMonth(d)}</span>}
        <span className="gantt-head-dow">{fmtDayHeader(d)}</span>
        <span className="gantt-head-num">{d.getDate()}</span>
      </div>
    )
  })

  const ganttCell = (task: ApiTask) => {
    const bounds = getTaskBarBounds(task, editingStart, editingEnd, editingDuration)
    const layout =
      bounds && totalDays > 0 ? barLayoutInTimeline(bounds, timeline.rangeStart, totalDays) : null
    const startStr = String(editingStart[task.id] ?? task.user_start_day ?? '').trim()
    const endStr = String(editingEnd[task.id] ?? task.user_end_day ?? '').trim()
    const tip =
      bounds && (startStr || endStr)
        ? `${task.jira_key}: ${startStr || '—'} → ${endStr || '—'}`
        : task.jira_key
    const isGanttSelected = ganttSelectedTaskId === task.id
    return (
      <td className="gantt-cell">
        <div
          className="gantt-track"
          data-gantt-task-id={task.id}
          style={{ width: timelineWidthPx, ['--day' as string]: `${GANTT_DAY_PX}px` }}
          onPointerDown={(e) => {
            if ((e.target as HTMLElement).closest('.gantt-bar')) return
            setGanttSelectedTaskId(null)
          }}
        >
          <div className="gantt-grid-bg" aria-hidden />
          {layout && (
            <div
              className={
                (task.hidden_by_user ? 'gantt-bar gantt-bar-muted' : 'gantt-bar') +
                (isGanttSelected ? ' gantt-bar-selected' : '')
              }
              style={{ left: `${layout.left * 100}%`, width: `${layout.width * 100}%` }}
              title={tip}
            >
              <div
                className="gantt-bar-handle gantt-bar-handle-left"
                onPointerDown={(e) => tryBeginGanttDrag(task, 'resize-left', e)}
              />
              <div
                className="gantt-bar-body"
                onPointerDown={(e) => tryBeginGanttDrag(task, 'move', e)}
                role="presentation"
              />
              <div
                className="gantt-bar-handle gantt-bar-handle-right"
                onPointerDown={(e) => tryBeginGanttDrag(task, 'resize-right', e)}
              />
            </div>
          )}
        </div>
      </td>
    )
  }

  const ganttPbiCell = () => (
    <td className="gantt-cell gantt-cell-pbi">
      <div
        className="gantt-track gantt-track-pbi"
        style={{ width: timelineWidthPx, ['--day' as string]: `${GANTT_DAY_PX}px` }}
        aria-hidden
      />
    </td>
  )

  const pbiSelect = (task: ApiTask) => (
    <select
      className="pbi-select"
      value={task.pbi_id ?? ''}
      onChange={(e) => {
        const v = e.target.value
        assignPbi(task.id, v === '' ? null : Number(v))
      }}
    >
      <option value="">— не в PBI</option>
      {pbisSorted.map((p) => (
        <option key={p.id} value={p.id}>
          #{p.number} {p.name}
        </option>
      ))}
    </select>
  )

  const taskRow = (task: ApiTask) => (
    <tr
      key={task.id}
      className={[
        task.hidden_by_user ? 'row-hidden' : '',
        draggingTaskId === task.id ? 'task-row-dragging' : '',
        dropHoverKey === `task:${task.id}` ? 'task-row-drop-hover' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      onDragOver={(e) => handleRowDragOver(e, `task:${task.id}`)}
      onDrop={(e) => handleDropOnTaskRow(e, task)}
    >
      <td
        className="drag-handle-cell"
        draggable
        title="Перетащите строку на заголовок PBI, на «Без группы» или на другую задачу"
        onDragStart={(e) => handleTaskDragStart(e, task.id)}
        onDragEnd={handleTaskDragEnd}
      >
        <span className="drag-grip" aria-hidden>
          ⠿
        </span>
      </td>
      <td className="col-sticky col-sticky-key">{task.jira_key}</td>
      <td className="col-sticky col-sticky-title">
        <div className="title-cell">
          <div>{task.title}</div>
        </div>
      </td>
      <td className="col-sticky col-sticky-type">{task.jira_type || '—'}</td>
      <td className="col-sticky col-sticky-status">{task.jira_status || '—'}</td>
      {!diagramMode && (
        <>
          <td>{pbiSelect(task)}</td>
          <td>
            <input
              className="date-input"
              type="date"
              value={editingStart[task.id] ?? task.user_start_day ?? ''}
              onChange={(e) => setEditingStart((prev) => ({ ...prev, [task.id]: e.target.value }))}
            />
          </td>
          <td>
            <input
              className="date-input"
              type="date"
              value={editingEnd[task.id] ?? task.user_end_day ?? ''}
              onChange={(e) => setEditingEnd((prev) => ({ ...prev, [task.id]: e.target.value }))}
            />
          </td>
          <td>
            <input
              className="duration-input"
              type="number"
              min={0}
              placeholder="дн"
              value={durationFieldValue(task)}
              onChange={(e) => setEditingDuration((prev) => ({ ...prev, [task.id]: e.target.value }))}
            />
          </td>
        </>
      )}
      {diagramMode ? (
        <>
          <td className="actions-compact-cell">
            <div className="actions-icons">
              <button type="button" className="icon-btn" title="Сохранить" onClick={() => saveTask(task.id)}>
                <IconSave />
              </button>
              <button
                type="button"
                className="icon-btn"
                title={task.hidden_by_user ? 'Показать в списке' : 'Скрыть'}
                onClick={() => toggleHidden(task)}
              >
                <IconEye />
              </button>
            </div>
          </td>
          {ganttCell(task)}
        </>
      ) : (
        <>
          <td className="links-cell">{formatLinkList(task.blocks, 'blocks')}</td>
          <td className="links-cell">{formatLinkList(task.blocked_by, 'blocked_by')}</td>
          <td className="links-cell">{formatLinkList(task.other_links, 'other')}</td>
          <td>{task.missing_in_source ? 'Да' : 'Нет'}</td>
          <td>{task.hidden_by_user ? 'Да' : 'Нет'}</td>
          <td>
            <div className="actions">
              <button type="button" onClick={() => saveTask(task.id)}>
                Сохранить
              </button>
              <button type="button" onClick={() => toggleHidden(task)}>
                {task.hidden_by_user ? 'Показать' : 'Скрыть'}
              </button>
            </div>
          </td>
        </>
      )}
    </tr>
  )

  return (
    <div className="page">
      <h1>Планировщик задач — MVP</h1>
      <div className="toolbar">
        <label className="upload">
          Импорт Jira XML/RSS
          <input type="file" accept=".xml,.rss,.txt" onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
        </label>
        <button onClick={() => loadData(false)} disabled={uploading}>
          Обновить
        </button>
      </div>

      <div className="pbi-toolbar">
        <span className="pbi-toolbar-label">Новый PBI:</span>
        <input
          type="number"
          className="pbi-num-input"
          placeholder="№"
          value={newPbiNumber}
          onChange={(e) => setNewPbiNumber(e.target.value)}
        />
        <input
          type="text"
          className="pbi-name-input"
          placeholder="Название"
          value={newPbiName}
          onChange={(e) => setNewPbiName(e.target.value)}
        />
        <button type="button" onClick={createPbi}>
          Добавить PBI
        </button>
      </div>

      {message && <div className="msg">{message}</div>}
      <div className="meta meta-row">
        <span>
          Задач: {tasks.length} · PBI: {pbis.length}
        </span>
        <div className="backlog-view-bar" role="group" aria-label="Режим просмотра бэклога">
          <span className="backlog-view-label">Вид:</span>
          <button
            type="button"
            className={backlogView === 'diagram' ? 'view-toggle view-toggle-active' : 'view-toggle'}
            onClick={() => {
              setBacklogView('diagram')
              setEditingPbiId(null)
            }}
          >
            <IconChart />
            Планирование
          </button>
          <button
            type="button"
            className={backlogView === 'table' ? 'view-toggle view-toggle-active' : 'view-toggle'}
            onClick={() => {
              setBacklogView('table')
              setEditingPbiId(null)
            }}
          >
            <IconTable />
            Все параметры
          </button>
        </div>
      </div>

      <div
        ref={ganttWrapRef}
        className={`table-wrap table-unified${diagramMode ? ' diagram-gantt-wrap' : ''}`}
      >
        <table className={diagramMode ? 'gantt-main-table' : undefined}>
          <thead>
            <tr>
              <th className="drag-col-head" title="Перетаскивание">
                {' '}
              </th>
              <th className="col-sticky col-sticky-key">Key</th>
              <th className="col-sticky col-sticky-title">Название</th>
              <th className="col-sticky col-sticky-type">Тип</th>
              <th className="col-sticky col-sticky-status">Статус</th>
              {!diagramMode && (
                <>
                  <th>PBI</th>
                  <th>Старт</th>
                  <th>Окончание</th>
                  <th>Продолжительность (дн)</th>
                </>
              )}
              {diagramMode ? (
                <>
                  <th className="th-actions-compact" title="Действия">
                    …
                  </th>
                  <th className="gantt-col-head">
                    <div className="gantt-head-inner" style={{ width: timelineWidthPx }}>
                      {!timeline.hasScheduledTasks && (
                        <span className="gantt-hint">
                          Укажите даты в режиме «Все параметры» — диаграмма подстроится
                        </span>
                      )}
                      <div className="gantt-head-days">{ganttHeaderCells}</div>
                    </div>
                  </th>
                </>
              ) : (
                <>
                  <th>Блокируют</th>
                  <th>Заблокированы</th>
                  <th>Другие связи</th>
                  <th>Missing</th>
                  <th>Hidden</th>
                  <th>Действия</th>
                </>
              )}
            </tr>
          </thead>
          <tbody>
            {tasks.length === 0 && pbis.length === 0 ? (
              <tr>
                <td colSpan={diagramMode ? COLS_DIAGRAM + 1 : COLS_FULL}>
                  Нет задач. Загрузите Jira XML/RSS файл.
                </td>
              </tr>
            ) : (
              <>
                {pbisSorted.map((pbi) => (
                  <Fragment key={pbi.id}>
                    <tr
                      className={[
                        'pbi-header-row',
                        dropHoverKey === `pbi:${pbi.id}` ? 'pbi-drop-hover' : '',
                      ]
                        .filter(Boolean)
                        .join(' ')}
                      onDragOver={(e) => handleRowDragOver(e, `pbi:${pbi.id}`)}
                      onDrop={(e) => handleDropOnPbi(e, pbi.id)}
                    >
                      <td colSpan={diagramMode ? COLS_DIAGRAM : COLS_FULL} className="pbi-header-label-cell">
                        <div className="pbi-header-inner">
                          {editingPbiId === pbi.id ? (
                            <div className="pbi-edit-form">
                              <span className="pbi-edit-label">PBI</span>
                              <input
                                type="number"
                                className="pbi-edit-num"
                                value={pbiDraftNumber}
                                onChange={(e) => setPbiDraftNumber(e.target.value)}
                                aria-label="Номер PBI"
                              />
                              <input
                                type="text"
                                className="pbi-edit-name"
                                value={pbiDraftName}
                                onChange={(e) => setPbiDraftName(e.target.value)}
                                aria-label="Название PBI"
                              />
                              <button type="button" className="icon-btn" title="Сохранить" onClick={savePbiEdit}>
                                <IconSave />
                              </button>
                              <button type="button" className="icon-btn" title="Отмена" onClick={cancelEditPbi}>
                                ✕
                              </button>
                            </div>
                          ) : (
                            <>
                              <span className="pbi-header-title">
                                PBI #{pbi.number} — {pbi.name}
                              </span>
                              <span className="pbi-header-actions">
                                <button
                                  type="button"
                                  className="icon-btn"
                                  title="Изменить PBI"
                                  onClick={() => startEditPbi(pbi)}
                                >
                                  <IconPencil />
                                </button>
                                <button
                                  type="button"
                                  className="icon-btn icon-btn-danger"
                                  title="Удалить PBI"
                                  onClick={() => deletePbi(pbi.id, `#${pbi.number} ${pbi.name}`)}
                                >
                                  <IconTrash />
                                </button>
                              </span>
                            </>
                          )}
                        </div>
                      </td>
                      {diagramMode && ganttPbiCell()}
                    </tr>
                    {(tasksByPbiId.get(pbi.id) ?? []).map((t) => taskRow(t))}
                  </Fragment>
                ))}
                {tasks.length > 0 && (
                  <Fragment key="ungrouped">
                    <tr
                      className={[
                        'pbi-header-row',
                        'pbi-header-ungrouped',
                        dropHoverKey === 'ungrouped' ? 'pbi-drop-hover' : '',
                      ]
                        .filter(Boolean)
                        .join(' ')}
                      onDragOver={(e) => handleRowDragOver(e, 'ungrouped')}
                      onDrop={handleDropUngrouped}
                    >
                      <td colSpan={diagramMode ? COLS_DIAGRAM : COLS_FULL} className="pbi-header-label-cell">
                        Без группы PBI
                      </td>
                      {diagramMode && ganttPbiCell()}
                    </tr>
                    {ungrouped.map((t) => taskRow(t))}
                  </Fragment>
                )}
              </>
            )}
          </tbody>
        </table>
        {diagramMode && ganttLinksOverlay && (
          <svg
            ref={ganttLinksSvgRef}
            className="gantt-links-layer"
            width={ganttLinksOverlay.width}
            height={ganttLinksOverlay.height}
            style={{
              left: ganttLinksOverlay.left,
              top: 0,
              overflow: 'visible',
            }}
            aria-hidden
          >
            {ganttLinksOverlay.paths.map(({ d, key, endX, endY, arrowTipEast }) => (
              <Fragment key={key}>
                <path d={d} fill="none" stroke="#64748b" strokeWidth={1.5} />
                <polygon
                  points={
                    arrowTipEast
                      ? `${endX},${endY} ${endX - 7},${endY - 3.5} ${endX - 7},${endY + 3.5}`
                      : `${endX},${endY} ${endX + 7},${endY - 3.5} ${endX + 7},${endY + 3.5}`
                  }
                  fill="#64748b"
                />
              </Fragment>
            ))}
          </svg>
        )}
      </div>
    </div>
  )
}

export default App
