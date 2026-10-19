import http from './http'
import type { ApprovalRecord, ApplyRoomRequestParams, RoomBookingRequest } from './types'

/**
 * M2 整教室预约与审批 API
 * 对照 backend/src/modules/m2-rooms/room-requests.controller.ts（前缀 /m2/requests）
 */

/** 提交整教室预约申请：POST /m2/requests（权限 room.apply） */
export function apply(data: ApplyRoomRequestParams): Promise<RoomBookingRequest> {
  return http.post('/m2/requests', data).then((r) => r.data)
}

/** 审批通过（多级审批）：POST /m2/requests/:id/approve（权限 room.approve） */
export function approve(id: number, data?: { comment?: string }): Promise<RoomBookingRequest> {
  return http.post(`/m2/requests/${id}/approve`, data).then((r) => r.data)
}

/** 审批驳回：POST /m2/requests/:id/reject（权限 room.approve） */
export function reject(id: number, data?: { comment?: string }): Promise<RoomBookingRequest> {
  return http.post(`/m2/requests/${id}/reject`, data).then((r) => r.data)
}

/** 申请人撤销（本人）：POST /m2/requests/:id/cancel */
export function cancel(id: number): Promise<RoomBookingRequest> {
  return http.post(`/m2/requests/${id}/cancel`).then((r) => r.data)
}

/** 我的申请：GET /m2/requests/mine?status= */
export function mine(params?: { status?: string }): Promise<RoomBookingRequest[]> {
  return http.get('/m2/requests/mine', { params }).then((r) => r.data)
}

/** 审批队列（待审批）：GET /m2/requests/pending（权限 room.approve） */
export function pending(): Promise<RoomBookingRequest[]> {
  return http.get('/m2/requests/pending').then((r) => r.data)
}

/** 申请状态详情（本人或审批人）：GET /m2/requests/:id */
export function detail(id: number): Promise<RoomBookingRequest> {
  return http.get(`/m2/requests/${id}`).then((r) => r.data)
}

/** 审批记录：GET /m2/requests/:id/approvals */
export function approvals(id: number): Promise<ApprovalRecord[]> {
  return http.get(`/m2/requests/${id}/approvals`).then((r) => r.data)
}
