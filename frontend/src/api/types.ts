/**
 * 公共类型定义：与后端接口契约严格对齐
 * 来源：backend/src/database/entities/* 与 controller DTO、JwtUser 定义
 */

/** JWT 用户信息（后端 JwtUser，auth/me 返回） */
export interface JwtUser {
  userId: number
  username: string
  name: string
  roles: string[]
  permissions: string[]
  department: string
}

/** 登录/注册返回结构 */
export interface LoginResult {
  accessToken: string
  user: JwtUser
}

/* ===== M1 座位预约 ===== */

export type ReservationStatus = 'booked' | 'checked_in' | 'cancelled' | 'no_show' | 'completed'

export interface Reservation {
  id: number
  userId: number
  seatId: number
  spaceId: number
  spaceCode: string
  spaceName: string
  seatNo: string
  date: string
  startHour: number
  endHour: number
  status: ReservationStatus
  checkInCode: string
  checkInAt: Date | null
  cancelledAt: Date | null
  noShowAt: Date | null
  createdAt: Date
  updatedAt: Date
}

/** 座位搜索入参（SearchSeatsDto） */
export interface SearchSeatsParams {
  spaceId?: number
  spaceName?: string
  date: string
  startHour: number
  endHour: number
  hasSocket?: boolean
}

/** 预约入参（BookSeatDto） */
export interface BookSeatParams {
  seatId: number
  date: string
  startHour: number
  endHour: number
}

/* ===== M2 整教室预约 ===== */

export type RoomRequestStatus = 'pending' | 'approved' | 'rejected' | 'cancelled' | 'expired'

