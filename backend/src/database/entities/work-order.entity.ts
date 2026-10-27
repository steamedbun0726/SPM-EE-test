import { Entity, PrimaryGeneratedColumn, Column, Index, CreateDateColumn, UpdateDateColumn } from 'typeorm';

/** 工单状态 */
export type WorkOrderStatus =
  | 'reported' // 已上报
  | 'dispatched' // 已派单
  | 'in_progress' // 维修中
  | 'completed' // 完工待验收
  | 'accepted' // 验收通过（座位自动恢复）
  | 'cancelled'; // 已取消

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

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
