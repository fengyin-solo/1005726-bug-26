<template>
  <section class="page" data-module="tripstat">
    <header class="page-head">
      <div>
        <h2>保护动作统计管理</h2>
        <p class="page-desc">同一线路同月只认第一次统计；动作次数、正确动作次数、误动次数按统计范围规则校验，汇总结果同步故障录波待归档清单。</p>
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
      <label class="filter-item">
        <span>所属线路</span>
        <input v-model="filters.所属线路" placeholder="按所属线路检索" />
      </label>
      <label class="filter-item">
        <span>统计月份</span>
        <input v-model="filters.统计月份" placeholder="如 2026-09" />
      </label>
      <label class="filter-item">
        <span>统计人</span>
        <input v-model="filters.统计人" placeholder="按统计人检索" />
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
            <button class="link" type="button" @click="openDetail(row)">查看明细</button>
            <button
              v-if="row.status === '待统计'"
              class="link"
              type="button"
              @click="openSubmit(row)"
            >
              提交统计
            </button>
            <button
              v-if="row.status === '统计中'"
              class="link"
              type="button"
              @click="runAction('确认汇总', row)"
            >
              确认汇总
            </button>
            <button
              v-if="row.status === '已汇总'"
              class="link"
              type="button"
              @click="runAction('送交复核', row)"
            >
              送交复核
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无保护动作统计数据，可先登记动作统计</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条保护动作统计记录（同线路同月已按第一次去重）</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <div v-if="dialog.mode" class="modal-mask" @click.self="closeDialog">
      <div class="modal-card">
        <h3 v-if="dialog.mode === 'create'">登记动作统计</h3>
        <h3 v-else-if="dialog.mode === 'submit'">提交统计（{{ dialog.form.统计编号 }}）</h3>
        <h3 v-else>统计明细（{{ dialog.form.统计编号 }}）</h3>

        <div v-if="dialog.mode === 'detail'" class="detail-grid">
          <template v-for="field in detailFields" :key="field">
            <span class="detail-label">{{ field }}</span>
            <span>{{ dialog.form[field] ?? '—' }}</span>
          </template>
          <span class="detail-label">当前状态</span>
          <span>{{ dialog.form.status ?? '—' }}</span>
        </div>

        <form v-else class="modal-form" @submit.prevent="confirmDialog">
          <label class="form-item">
            <span>所属线路</span>
            <input v-model="dialog.form.所属线路" :disabled="dialog.mode === 'submit'" required />
          </label>
          <label class="form-item">
            <span>统计月份（YYYY-MM）</span>
            <input v-model="dialog.form.统计月份" :disabled="dialog.mode === 'submit'" placeholder="2026-09" required />
          </label>
          <label class="form-item">
            <span>动作次数</span>
            <input v-model="dialog.form.动作次数" inputmode="numeric" required />
          </label>
          <label class="form-item">
            <span>正确动作次数</span>
            <input v-model="dialog.form.正确动作次数" inputmode="numeric" required />
          </label>
          <label class="form-item">
            <span>误动次数</span>
            <input v-model="dialog.form.误动次数" inputmode="numeric" required />
          </label>
          <label class="form-item">
            <span>统计人</span>
            <input v-model="dialog.form.统计人" required />
          </label>
          <p class="form-hint">口径：正确动作次数 + 误动次数 = 动作次数；误动次数不得超过动作次数。</p>
          <p v-if="dialog.error" class="error-text">{{ dialog.error }}</p>
          <div class="modal-actions">
            <button class="btn ghost" type="button" @click="closeDialog">取消</button>
            <button class="btn primary" type="submit">{{ dialog.mode === 'create' ? '登记' : '提交统计' }}</button>
          </div>
        </form>

        <div v-if="dialog.mode === 'detail'" class="modal-actions">
          <button class="btn primary" type="button" @click="closeDialog">关闭</button>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import {
  createEntry,
  exportStatsCsv,
  getStat,
  listStats,
  submitAction,
  type TripStatDraft,
} from '@/api/tripstat-service'
import type { EntryRow } from '@/data/types'

const columns = ['统计编号', '所属线路', '动作次数', '正确动作次数', '误动次数', '统计月份', '统计人', '统计状态']
const detailFields = columns
const statuses = ['待统计', '统计中', '已汇总', '已复核']

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = reactive({ 所属线路: '', 统计月份: '', 统计人: '' })

const currentMonth = new Date().toISOString().slice(0, 7)

