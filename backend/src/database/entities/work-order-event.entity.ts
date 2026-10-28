import { Entity, PrimaryGeneratedColumn, Column, Index, CreateDateColumn } from 'typeorm';

/** 工单事件类型：一次状态流转或关键动作对应一条事件 */
export type WorkOrderEventType =
  | 'reported' // 上报
  | 'dispatched' // 派单
  | 'reassigned' // 改派
  | 'started' // 开工（首响）
  | 'completed' // 完工
  | 'accepted' // 验收通过
  | 'rejected' // 验收不通过（返工）
  | 'hold_requested' // 维修员申请挂起（待派单员确认）
  | 'hold_rejected' // 挂起申请被驳回
  | 'hold' // 挂起生效（SLA 暂停）
  | 'resumed' // 解除挂起（SLA 顺延）
  | 'cancelled' // 取消
  | 'merged' // 本单被合并进其它工单
  | 'merge_absorbed' // 本单作为主线吸收了其它工单
  | 'escalated' // SLA 超时升级
  | 'commented' // 工单留言
  | 'eta_updated' // 更新预计恢复时间
  | 'appealed' // 维修员申诉
  | 'appeal_resolved' // 申诉裁决
  | 'warned' // SLA 即将超时预警
  | 'revisited' // 低分回访已处理
  | 'seats_released'; // 座位释放记录（部分下架回滚）

/**
 * 工单事件（M3 时间线 / 追溯）。
 *
 * 设计约束：只追加不修改，作为工单的“黑匣子”。
 * 所有状态变更统一由 WorkOrdersService 的 transition() 写入，禁止在 Controller 直接补记。
 */
@Entity('work_order_events')
export class WorkOrderEvent {
  @PrimaryGeneratedColumn()
  id: number;

  @Index()
  @Column()
  workOrderId: number;

  @Column({ type: 'varchar' })
  type: WorkOrderEventType;

  /** 变更前状态；创建工作单时为 null */
  @Column({ type: 'varchar', nullable: true })
  fromStatus: string | null;

  /** 变更后状态 */
  @Column({ type: 'varchar' })
  toStatus: string;

  @Column({ type: 'int', nullable: true })
  operatorId: number | null;

  /** 操作人姓名快照，避免用户改名后历史记录失真 */
  @Column({ default: '' })
  operatorName: string;

  /** 备注：改派原因、返工原因、取消原因等 */
  @Column({ default: '' })
  note: string;

  @CreateDateColumn()
  createdAt: Date;
}
