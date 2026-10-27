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

  /** SLA 截止时间，超过未完工则升级 */
  @Column({ type: 'datetime', nullable: true })
  slaDeadline: Date | null;

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

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
