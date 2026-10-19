import http from './http'
import type { BookSeatParams, Reservation, SearchSeatsParams, Seat, Space } from './types'

/**
 * M1 自习座位预约 API
 * 对照 backend/src/modules/m1-seats/reservations.controller.ts
 */

/** 搜索可用座位：GET /m1/seats/search（返回带 space 信息的座位列表） */
export function searchSeats(params: SearchSeatsParams): Promise<Array<Seat & { space?: Space }>> {
  return http.get('/m1/seats/search', { params }).then((r) => r.data)
}

/** 预约座位：POST /m1/reservations */
export function book(data: BookSeatParams): Promise<Reservation> {
  return http.post('/m1/reservations', data).then((r) => r.data)
}

/** 签到：POST /m1/reservations/:id/check-in，body 需携带动态码 */
export function checkIn(id: number, data: { code: string }): Promise<Reservation> {
  return http.post(`/m1/reservations/${id}/check-in`, data).then((r) => r.data)
}

/** 我的预约：GET /m1/reservations/mine?status= */
export function mine(params?: { status?: string }): Promise<Reservation[]> {
  return http.get('/m1/reservations/mine', { params }).then((r) => r.data)
}

/** 预约历史（分页）：GET /m1/history?page= */
export function history(params?: { page?: number }): Promise<Reservation[]> {
  return http.get('/m1/history', { params }).then((r) => r.data)
}

/** 取消预约：POST /m1/reservations/:id/cancel */
export function cancel(id: number): Promise<Reservation> {
  return http.post(`/m1/reservations/${id}/cancel`).then((r) => r.data)
}

/** 复用历史预约（同座位同时段）：POST /m1/reservations/:id/rebook */
export function rebook(id: number): Promise<Reservation> {
  return http.post(`/m1/reservations/${id}/rebook`).then((r) => r.data)
}

/** 签到动态码：GET /m1/spaces/:spaceId/dynamic-code?date= */
export function dynamicCode(spaceId: number, date: string): Promise<{ code: string }> {
  return http.get(`/m1/spaces/${spaceId}/dynamic-code`, { params: { date } }).then((r) => r.data)
}

/** 运营统计：GET /m1/stats（权限 stats.view） */
export function stats(): Promise<Record<string, unknown>> {
  return http.get('/m1/stats').then((r) => r.data)
}
