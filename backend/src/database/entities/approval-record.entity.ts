import { Entity, PrimaryGeneratedColumn, Column, Index, CreateDateColumn } from 'typeorm';

export type ApprovalAction = 'approve' | 'reject';

/** 审批记录（M2 多级审批痕迹） */
@Entity('approval_records')
export class ApprovalRecord {
  @PrimaryGeneratedColumn()
  id: number;

  @Index()
  @Column()
  requestId: number;

  @Column()
  approverId: number;

  @Column()
  approverName: string;

  /** 审批层级 */
  @Column()
  level: number;

  @Column()
  action: ApprovalAction;

  @Column({ default: '' })
  comment: string;

  @CreateDateColumn()
  createdAt: Date;
}
