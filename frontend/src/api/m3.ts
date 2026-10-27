import http from './http'
import type {
  ReportWorkOrderParams,
  TechnicianWorkload,
  WorkOrder,
  WorkOrderEvent,
  WorkOrderMeta,
} from './types'

/**
 * M3 物业报修工单 API
 * 对照 backend/src/modules/m3-maintenance/work-orders.controller.ts（前缀 /m3/work-orders）
 */

/** 上报故障工单：POST /m3/work-orders（权限 workorder.report） */
export function report(data: ReportWorkOrderParams): Promise<WorkOrder> {
  return http.post('/m3/work-orders', data).then((r) => r.data)
}

/** 派单：POST /m3/work-orders/:id/dispatch（权限 workorder.dispatch） */
export function dispatch(id: number, data: { assigneeId: number }): Promise<WorkOrder> {
  return http.post(`/m3/work-orders/${id}/dispatch`, data).then((r) => r.data)
}

/** 开始维修：POST /m3/work-orders/:id/start（维修员本人） */
export function start(id: number): Promise<WorkOrder> {
  return http.post(`/m3/work-orders/${id}/start`).then((r) => r.data)
}

/** 完工待验收：POST /m3/work-orders/:id/complete（维修员本人） */
export function complete(id: number): Promise<WorkOrder> {
  return http.post(`/m3/work-orders/${id}/complete`).then((r) => r.data)
}

/** 验收评价：POST /m3/work-orders/:id/accept（上报人），rating 1-5 */
export function accept(
  id: number,
  data?: { result?: 'pass' | 'fail'; rating?: number; comment?: string },
): Promise<WorkOrder> {
  return http.post(`/m3/work-orders/${id}/accept`, data).then((r) => r.data)
}

/** 改派：POST /m3/work-orders/:id/reassign（权限 workorder.dispatch） */
export function reassign(
  id: number,
  data: { assigneeId: number; reason?: string },
): Promise<WorkOrder> {
  return http.post(`/m3/work-orders/${id}/reassign`, data).then((r) => r.data)
}

/** 工单留言：POST /m3/work-orders/:id/comments（上报人/维修员/派单员） */
export function comment(id: number, content: string): Promise<WorkOrderEvent> {
  return http.post(`/m3/work-orders/${id}/comments`, { content }).then((r) => r.data)
}

/** 更新预计恢复时间：PATCH /m3/work-orders/:id/eta */
export function updateEta(id: number, etaAt: string): Promise<WorkOrder> {
  return http.patch(`/m3/work-orders/${id}/eta`, { etaAt }).then((r) => r.data)
}

/** 补传现场照片：PATCH /m3/work-orders/:id/photos（最多 3 张） */
export function updatePhotos(id: number, photoUrls: string[]): Promise<WorkOrder> {
  return http.patch(`/m3/work-orders/${id}/photos`, { photoUrls }).then((r) => r.data)
}

/** 维修员申诉：POST /m3/work-orders/:id/appeal（仅返工中的工单） */
export function appeal(id: number, reason: string): Promise<WorkOrder> {
  return http.post(`/m3/work-orders/${id}/appeal`, { reason }).then((r) => r.data)
}

/** 申诉裁决：POST /m3/work-orders/:id/appeal/resolve（权限 workorder.manage） */
export function resolveAppeal(
  id: number,
  data: { result: 'upheld' | 'overturned'; note?: string },
): Promise<WorkOrder> {
  return http.post(`/m3/work-orders/${id}/appeal/resolve`, data).then((r) => r.data)
}

/** 低分回访处置：POST /m3/work-orders/:id/revisit（权限 workorder.manage） */
export function handleRevisit(id: number, note: string): Promise<WorkOrder> {
  return http.post(`/m3/work-orders/${id}/revisit`, { note }).then((r) => r.data)
}

/** 取消工单：POST /m3/work-orders/:id/cancel */
export function cancel(id: number, data?: { reason?: string }): Promise<WorkOrder> {
  return http.post(`/m3/work-orders/${id}/cancel`, data).then((r) => r.data)
}

/** 我的工单（上报/维修）：GET /m3/work-orders/mine?status= */
export function mine(params?: { status?: string }): Promise<WorkOrder[]> {
  return http.get('/m3/work-orders/mine', { params }).then((r) => r.data)
}

/** 待派单队列：GET /m3/work-orders/pending（权限 workorder.dispatch） */
export function pending(): Promise<WorkOrder[]> {
  return http.get('/m3/work-orders/pending').then((r) => r.data)
}

/** 分派给我的工单：GET /m3/work-orders/assignments（维修员） */
export function assignments(): Promise<WorkOrder[]> {
  return http.get('/m3/work-orders/assignments').then((r) => r.data)
}

/** 工单详情：GET /m3/work-orders/:id */
export function detail(id: number): Promise<WorkOrder> {
  return http.get(`/m3/work-orders/${id}`).then((r) => r.data)
}

/** 工单时间线：GET /m3/work-orders/:id/events */
export function events(id: number): Promise<WorkOrderEvent[]> {
  return http.get(`/m3/work-orders/${id}/events`).then((r) => r.data)
}

/** 字典与限制：GET /m3/work-orders/meta（分类选择器唯一数据源） */
export function meta(): Promise<WorkOrderMeta> {
  return http.get('/m3/work-orders/meta').then((r) => r.data)
}

/** 升级待处理队列：GET /m3/work-orders/escalated（权限 workorder.dispatch） */
export function escalated(): Promise<WorkOrder[]> {
  return http.get('/m3/work-orders/escalated').then((r) => r.data)
}

/** 低分回访队列：GET /m3/work-orders/revisits（权限 workorder.manage） */
export function revisits(): Promise<WorkOrder[]> {
  return http.get('/m3/work-orders/revisits').then((r) => r.data)
}

/** 疑似设备老化清单：GET /m3/work-orders/degraded（权限 workorder.dispatch） */
export function degraded(): Promise<WorkOrder[]> {
  return http.get('/m3/work-orders/degraded').then((r) => r.data)
}

/** 维修员负载与技能画像：GET /m3/work-orders/technicians（权限 workorder.stats） */
export function technicians(): Promise<TechnicianWorkload[]> {
  return http.get('/m3/work-orders/technicians').then((r) => r.data)
}
