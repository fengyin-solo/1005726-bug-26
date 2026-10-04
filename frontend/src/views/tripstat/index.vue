<template>
  <section class="page" data-module="tripstat">
    <header class="page-head">
      <div>
        <h2>保护动作统计管理</h2>
        <p class="page-desc">维护动作统计，围绕统计编号、所属线路、动作次数、正确动作次数做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记动作统计</button>
        <button class="btn" type="button" @click="exportRows">导出保护动作统计清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
            <button class="link" type="button" @click="openDetail(row)">明细</button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无保护动作统计数据，可先登记动作统计</td>
        </tr>
      </tbody>
    </table>

    <aside v-if="selected" class="detail-panel">
      <header class="detail-head">
        <h3>统计明细 · {{ selected['统计编号'] ?? '—' }}</h3>
        <button class="link" type="button" @click="selected = null">收起</button>
      </header>
      <dl class="detail-grid">
        <div v-for="column in columns" :key="column" class="detail-item">
          <dt>{{ column }}</dt>
          <dd>{{ selected[column] ?? '—' }}</dd>
        </div>
        <div class="detail-item">
          <dt>当前状态</dt>
          <dd>{{ selected.status }}</dd>
        </div>
      </dl>
    </aside>

    <footer class="page-foot">
      <span>
        共 {{ total }} 条保护动作统计记录
        <template v-if="suppressed > 0">（同线路同月重复提交的 {{ suppressed }} 条只算第一次，未计入）</template>
      </span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('tripstat')
const columns = ["统计编号", "所属线路", "动作次数", "正确动作次数", "误动次数", "统计月份", "统计人", "统计状态"]
const actions = ["提交统计", "确认汇总", "送交复核"]
const statuses = ["待统计", "统计中", "已汇总", "已复核"]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const suppressed = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
// 明细面板直接引用列表里的同一条记录，统计人等字段与列表是同一份数据。
const selected = ref<EntryRow | null>(null)
// 统计卡片按全量口径数据算，不随筛选条件变化。
const scopedAll = ref<EntryRow[]>([])

const stats = computed(() => {
  const month = new Date().toISOString().slice(0, 7)
  const items = scopedAll.value
  return [
    { label: '待统计线路', value: items.filter((row) => String(row.status) === '待统计').length },
    { label: '已汇总线路', value: items.filter((row) => String(row.status) === '已汇总').length },
    {
      label: '本月误动次数',
      value: items
        .filter((row) => String(row['统计月份'] ?? '') === month)
        .reduce((sum, row) => sum + (Number(row['误动次数']) || 0), 0),
    },
  ]
})

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '动作统计登记入口尚未接入审批流'
}

function openDetail(row: EntryRow) {
  selected.value = row
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    suppressed.value = payload.suppressed ?? 0
    scopedAll.value = listEntries(meta.key).items
    // 明细面板重新指向刷新后的同一条记录，统计人等字段始终与列表同源。
    if (selected.value) {
      const currentId = Number(selected.value.id)
      selected.value = payload.items.find((row) => Number(row.id) === currentId) ?? null
    }
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '保护动作统计列表读取失败'
  }
}

onMounted(reload)
</script>