export interface RoomBookingRequest {
  id: number
  requestCode: string
  requesterId: number
  spaceId: number
  spaceCode: string
  spaceName: string
  date: string
  startHour: number
  endHour: number
  purpose: string
  status: RoomRequestStatus
  currentLevel: number
  maxLevel: number
  timeoutAt: Date | null
  occupiedSeatIds: number[] | null
  rejectReason: string
  decidedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

/** 审批记录（ApprovalRecord） */
export interface ApprovalRecord {
  id: number
  requestId: number
  approverId: number
  approverName: string
  level: number
  action: 'approve' | 'reject'
  comment: string
  createdAt: Date
}

/** 整教室预约申请入参（ApplyRoomRequestDto） */
export interface ApplyRoomRequestParams {
  spaceId: number
  date: string
  startHour: number
  endHour: number
  purpose?: string
}

/* ===== M3 物业报修 ===== */

export type WorkOrderStatus =
  | 'reported'
  | 'dispatched'
  | 'in_progress'
  | 'on_hold'
  | 'completed'
  | 'accepted'
  | 'cancelled'
  | 'merged'
export type WorkOrderPriority = 'low' | 'medium' | 'high' | 'urgent'
export type WorkOrderTargetType = 'space' | 'seat' | 'other'

export interface WorkOrder {
  id: number
  workOrderNo: string
  reporterId: number
  title: string
  description: string
  category: string
  priority: WorkOrderPriority
  targetType: WorkOrderTargetType
  targetId: number | null
  spaceId: number | null
  status: WorkOrderStatus
  assigneeId: number | null
  escalateLevel: number
  slaDeadline: string | null
  /** 首响时限：与 slaDeadline 构成双时限 */
  responseDeadline: string | null
  dispatchedAt: string | null
  inProgressAt: string | null
  completedAt: string | null
  acceptedAt: string | null
  rating: number | null
  ratingComment: string
  cancelReason: string
  reopenCount: number
  escalated: boolean
  /** 本次下架的座位 id 清单（JSON 字符串，视图层已解析为 seatIdList） */
  seatIds: string
  seatIdList: number[]
  etaAt: string | null
  photoUrls: string
  photoUrlList: string[]
  appealReason: string
  appealAt: string | null
  appealResult: 'upheld' | 'overturned' | null
  appealHandledBy: number | null
  appealHandledAt: string | null
  revisitRequired: boolean
  revisitHandled: boolean
  slaWarned: boolean
  degradedSuspected: boolean
  /** 首响时刻（首次开工） */
  firstRespondedAt: string | null
  /** 原始解决时限：不随升级推后，统计 SLA 达标率用 */
  originalSlaDeadline: string | null
  /** 完工维修说明（M3-17，完工必填） */
  resolutionNote: string
  /** 挂起原因 */
  holdReason: string
  /** 挂起申请中（待派单员确认），此时状态与计时都不变 */
  holdRequested: boolean
  holdRequestedAt: string | null
  holdRequestedBy: number | null
  /** 挂起生效时刻，SLA 从此刻暂停 */
  onHoldSince: string | null
  /** 挂起前状态，恢复时还原 */
  preHoldStatus: string
  /** 累计挂起分钟数 */
  totalHoldMinutes: number
  /** 视图层实时累计（含进行中的挂起） */
  holdMinutes: number
  holdEscalated: boolean
  /** 被合并方指向的主线工单 id */
  mergedIntoId: number | null
  /** 主线吸收的重复工单数 */
  mergedCount: number
  /** 展示用标签（后端返回，避免前端重复维护字典） */
  categoryLabel: string
  priorityLabel: string
  statusLabel: string
  slaRemainMs: number | null
  slaUsedRatio: number | null
  createdAt: string
  updatedAt: string
}

/** 工单事件（时间线） */
export type WorkOrderEventType =
  | 'reported'
  | 'dispatched'
  | 'reassigned'
  | 'started'
  | 'completed'
  | 'accepted'
  | 'rejected'
  | 'hold_requested'
  | 'hold_rejected'
  | 'hold'
  | 'resumed'
  | 'cancelled'
  | 'merged'
  | 'merge_absorbed'
  | 'escalated'
  | 'commented'
  | 'eta_updated'
  | 'appealed'
  | 'appeal_resolved'
  | 'warned'
  | 'revisited'
  | 'seats_released'

export interface WorkOrderEvent {
  id: number
  workOrderId: number
  type: WorkOrderEventType
  fromStatus: string | null
  toStatus: string
  operatorId: number | null
  operatorName: string
  note: string
  createdAt: string
}

/** 字典与限制（GET /m3/work-orders/meta） */
export interface WorkOrderMeta {
  categories: { code: string; name: string; defaultSlaHours: number }[]
  priorities: { code: WorkOrderPriority; name: string; slaFactor: number }[]
  statuses: { code: WorkOrderStatus; name: string }[]
  limits: {
    maxPhotos: number
    maxReopen: number
    maxAppeal: number
    etaMaxDays: number
    commentMaxLength: number
  }
}

/** 维修员负载与技能画像 */
export interface TechnicianWorkload {
  userId: number
  name: string
  department: string
  activeCount: number
  urgentCount: number
  completedCount: number
  avgRating: number | null
  avgHandleHours: number | null
  topCategories: { category: string; name: string; count: number }[]
}

/** 报修上报入参（ReportWorkOrderDto） */
export interface ReportWorkOrderParams {
  title: string
  description?: string
  /** 分类字典码，见 WorkOrderMeta.categories */
  category?: string
  priority?: WorkOrderPriority
  targetType: WorkOrderTargetType
  targetId?: number
  spaceId?: number
  /** 部分下架：仅下架这些座位 */
  seatIds?: number[]
  /** 现场照片 URL，最多 3 张 */
  photoUrls?: string[]
  /** 预计恢复时间（ISO 字符串） */
  etaAt?: string
  /** 合并到主线工单（同目标已存在未完结工单时由用户确认后带上） */
  mergeIntoId?: number
}

/** 完工入参：维修说明必填（M3-17） */
export interface CompleteWorkOrderParams {
  resolutionNote: string
  photoUrls?: string[]
}

/** 工单统计看板（M3-18）：每个比率的分母口径见 definitions */
export interface WorkOrderStats {
  range: { from: string; to: string }
  totals: {
    total: number
    open: number
    accepted: number
    cancelled: number
    merged: number
    effective: number
  }
  byStatus: { status: WorkOrderStatus; name: string; count: number }[]
  byCategory: { category: string; name: string; count: number; openCount: number }[]
  byPriority: { priority: WorkOrderPriority; name: string; count: number }[]
  kpi: {
    completionRate: number | null
    avgResponseHours: number | null
    avgResolveHours: number | null
    slaComplianceRate: number | null
    reworkRate: number | null
    avgRating: number | null
  }
  topSpaces: { spaceId: number; name: string; code: string; count: number; openCount: number }[]
  definitions: Record<string, string>
}

/* ===== 公共数据（空间/座位） ===== */

export type SpaceType = 'study' | 'classroom' | 'library' | 'other'

export interface Space {
  id: number
  code: string
  name: string
  type: SpaceType
  ownerDept: string
  openTime: string
  closeTime: string
  isActive: boolean
  description: string
  createdAt: Date
  updatedAt: Date
}

export interface Seat {
  id: number
  spaceId: number
  seatNo: string
  hasSocket: boolean
  isActive: boolean
  status: 'available' | 'maintenance' | 'occupied_by_room'
  statusSource: 'M1' | 'M2' | 'M3' | 'SYSTEM' | null
  lastStatusAt: Date | null
  createdAt: Date
  updatedAt: Date
}

/* ===== 管理端（RBAC/审计/配置/通知） ===== */

export interface User {
  id: number
  username: string
  name: string
  email: string
  phone: string
  department: string
  isActive: boolean
  roles?: Role[]
  createdAt: Date
  updatedAt: Date
}

export interface Role {
  id: number
  code: string
  name: string
  description: string
  createdAt: Date
}

export interface Permission {
  id: number
  code: string
  name: string
  description: string
}

export interface AuditLog {
  id: number
  userId: number | null
  username: string
  action: string
  resourceType: string
  resourceId: string
  detail: string
  ip: string
  createdAt: Date
}

export interface SystemConfig {
  id: number
  key: string
  value: string
  description: string
}

export interface Notification {
  id: number
  userId: number
  type: 'reminder' | 'no_show' | 'approval' | 'workorder' | 'system'
  title: string
  content: string
  isRead: boolean
  createdAt: Date
}

/** 分页查询通用入参 */
export interface PageParams {
  keyword?: string
  page?: number
  pageSize?: number
}
