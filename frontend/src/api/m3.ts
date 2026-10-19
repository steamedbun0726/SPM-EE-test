import http from './http'
import type { ReportWorkOrderParams, WorkOrder } from './types'

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
export function accept(id: number, data?: { rating?: number; comment?: string }): Promise<WorkOrder> {
  return http.post(`/m3/work-orders/${id}/accept`, data).then((r) => r.data)
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
