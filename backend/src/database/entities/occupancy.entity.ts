import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/** 占用粒度：seat = 单个座位被预约；space = 整间教室被占用 */
export type OccupancyScope = 'seat' | 'space';

/** 占用来源，用于满足「座位状态必须记录写入来源」的验收要求 */
export type OccupancySource = 'M1' | 'M2' | 'M3' | 'SYSTEM';

/**
 * 时段占用记录（ADR-0002）。
 *
 * 一行 = 「某个座位或某个空间，在某个时段被占用」。
 * 可用性判据只有这一张表，`Seat.status` 只表达物理状态（available / maintenance / retired）。
 *
 * 释放不做物理删除，而是写 `releasedAt`，保留完整轨迹用于追溯与审计。
 */
@Entity('occupancies')
@Index('IDX_occupancies_space_date', ['spaceId', 'date'])
@Index('IDX_occupancies_seat_date', ['seatId', 'date'])
@Index('IDX_occupancies_ref', ['refType', 'refId'])
export class Occupancy {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ default: 'seat' })
  scope: OccupancyScope;

  @Column()
  spaceId: number;

  /** scope='seat' 时必填；scope='space' 时为空 */
  @Column({ type: 'integer', nullable: true })
  seatId: number | null;

  /** 日期 YYYY-MM-DD */
  @Column()
  date: string;

  /** 起始整点小时（含） */
  @Column({ type: 'integer' })
  startHour: number;

  /** 结束整点小时（不含） */
  @Column({ type: 'integer' })
  endHour: number;

  @Column()
  source: OccupancySource;

  /** 关联的业务对象类型：reservation | room_request | work_order */
  @Column()
  refType: string;

  /** 关联的业务对象 id，用于从占用反查申请单 */
  @Column({ type: 'integer' })
  refId: number;

  @Column({ type: 'integer', nullable: true })
  operatorId: number | null;

  @Column({ default: '' })
  reason: string;

  /** 释放时刻；NULL 表示该占用仍然有效 */
  @Column({ type: 'datetime', nullable: true })
  releasedAt: Date | null;

  @CreateDateColumn()
  createdAt: Date;
}
