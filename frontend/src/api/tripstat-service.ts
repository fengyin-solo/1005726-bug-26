import { listRows, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow } from '@/data/types'

// 保护动作统计的业务口径集中在这里，页面只负责渲染与收集输入。
// 同一线路同一统计月份只认第一次提交；动作次数、正确动作次数、误动次数
// 必须是统计范围内的非负整数，且 正确动作次数 + 误动次数 = 动作次数。

const TRIPSTAT_KEY = 'tripstat'
const FAULTRECORD_KEY = 'faultrecord'

const LINE_FIELD = '所属线路'
const MONTH_FIELD = '统计月份'
const TOTAL_FIELD = '动作次数'
const CORRECT_FIELD = '正确动作次数'
const MISTAKE_FIELD = '误动次数'
const OPERATOR_FIELD = '统计人'
const CODE_FIELD = '统计编号'

const SUBMIT_ACTION = '提交统计'
const SUMMARIZE_ACTION = '确认汇总'
const REVIEW_ACTION = '送交复核'

const PENDING_STATUS = '待统计'
const COUNTING_STATUS = '统计中'
const SUMMARIZED_STATUS = '已汇总'
const REVIEWED_STATUS = '已复核'

// 汇总结果同步到故障录波后，录波记录的字段与状态口径。
const FAULT_LINE_FIELD = '故障线路'
const FAULT_TIME_FIELD = '故障时间'
const FAULT_STATUS_FIELD = '录波状态'
const FAULT_CONCLUSION_FIELD = '分析结论'
const FAULT_ARCHIVE_PENDING_STATUS = '待归档'

export type TripStatDraft = {
  所属线路: string
  统计月份: string
  动作次数: string
  正确动作次数: string
  误动次数: string
  统计人: string
}

export type TripStatFilters = {
  所属线路?: string
  统计月份?: string
  统计人?: string
}

type CountTriplet = { total: number; correct: number; mistake: number }

