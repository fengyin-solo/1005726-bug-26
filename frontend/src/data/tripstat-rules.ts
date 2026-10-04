import type { EntryRow } from './types'

// 保护动作统计的口径收口：同一线路同月只认第一次提交，误动次数不许超过动作次数，
// 汇总结果同步故障录波待归档清单。规则只放在这里，列表、流转、导出都引用同一份。

export const TRIPSTAT_KEY = 'tripstat'
export const FAULTRECORD_KEY = 'faultrecord'

export const FIELD_CODE = '统计编号'
export const FIELD_LINE = '所属线路'
export const FIELD_TRIPS = '动作次数'
export const FIELD_CORRECT = '正确动作次数'
export const FIELD_MISOPERATION = '误动次数'
export const FIELD_MONTH = '统计月份'
export const FIELD_STATISTICIAN = '统计人'

export const ACTION_SUBMIT = '提交统计'
export const ACTION_SUMMARIZE = '确认汇总'

export const STATUS_SUMMARIZED = '已汇总'
export const FAULT_STATUS_PENDING_ARCHIVE = '已定性'

// 误动次数的统计范围：大于等于 0 的整数，且单条线路单月不超过这个上限。
export const MISOPERATION_LIMIT = 99

// 同步到故障录波时写在记录上的来源标记，用来保证同一条统计只同步一次。
export const SYNC_SOURCE_FLAG = '同步来源'

function lineMonthKey(row: EntryRow): string {
  return `${String(row[FIELD_LINE] ?? '').trim()}@${String(row[FIELD_MONTH] ?? '').trim()}`
}

// 同一线路同月的统计只认第一次：后面的重复提交不进列表、不参与汇总与导出。
export function dedupeTripstatRows(rows: EntryRow[]): EntryRow[] {
  const seen = new Set<string>()
  const kept: EntryRow[] = []
  for (const row of rows) {
    const key = lineMonthKey(row)
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    kept.push(row)
  }
  return kept
}

// 判断这条记录是不是同线路同月的重复提交（第一次出现的那条才算数）。
export function isTripstatDuplicate(row: EntryRow, rows: EntryRow[]): boolean {
  const key = lineMonthKey(row)
  const first = rows.find((item) => lineMonthKey(item) === key)
  return first !== undefined && Number(first.id) !== Number(row.id)
}

function readCount(row: EntryRow, field: string): number | null {
  const raw = row[field]
  if (raw === '' || raw === undefined || raw === null) {
    return null
  }
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 0) {
    return null
  }
  return value
}

// 动作次数、正确动作次数、误动次数的判定规则：都要是大于等于 0 的整数，
// 正确动作次数与误动次数不能超过动作次数，误动次数还不能超出统计范围上限。
export function validateTripstatCounts(row: EntryRow): string | null {
  const trips = readCount(row, FIELD_TRIPS)
  if (trips === null) {
    return `${FIELD_TRIPS}要是大于等于 0 的整数`
  }
  const correct = readCount(row, FIELD_CORRECT)
  if (correct === null) {
    return `${FIELD_CORRECT}要是大于等于 0 的整数`
  }
  if (correct > trips) {
    return `${FIELD_CORRECT}不能超过${FIELD_TRIPS}`
  }
  const misoperation = readCount(row, FIELD_MISOPERATION)
  if (misoperation === null) {
    return `${FIELD_MISOPERATION}要是大于等于 0 的整数`
  }
  if (misoperation > trips) {
    return `${FIELD_MISOPERATION}不能超过${FIELD_TRIPS}`
  }
  if (misoperation > MISOPERATION_LIMIT) {
    return `${FIELD_MISOPERATION}超出统计范围上限 ${MISOPERATION_LIMIT}`
  }
  return null
}

// 已汇总的统计同步到故障录波的待归档清单：同一条统计编号只同步一次，重复执行不会重复生成。
export function syncSummarizedToFaultrecord(
  tripstatRows: EntryRow[],
  faultRows: EntryRow[],
): { rows: EntryRow[]; added: number } {
  const synced = new Set(
    faultRows
      .map((row) => String(row[SYNC_SOURCE_FLAG] ?? ''))
      .filter((flag) => flag !== ''),
  )
  let nextId = faultRows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0)
  const addedRows: EntryRow[] = []
  for (const row of dedupeTripstatRows(tripstatRows)) {
    if (String(row.status) !== STATUS_SUMMARIZED) {
      continue
    }
    const sourceId = String(row[FIELD_CODE] ?? '').trim()
    if (sourceId === '' || synced.has(sourceId)) {
      continue
    }
    synced.add(sourceId)
    nextId += 1
    addedRows.push({
      id: nextId,
      status: FAULT_STATUS_PENDING_ARCHIVE,
      pending: true,
      abnormal: false,
      录波编号: `FAUL-SYNC-${sourceId}`,
      故障线路: row[FIELD_LINE] ?? '',
      故障类型: '保护动作汇总',
      故障电流: '',
      故障时间: row[FIELD_MONTH] ?? '',
      分析人: row[FIELD_STATISTICIAN] ?? '',
      分析结论: `动作${row[FIELD_TRIPS] ?? 0}次/正确${row[FIELD_CORRECT] ?? 0}次/误动${row[FIELD_MISOPERATION] ?? 0}次`,
      录波状态: '待归档',
      [SYNC_SOURCE_FLAG]: sourceId,
    })
  }
  return { rows: [...faultRows, ...addedRows], added: addedRows.length }
}
