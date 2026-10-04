import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import {
  ACTION_SUBMIT,
  ACTION_SUMMARIZE,
  FAULTRECORD_KEY,
  STATUS_SUMMARIZED,
  TRIPSTAT_KEY,
  dedupeTripstatRows,
  isTripstatDuplicate,
  syncSummarizedToFaultrecord,
  validateTripstatCounts,
} from '@/data/tripstat-rules'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const stored = listRows(key)
  // 动作统计的口径：同一线路同月只认第一次提交，列表与合计都不重复计算。
  const scoped = key === TRIPSTAT_KEY ? dedupeTripstatRows(stored) : stored
  const matched = filterRows(scoped, filters)
  return {
    items: matched,
    total: matched.length,
    page: 1,
    size: matched.length,
    suppressed: stored.length - scoped.length,
  }
}

// 动作统计的提交/汇总卡口：重复提交只算第一次，误动次数超动作次数或超范围的一律挡回。
function guardTripstatAction(rows: EntryRow[], index: number, action: string): string | null {
  const row = rows[index]
  if (isTripstatDuplicate(row, rows)) {
    return '同一线路同一统计月份已有统计记录，重复提交只算第一次，本次不计入'
  }
  const message = validateTripstatCounts(row)
  if (message) {
    return action === ACTION_SUMMARIZE ? `${message}，已挡回保存，不允许保存成已汇总` : `${message}，已挡回保存`
  }
  return null
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  if (key === TRIPSTAT_KEY && (action === ACTION_SUBMIT || action === ACTION_SUMMARIZE)) {
    const blocked = guardTripstatAction(rows, index, action)
    if (blocked) {
      return { ok: false, message: blocked }
    }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  // 汇总完成的结果同步到故障录波的待归档清单，同一条统计只同步一次。
  if (key === TRIPSTAT_KEY && target === STATUS_SUMMARIZED) {
    const synced = syncSummarizedToFaultrecord(next, listRows(FAULTRECORD_KEY))
    if (synced.added > 0) {
      saveRows(FAULTRECORD_KEY, synced.rows)
    }
  }
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  // 导出沿用列表的同一份口径：动作统计同线路同月只导出第一次提交的记录。
  const scoped = key === TRIPSTAT_KEY ? dedupeTripstatRows(listRows(key)) : listRows(key)
  for (const row of scoped) {
    // 每个字段都显式转成字符串，避免误动次数这类列因非字符串值在 join 时整列丢失。
    const cells = [row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status]
    lines.push(cells.map((cell) => String(cell)).join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
