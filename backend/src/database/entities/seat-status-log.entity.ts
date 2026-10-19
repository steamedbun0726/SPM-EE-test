import { Entity, PrimaryGeneratedColumn, Column, Index, CreateDateColumn } from 'typeorm';
import { SeatStatusSource } from './seat.entity';

/** 座位状态变更历史（写入来源追溯） */
@Entity('seat_status_logs')
export class SeatStatusLog {
  @PrimaryGeneratedColumn()
  id: number;

  @Index()
  @Column()
  seatId: number;

  @Column()
  spaceId: number;

  @Column({ default: '' })
  seatNo: string;

  @Column()
  fromStatus: string;

  @Column()
  toStatus: string;

  /** 写入来源：M1 预约 / M2 审批占用 / M3 报修下架 / SYSTEM */
  @Column({ type: 'varchar' })
  source: SeatStatusSource | 'SYSTEM';

  /** 关联的业务单据：预约 id / 审批单 id / 工单 id */
  @Column({ default: '' })
  refType: string;

  @Column({ type: 'int', nullable: true })
  refId: number | null;

  @Column({ default: '' })
  reason: string;

  @Column({ type: 'int', nullable: true })
  operatorId: number | null;

  @CreateDateColumn()
  createdAt: Date;
}