function nextId(rows: EntryRow[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

function nextStatCode(rows: EntryRow[]): string {
  const seq = rows.reduce((max, row) => {
    const code = String(row[CODE_FIELD] ?? '')
    const matched = /^TRIP-(\d+)$/.exec(code)
    return matched ? Math.max(max, Number(matched[1])) : max
  }, 0)
  return `TRIP-${String(seq + 1).padStart(4, '0')}`
}

// 统计范围口径：次数必须是整数且落在 [0, 上限] 内；不传上限时只校验非负整数。
function parseCount(label: string, raw: string, upper?: number): { value: number } | { error: string } {
  const text = String(raw ?? '').trim()
  if (!/^\d+$/.test(text)) {
    return { error: `${label}必须是统计范围内的非负整数` }
  }
  const value = Number(text)
  if (upper !== undefined && value > upper) {
    return { error: `${label}不能超出统计范围（不大于${upper}）` }
  }
  return { value }
}

// 动作次数、正确动作次数、误动次数三者的判定沿用同一份统计规则：
// 非负整数，误动次数不超过动作次数，正确动作次数 + 误动次数 = 动作次数。
function validateCounts(input: {
  动作次数: string
  正确动作次数: string
  误动次数: string
}): CountTriplet | { error: string } {
  const totalResult = parseCount(TOTAL_FIELD, input.动作次数)
  if ('error' in totalResult) {
    return { error: totalResult.error }
  }
  const correctResult = parseCount(CORRECT_FIELD, input.正确动作次数, totalResult.value)
  if ('error' in correctResult) {
    return { error: correctResult.error }
  }
  const mistakeResult = parseCount(MISTAKE_FIELD, input.误动次数, totalResult.value)
  if ('error' in mistakeResult) {
    return { error: mistakeResult.error }
  }
  if (correctResult.value + mistakeResult.value !== totalResult.value) {
    return {
      error: `口径不符：${CORRECT_FIELD}与${MISTAKE_FIELD}之和应等于${TOTAL_FIELD}（${correctResult.value} + ${mistakeResult.value} ≠ ${totalResult.value}）`,
    }
  }
  return { total: totalResult.value, correct: correctResult.value, mistake: mistakeResult.value }
}

function sameLineAndMonth(row: EntryRow, line: string, month: string): boolean {
  return String(row[LINE_FIELD] ?? '').trim() === line && String(row[MONTH_FIELD] ?? '').trim() === month
}

// 同一线路同月的统计只认第一次：已存在任何一条同线路同月记录（含已作废前的待统计登记），
// 后续提交直接挡回，次数不做第二次累加。
function findDuplicate(rows: EntryRow[], line: string, month: string, excludeId?: number): EntryRow | undefined {
  return rows.find(
    (row) => Number(row.id) !== excludeId && sameLineAndMonth(row, line, month),
  )
}

function persistStats(rows: EntryRow[]): void {
  saveRows(TRIPSTAT_KEY, rows)
}

export function validateDraft(draft: TripStatDraft): { ok: true } | { ok: false; message: string } {
  const line = draft[LINE_FIELD]?.trim() ?? ''
  const month = draft[MONTH_FIELD]?.trim() ?? ''
  const operator = draft[OPERATOR_FIELD]?.trim() ?? ''
  if (!line) {
    return { ok: false, message: '所属线路不能为空' }
  }
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    return { ok: false, message: '统计月份格式应为 YYYY-MM' }
  }
  if (!operator) {
    return { ok: false, message: '统计人不能为空' }
  }
  const counts = validateCounts(draft)
  if ('error' in counts) {
    return { ok: false, message: counts.error }
  }
  return { ok: true }
}

// 登记动作统计：登记后处于「待统计」，真正计入次数以提交统计为准。
// 同一线路同月已有登记/提交记录时，按第一次的口径挡回。
export function createEntry(draft: TripStatDraft): ActionResult {
  const valid = validateDraft(draft)
  if (!valid.ok) {
    return valid
  }
  const line = draft[LINE_FIELD].trim()
  const month = draft[MONTH_FIELD].trim()
  const operator = draft[OPERATOR_FIELD].trim()
  const rows = listRows(TRIPSTAT_KEY)
  const duplicate = findDuplicate(rows, line, month)
  if (duplicate) {
    return {
      ok: false,
      message: `线路「${line}」${month}的统计已登记过（${duplicate[CODE_FIELD]}），同一线路同月只认第一次`,
    }
  }
  const counts = validateCounts(draft) as CountTriplet
  const row: EntryRow = {
    id: nextId(rows),
    status: PENDING_STATUS,
    pending: true,
    abnormal: false,
    [CODE_FIELD]: nextStatCode(rows),
    [LINE_FIELD]: line,
    [TOTAL_FIELD]: counts.total,
    [CORRECT_FIELD]: counts.correct,
    [MISTAKE_FIELD]: counts.mistake,
    [MONTH_FIELD]: month,
    [OPERATOR_FIELD]: operator,
  }
  persistStats([...rows, row])
  return { ok: true, message: `动作统计已登记，编号 ${row[CODE_FIELD]}，提交统计后才计入` }
}

// 待归档清单：故障录波里处于「待归档」、来源为动作统计汇总同步的记录。
export function listFaultArchivePending(): EntryRow[] {
  return listRows(FAULTRECORD_KEY).filter(
    (row) => String(row.status) === FAULT_ARCHIVE_PENDING_STATUS,
  )
}

// 汇总完成后把结果同步到故障录波的待归档清单：同线路同月份已存在待归档记录则不重复同步。
function syncToFaultArchive(row: EntryRow): void {
  const line = String(row[LINE_FIELD] ?? '').trim()
  const month = String(row[MONTH_FIELD] ?? '').trim()
  const faults = listRows(FAULTRECORD_KEY)
  const exists = faults.some(
    (item) =>
      String(item.status) === FAULT_ARCHIVE_PENDING_STATUS &&
      String(item[FAULT_LINE_FIELD] ?? '').trim() === line &&
      String(item[FAULT_TIME_FIELD] ?? '').slice(0, 7) === month,
  )
  if (exists) {
    return
  }
  const total = Number(row[TOTAL_FIELD] ?? 0)
  const mistake = Number(row[MISTAKE_FIELD] ?? 0)
  const synced: EntryRow = {
    id: nextId(faults),
    status: FAULT_ARCHIVE_PENDING_STATUS,
    pending: true,
    abnormal: false,
    录波编号: `FAUL-TRIP-${month}-${String(row.id).padStart(4, '0')}`,
    [FAULT_LINE_FIELD]: line,
    故障类型: mistake > 0 ? '保护误动' : '保护正确动作',
    故障电流: '',
    [FAULT_TIME_FIELD]: `${month}-01`,
    分析人: String(row[OPERATOR_FIELD] ?? ''),
    [FAULT_CONCLUSION_FIELD]: `动作${total}次，正确${Number(row[CORRECT_FIELD] ?? 0)}次，误动${mistake}次`,
    [FAULT_STATUS_FIELD]: FAULT_ARCHIVE_PENDING_STATUS,
  }
  saveRows(FAULTRECORD_KEY, [...faults, synced])
}

// 提交统计 / 确认汇总 / 送交复核 的统一入口（页面动作按钮走这里）。
export function submitAction(id: number, action: string, draft?: Partial<TripStatDraft>): ActionResult {
  const rows = listRows(TRIPSTAT_KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的动作统计` }
  }
  const current = rows[index]

  if (action === SUBMIT_ACTION) {
    // 同一线路同月重复提交只算一次：已有另一条同线路同月记录时挡回。
    const line = String(
      draft?.[LINE_FIELD] !== undefined ? draft[LINE_FIELD] : current[LINE_FIELD] ?? '',
    ).trim()
    const month = String(
      draft?.[MONTH_FIELD] !== undefined ? draft[MONTH_FIELD] : current[MONTH_FIELD] ?? '',
    ).trim()
    const duplicate = findDuplicate(rows, line, month, id)
    if (duplicate) {
      return {
        ok: false,
        message: `线路「${line}」${month}的统计已提交过（${duplicate[CODE_FIELD]}），同一线路同月只认第一次`,
      }
    }
    if (current.status !== PENDING_STATUS) {
      return { ok: false, message: `该统计已提交（当前「${current.status}」），重复提交不会二次累加` }
    }

    // 提交时以表单口径重新判定次数，误动次数超动作次数或超出统计范围直接挡回保存。
    const payload = {
      所属线路: line,
      统计月份: month,
      统计人: String(draft?.[OPERATOR_FIELD] !== undefined ? draft[OPERATOR_FIELD] : current[OPERATOR_FIELD] ?? ''),
      动作次数: String(draft?.[TOTAL_FIELD] !== undefined ? draft[TOTAL_FIELD] : current[TOTAL_FIELD] ?? ''),
      正确动作次数: String(
        draft?.[CORRECT_FIELD] !== undefined ? draft[CORRECT_FIELD] : current[CORRECT_FIELD] ?? '',
      ),
      误动次数: String(
        draft?.[MISTAKE_FIELD] !== undefined ? draft[MISTAKE_FIELD] : current[MISTAKE_FIELD] ?? '',
      ),
    }
    const valid = validateDraft(payload)
    if (!valid.ok) {
      return valid
    }
    const counts = validateCounts(payload) as CountTriplet
    const updated: EntryRow = {
      ...current,
      [LINE_FIELD]: line,
      [MONTH_FIELD]: month,
      [OPERATOR_FIELD]: payload.统计人.trim(),
      [TOTAL_FIELD]: counts.total,
      [CORRECT_FIELD]: counts.correct,
      [MISTAKE_FIELD]: counts.mistake,
      status: COUNTING_STATUS,
      pending: true,
      abnormal: false,
    }
    const next = [...rows]
    next[index] = updated
    persistStats(next)
    return {
      ok: true,
      message: `已提交统计：动作${counts.total}次、正确${counts.correct}次、误动${counts.mistake}次`,
    }
  }

  if (action === SUMMARIZE_ACTION) {
    if (current.status !== COUNTING_STATUS) {
      return { ok: false, message: `只有「统计中」的记录才能确认汇总，当前为「${current.status}」` }
    }
    // 汇总前再按统计范围规则兜底校验一次：口径不合法不允许保存成已汇总。
    const counts = validateCounts({
      动作次数: String(current[TOTAL_FIELD] ?? ''),
      正确动作次数: String(current[CORRECT_FIELD] ?? ''),
      误动次数: String(current[MISTAKE_FIELD] ?? ''),
    })
    if ('error' in counts) {
      return { ok: false, message: counts.error }
    }
    const updated: EntryRow = { ...current, status: SUMMARIZED_STATUS, pending: false }
    const next = [...rows]
    next[index] = updated
    persistStats(next)
    // 汇总完的结果同步到故障录波的待归档清单。
    syncToFaultArchive(updated)
    return { ok: true, message: '已确认汇总，结果已同步到故障录波待归档清单' }
  }

  if (action === REVIEW_ACTION) {
    if (current.status !== SUMMARIZED_STATUS) {
      return { ok: false, message: `只有「已汇总」的记录才能送交复核，当前为「${current.status}」` }
    }
    const updated: EntryRow = { ...current, status: REVIEWED_STATUS, pending: false }
    const next = [...rows]
    next[index] = updated
    persistStats(next)
    return { ok: true, message: '已送交复核' }
  }

  return { ok: false, message: `动作统计没有登记「${action}」这个动作` }
}

// 同一线路同月只显示第一次的记录：列表按 所属线路 + 统计月份 去重，
// 保留编号最小（最先登记）的一条，杜绝按线路查到重复两条。
export function listStats(filters: TripStatFilters = {}): { items: EntryRow[]; total: number } {
  const line = filters[LINE_FIELD]?.trim() ?? ''
  const month = filters[MONTH_FIELD]?.trim() ?? ''
  const operator = filters[OPERATOR_FIELD]?.trim() ?? ''

  const seen = new Set<string>()
  const items: EntryRow[] = []
  for (const row of listRows(TRIPSTAT_KEY)) {
    const key = `${String(row[LINE_FIELD] ?? '').trim()}__${String(row[MONTH_FIELD] ?? '').trim()}`
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    if (line && !String(row[LINE_FIELD] ?? '').includes(line)) {
      continue
    }
    if (month && !String(row[MONTH_FIELD] ?? '').includes(month)) {
      continue
    }
    if (operator && !String(row[OPERATOR_FIELD] ?? '').includes(operator)) {
      continue
    }
    items.push(row)
  }
  return { items, total: items.length }
}

// 明细面板与列表取的是同一份记录：按 id 从同一存储里拿，统计人等字段不会出现两份口径。
export function getStat(id: number): EntryRow | undefined {
  return listRows(TRIPSTAT_KEY).find((row) => Number(row.id) === id)
}

// 导出保护动作统计清单：列与列表一致，误动次数整列保留（通用导出漏了该列，这里按模块字段导出）。
export function exportStatsCsv(): { filename: string; content: string } {
  const header = [
    CODE_FIELD,
    LINE_FIELD,
    TOTAL_FIELD,
    CORRECT_FIELD,
    MISTAKE_FIELD,
    MONTH_FIELD,
    OPERATOR_FIELD,
    '统计状态',
  ]
  const { items } = listStats()
  const escape = (value: unknown): string => {
    const text = String(value ?? '')
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
  }
  const lines = [header.join(',')]
  for (const row of items) {
    lines.push(
      [
        row[CODE_FIELD],
        row[LINE_FIELD],
        row[TOTAL_FIELD],
        row[CORRECT_FIELD],
        row[MISTAKE_FIELD],
        row[MONTH_FIELD],
        row[OPERATOR_FIELD],
        row.status,
      ]
        .map(escape)
        .join(','),
    )
  }
  return {
    filename: '保护动作统计-清单.csv',
    content: `﻿${lines.join('\n')}`,
  }
}
