import { Entity, PrimaryGeneratedColumn, Column, Index, CreateDateColumn, UpdateDateColumn } from 'typeorm';

/** 整教室预约申请状态 */
export type RoomRequestStatus =
  | 'pending' // 待审批
  | 'approved' // 审批通过（占用座位）
  | 'rejected' // 审批驳回
  | 'cancelled' // 申请人撤销
  | 'expired'; // 超时自动撤销

@Entity('room_booking_requests')
export class RoomBookingRequest {
  @PrimaryGeneratedColumn()
  id: number;

  /** 申请单号，如 RB-20261019-0001 */
  @Column({ unique: true })
  requestCode: string;

  @Index()
  @Column()
  requesterId: number;

  @Index()
  @Column()
  spaceId: number;

  @Column()
  spaceCode: string;

  @Column()
  spaceName: string;

  @Column()
  date: string;

  @Column()
  startHour: number;

  @Column()
  endHour: number;

  @Column({ default: '' })
  purpose: string;

  @Column({ default: 'pending' })
  status: RoomRequestStatus;

  /** 当前审批层级（1 起） */
  @Column({ default: 1 })
  currentLevel: number;

  /** 总审批层级 */
  @Column({ default: 2 })
  maxLevel: number;

  /** 超时截止时间；超时未完成审批自动撤销 */
  @Column({ type: 'datetime', nullable: true })
  timeoutAt: Date | null;

  /** 审批通过时被占用的座位 id 列表（回滚用） */
  @Column({ type: 'simple-json', nullable: true })
  occupiedSeatIds: number[] | null;

  @Column({ default: '' })
  rejectReason: string;

  @Column({ type: 'datetime', nullable: true })
  decidedAt: Date | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
