import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  Index,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

/** 预约状态 */
export type ReservationStatus =
  | 'booked' // 已预约（未签到）
  | 'checked_in' // 已签到
  | 'cancelled' // 用户取消
  | 'no_show' // 超时未签到自动取消
  | 'completed'; // 时段结束

@Entity('reservations')
export class Reservation {
  @PrimaryGeneratedColumn()
  id: number;

  @Index()
  @Column()
  userId: number;

  @Index()
  @Column()
  seatId: number;

  @Column()
  spaceId: number;

  @Column()
  spaceCode: string;

  @Column()
  spaceName: string;

  @Column()
  seatNo: string;

  /** 预约日期 YYYY-MM-DD */
  @Index()
  @Column()
  date: string;

  /** 起始整点小时 0-23 */
  @Column()
  startHour: number;

  /** 结束整点小时（不含） */
  @Column()
  endHour: number;

  @Column({ default: 'booked' })
  status: ReservationStatus;

  /** 签到动态编码（与教室关联，Web 端录入） */
  @Column({ default: '' })
  checkInCode: string;

  @Column({ type: 'datetime', nullable: true })
  checkInAt: Date | null;

  @Column({ default: false })
  remindBeforeSent: boolean;

  @Column({ default: false })
  remindAfterSent: boolean;

  @Column({ type: 'datetime', nullable: true })
  cancelledAt: Date | null;

  @Column({ type: 'datetime', nullable: true })
  noShowAt: Date | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
