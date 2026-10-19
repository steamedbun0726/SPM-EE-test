import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Space } from './space.entity';

/** 座位宏观状态 */
export type SeatStatus = 'available' | 'maintenance' | 'occupied_by_room';

/** 状态写入来源（追溯与验收关键字段） */
export type SeatStatusSource = 'M1' | 'M2' | 'M3' | 'SYSTEM' | null;

@Entity('seats')
export class Seat {
  @PrimaryGeneratedColumn()
  id: number;

  @ManyToOne(() => Space, (s) => s.seats, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'spaceId' })
  space: Space;

  @Column()
  spaceId: number;

  /** 座位号（自习室内唯一） */
  @Column()
  seatNo: string;

  /** 是否靠固定插座或移动导轨插座（特殊标记，可作搜索条件） */
  @Column({ default: false })
  hasSocket: boolean;

  @Column({ default: true })
  isActive: boolean;

  @Column({ default: 'available' })
  status: SeatStatus;

  /** 最近一次状态变更的写入来源 */
  @Column({ type: 'varchar', nullable: true })
  statusSource: SeatStatusSource;

  @Column({ type: 'datetime', nullable: true })
  lastStatusAt: Date | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