const stats = computed(() => [
  {
    label: '待统计线路',
    value: rows.value.filter((row) => row.status === '待统计').length,
  },
  {
    label: '已汇总线路',
    value: rows.value.filter((row) => row.status === '已汇总' || row.status === '已复核').length,
  },
  {
    label: '本月误动次数',
    value: rows.value
      .filter((row) => String(row.统计月份) === currentMonth)
      .reduce((sum, row) => sum + (Number(row.误动次数) || 0), 0),
  },
])

const statusSummary = computed(() =>
  statuses.map((status) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

type DialogState = {
  mode: '' | 'create' | 'submit' | 'detail'
  id: number | null
  error: string
  form: Record<string, string>
}

const dialog = reactive<DialogState>({
  mode: '',
  id: null,
  error: '',
  form: {},
})

function resetFilters() {
  filters.所属线路 = ''
  filters.统计月份 = ''
  filters.统计人 = ''
  reload()
}

function exportRows() {
  const { filename, content } = exportStatsCsv()
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

function openCreate() {
  dialog.mode = 'create'
  dialog.id = null
  dialog.error = ''
  dialog.form = {
    统计编号: '',
    所属线路: '',
    统计月份: currentMonth,
    动作次数: '',
    正确动作次数: '',
    误动次数: '0',
    统计人: '',
  }
}

function openSubmit(row: EntryRow) {
  dialog.mode = 'submit'
  dialog.id = Number(row.id)
  dialog.error = ''
  dialog.form = {
    统计编号: String(row.统计编号 ?? ''),
    所属线路: String(row.所属线路 ?? ''),
    统计月份: String(row.统计月份 ?? ''),
    动作次数: String(row.动作次数 ?? ''),
    正确动作次数: String(row.正确动作次数 ?? ''),
    误动次数: String(row.误动次数 ?? ''),
    统计人: String(row.统计人 ?? ''),
  }
}

// 明细面板与列表取同一份存储里的同一条记录，统计人等字段口径保持一致。
function openDetail(row: EntryRow) {
  const latest = getStat(Number(row.id)) ?? row
  dialog.mode = 'detail'
  dialog.id = Number(latest.id)
  dialog.error = ''
  dialog.form = Object.fromEntries(
    Object.entries(latest).map(([key, value]) => [key, String(value ?? '')]),
  )
}

function closeDialog() {
  dialog.mode = ''
  dialog.id = null
  dialog.error = ''
}

function toDraft(): TripStatDraft {
  return {
    所属线路: dialog.form.所属线路 ?? '',
    统计月份: dialog.form.统计月份 ?? '',
    动作次数: dialog.form.动作次数 ?? '',
    正确动作次数: dialog.form.正确动作次数 ?? '',
    误动次数: dialog.form.误动次数 ?? '',
    统计人: dialog.form.统计人 ?? '',
  }
}

function confirmDialog() {
  if (dialog.mode === 'create') {
    const result = createEntry(toDraft())
    if (!result.ok) {
      dialog.error = result.message
      return
    }
    errorMessage.value = ''
    closeDialog()
    reload()
    return
  }
  if (dialog.mode === 'submit' && dialog.id !== null) {
    const result = submitAction(dialog.id, '提交统计', toDraft())
    if (!result.ok) {
      dialog.error = result.message
      return
    }
    errorMessage.value = ''
    closeDialog()
    reload()
  }
}

function runAction(action: string, row: EntryRow) {
  const result = submitAction(Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  errorMessage.value = result.message
  reload()
}

function reload() {
  errorMessage.value = ''
  const payload = listStats(filters)
  rows.value = payload.items
  total.value = payload.total
}

onMounted(reload)
</script>

<style scoped>
.modal-mask {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 42, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 20;
}
.modal-card {
  background: #fff;
  border-radius: 10px;
  width: 460px;
  max-width: calc(100vw - 32px);
  padding: 18px 20px;
  box-shadow: 0 12px 32px rgba(15, 23, 42, 0.2);
}
.modal-card h3 {
  margin: 0 0 14px;
  font-size: 16px;
}
.modal-form {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.form-item span {
  display: block;
  font-size: 12px;
  color: var(--muted);
  margin-bottom: 3px;
}
.form-item input {
  width: 100%;
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
}
.form-item input:disabled {
  background: #f1f5f9;
  color: var(--muted);
}
.form-hint {
  font-size: 12px;
  color: var(--muted);
  margin: 0;
}
.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 6px;
}
.detail-grid {
  display: grid;
  grid-template-columns: 110px 1fr;
  gap: 8px 12px;
  font-size: 13px;
}
.detail-label {
  color: var(--muted);
}
</style>
