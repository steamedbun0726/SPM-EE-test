import { Entity, PrimaryGeneratedColumn, Column, Index, CreateDateColumn, UpdateDateColumn } from 'typeorm';

/** 工单状态 */
export type WorkOrderStatus =
  | 'reported' // 已上报
  | 'dispatched' // 已派单
  | 'in_progress' // 维修中
  | 'on_hold' // 已挂起（SLA 暂停计时，座位保持下架）
  | 'completed' // 完工待验收
  | 'accepted' // 验收通过（座位自动恢复）
  | 'cancelled' // 已取消
  | 'merged'; // 已合并到主线工单（不产生独立下架/恢复）

/** 未完结状态：参与重复上报判重、SLA 计时、升级扫描 */
export const OPEN_WORK_ORDER_STATUSES: WorkOrderStatus[] = [
  'reported',
  'dispatched',
  'in_progress',
  'on_hold',
];

export type WorkOrderPriority = 'low' | 'medium' | 'high' | 'urgent';

/** 报修对象类型 */
export type WorkOrderTargetType = 'space' | 'seat' | 'other';

/** 物业报修工单（M3） */
@Entity('work_orders')
export class WorkOrder {
  @PrimaryGeneratedColumn()
  id: number;

  /** 工单号，如 WO-20261019-0001 */
  @Column({ unique: true })
  workOrderNo: string;

  @Index()
  @Column()
  reporterId: number;

  @Column()
  title: string;

  @Column({ type: 'text', default: '' })
  description: string;

  @Column({ default: 'other' })
  category: string;

  @Column({ default: 'medium' })
  priority: WorkOrderPriority;

  /** space=自习室/教室 seat=座位 other=其他设施 */
  @Column({ default: 'space' })
  targetType: WorkOrderTargetType;

  /** 报修对象 id（spaceId 或 seatId，other 时可为空） */
  @Column({ type: 'int', nullable: true })
  targetId: number | null;

  /** 关联空间（座位下架/恢复依赖） */
  @Column({ type: 'int', nullable: true })
  spaceId: number | null;

  @Column({ default: 'reported' })
  status: WorkOrderStatus;

  /** 派单维修员 */
  @Column({ type: 'int', nullable: true })
  assigneeId: number | null;

  /** 升级层级，0=未升级 */
  @Column({ default: 0 })
  escalateLevel: number;

  /** 解决时限（SLA）：超过未完工则升级 */
  @Column({ type: 'datetime', nullable: true })
  slaDeadline: Date | null;

  /** 首次响应时限：工单被接单（开工）的最后时刻，与 slaDeadline 构成双时限考核 */
  @Column({ type: 'datetime', nullable: true })
  responseDeadline: Date | null;

  /**
   * 原始解决时限：上报时按「分类基线 × 优先级系数」算出后**永不用于催促**的那一份。
   *
   * 为什么需要两份？slaDeadline 在每次超时升级时会被推后（+WORKORDER_ESCALATE_HOURS），
   * 若直接拿它算 SLA 达标率，任何被升级过的工单都会显得"没有超时"。
   * originalSlaDeadline 只在挂起顺延时同步平移，用于事后统计，口径才自洽。
   */
  @Column({ type: 'datetime', nullable: true })
  originalSlaDeadline: Date | null;

  /** 维修员实际接单（开工）时刻，首响时长的计算起点终点 */
  @Column({ type: 'datetime', nullable: true })
  firstRespondedAt: Date | null;

  @Column({ type: 'datetime', nullable: true })
  dispatchedAt: Date | null;

  @Column({ type: 'datetime', nullable: true })
  inProgressAt: Date | null;

  @Column({ type: 'datetime', nullable: true })
  completedAt: Date | null;

  @Column({ type: 'datetime', nullable: true })
  acceptedAt: Date | null;

  /** 验收评分 1-5 */
  @Column({ type: 'int', nullable: true })
  rating: number | null;

  @Column({ default: '' })
  ratingComment: string;

  @Column({ default: '' })
  cancelReason: string;

  /** 返工次数：验收不通过一次 +1，用于限制无限循环（上限见 WORKORDER_MAX_REOPEN） */
  @Column({ default: 0 })
  reopenCount: number;

  /** 是否处于 SLA 超时升级待处理状态（派单员在升级列表中处理） */
  @Column({ default: false })
  escalated: boolean;

  /** 本次下架的座位 id 清单（JSON 数组）；恢复时据此精确回滚，支持部分下架 */
  @Column({ default: '' })
  seatIds: string;

  /** 预计恢复时间：告知报修人，可展示在 M1 座位卡片上 */
  @Column({ type: 'datetime', nullable: true })
  etaAt: Date | null;

  /** 现场照片 URL 列表（JSON 数组，最多 3 张） */
  @Column({ default: '' })
  photoUrls: string;

  /** 维修员申诉理由（对验收不通过有异议时提出） */
  @Column({ default: '' })
  appealReason: string;

  @Column({ type: 'datetime', nullable: true })
  appealAt: Date | null;

  /** 申诉裁决：upheld=维持返工（报修人意见成立） overturned=推翻返工（维修员有理） */
  @Column({ type: 'varchar', nullable: true })
  appealResult: 'upheld' | 'overturned' | null;

  @Column({ type: 'int', nullable: true })
  appealHandledBy: number | null;

  @Column({ type: 'datetime', nullable: true })
  appealHandledAt: Date | null;

  /** 低分（≤2 星）自动回访标记 */
  @Column({ default: false })
  revisitRequired: boolean;

  @Column({ default: false })
  revisitHandled: boolean;

  /** SLA 超时预警是否已发送，避免重复提醒 */
  @Column({ default: false })
  slaWarned: boolean;

  /** 疑似设备老化：同空间同分类故障在窗口期内反复发生 */
  @Column({ default: false })
  degradedSuspected: boolean;

  // ===== 挂起（M3-14） =====

  /** 挂起原因，如「等厂家配件」「需停电作业」 */
  @Column({ default: '' })
  holdReason: string;

  /** 维修员已提出挂起申请、等待派单员确认（此期间状态不变，SLA 照常计时） */
  @Column({ default: false })
  holdRequested: boolean;

  @Column({ type: 'datetime', nullable: true })
  holdRequestedAt: Date | null;

  @Column({ type: 'int', nullable: true })
  holdRequestedBy: number | null;

  /** 挂起生效时刻；SLA 从这一刻起暂停计时 */
  @Column({ type: 'datetime', nullable: true })
  onHoldSince: Date | null;

  /** 挂起前的状态（dispatched / in_progress），恢复时据此还原 */
  @Column({ default: '' })
  preHoldStatus: string;

  /** 累计挂起分钟数：解决时长的统计口径要扣掉它 */
  @Column({ default: 0 })
  totalHoldMinutes: number;

  /** 挂起超期升级是否已处理，避免定时任务每轮重复告警 */
  @Column({ default: false })
  holdEscalated: boolean;

  // ===== 合并（M3-15） =====

  /** 被合并方指向主线工单 id；主线该字段为空 */
  @Column({ type: 'int', nullable: true })
  mergedIntoId: number | null;

  /** 主线工单累计吸收的重复工单数（展示用，避免每次 count 查询） */
  @Column({ default: 0 })
  mergedCount: number;

  // ===== 维修记录（M3-17） =====

  /** 完工维修说明：维修员必填，报修人验收时可见 */
  @Column({ default: '' })
  resolutionNote: string;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
