import { ref } from 'vue'
import { meta as fetchMeta } from '@/api/m3'
import type { WorkOrderMeta } from '@/api/types'

/**
 * 工单字典（分类 / 优先级 / 状态 / 限制）。
 *
 * 为什么要有这个 composable：
 * 分类必须以字典码（electrical 等）传给后端才能聚合统计，但界面上要显示中文。
 * 如果每个页面各自维护一份「码→中文」映射，迟早出现某页漏改、显示成 electrical 的情况。
 * 所以字典只允许从后端 /m3/work-orders/meta 取一次，全模块共用。
 */

const fallback: WorkOrderMeta = {
  categories: [
    { code: 'plumbing', name: '给排水', defaultSlaHours: 8 },
    { code: 'lock', name: '门锁门禁', defaultSlaHours: 8 },
    { code: 'network', name: '网络与多媒体', defaultSlaHours: 12 },
    { code: 'electrical', name: '水电照明', defaultSlaHours: 24 },
    { code: 'hvac', name: '空调通风', defaultSlaHours: 24 },
    { code: 'cleaning', name: '清洁卫生', defaultSlaHours: 24 },
    { code: 'furniture', name: '家具桌椅', defaultSlaHours: 48 },
    { code: 'other', name: '其他', defaultSlaHours: 48 },
  ],
  priorities: [
    { code: 'low', name: '低', slaFactor: 1.5 },
    { code: 'medium', name: '中', slaFactor: 1 },
    { code: 'high', name: '高', slaFactor: 0.6 },
    { code: 'urgent', name: '紧急', slaFactor: 0.3 },
  ],
  statuses: [
    { code: 'reported', name: '待派单' },
    { code: 'dispatched', name: '已派单' },
    { code: 'in_progress', name: '维修中' },
    { code: 'completed', name: '待验收' },
    { code: 'accepted', name: '已完成' },
    { code: 'cancelled', name: '已取消' },
  ],
  limits: { maxPhotos: 3, maxReopen: 3, maxAppeal: 2, etaMaxDays: 30, commentMaxLength: 500 },
}

const state = ref<WorkOrderMeta>(fallback)
const loaded = ref(false)
let loading: Promise<void> | null = null

function ensureLoaded(): Promise<void> {
  if (loaded.value) return Promise.resolve()
  if (loading) return loading
  loading = fetchMeta()
    .then((data) => {
      if (data?.categories?.length) state.value = data
      loaded.value = true
    })
    .catch(() => {
      // 后端不可用时用内置兜底，保证表单仍能渲染，提交失败由后端校验兜住
      loaded.value = true
    })
    .finally(() => {
      loading = null
    })
  return loading
}

export function useWorkOrderMeta() {
  function categoryLabel(code?: string | null): string {
    if (!code) return '-'
    return state.value.categories.find((c) => c.code === code)?.name ?? code
  }

  function categorySlaHours(code?: string | null): number | null {
    if (!code) return null
    return state.value.categories.find((c) => c.code === code)?.defaultSlaHours ?? null
  }

  function priorityLabel(code?: string | null): string {
    if (!code) return '-'
    return state.value.priorities.find((p) => p.code === code)?.name ?? code
  }

  function statusLabel(code?: string | null): string {
    if (!code) return '-'
    return state.value.statuses.find((s) => s.code === code)?.name ?? code
  }

  /** 按「分类基线 × 优先级系数」预估时限，与后端 resolveSlaHours 口径一致 */
  function estimateSlaHours(category?: string | null, priority?: string | null): number | null {
    const base = categorySlaHours(category)
    const factor = state.value.priorities.find((p) => p.code === priority)?.slaFactor
    if (base == null || factor == null) return null
    return Math.max(1, Math.round(base * factor))
  }

  return {
    meta: state,
    ensureLoaded,
    categoryLabel,
    categorySlaHours,
    priorityLabel,
    statusLabel,
    estimateSlaHours,
  }
}
