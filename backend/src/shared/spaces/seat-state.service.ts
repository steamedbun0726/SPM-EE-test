import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Seat, SeatStatus, SeatStatusSource } from '../../database/entities/seat.entity';
import { SeatStatusLog } from '../../database/entities/seat-status-log.entity';

export interface StatusChangeInput {
  seatId: number;
  spaceId: number;
  seatNo: string;
  fromStatus: string;
  toStatus: SeatStatus;
  source: Exclude<SeatStatusSource, null> | 'SYSTEM';
  refType: string;
  refId: number | null;
  reason: string;
  operatorId: number | null;
}

/**
 * 座位状态统一变更入口（跨模块集成核心）。
 * M1 / M2 / M3 对座位状态的任何变更都必须经过本服务，
 * 以保证「写入来源」被记录、可追溯、可验收。
 */
@Injectable()
export class SeatStateService {
  constructor(
    @InjectRepository(Seat) private readonly seatRepo: Repository<Seat>,
    @InjectRepository(SeatStatusLog) private readonly logRepo: Repository<SeatStatusLog>,
  ) {}

  private async apply(seat: Seat, input: Omit<StatusChangeInput, 'fromStatus' | 'seatNo' | 'spaceId' | 'seatId'>) {
    const before = seat.status;
    if (before === input.toStatus) return; // 幂等：状态未变不写日志
    seat.status = input.toStatus;
    seat.statusSource = input.source;
    seat.lastStatusAt = new Date();
    await this.seatRepo.save(seat);
    await this.logRepo.save(
      this.logRepo.create({
        seatId: seat.id,
        spaceId: seat.spaceId,
        seatNo: seat.seatNo,
        fromStatus: before,
        toStatus: input.toStatus,
        source: input.source,
        refType: input.refType,
        refId: input.refId,
        reason: input.reason,
        operatorId: input.operatorId,
      }),
    );
  }

  /**
   * M3 报修下架：将指定空间全部座位置为 maintenance（维修中），
   * 从可预约列表下架。验收通过后调用 restoreAfterMaintenance 恢复。
   */
  async setMaintenance(spaceId: number, workOrderId: number | null, operatorId: number | null, reason: string) {
    const seats = await this.seatRepo.find({ where: { spaceId, isActive: true } });
    for (const seat of seats) {
      await this.apply(seat, {
        toStatus: 'maintenance',
        source: 'M3',
        refType: 'work_order',
        refId: workOrderId,
        reason,
        operatorId,
      });
    }
    return seats.length;
  }

  /** M3 验收通过：恢复该空间座位为 available */
  async restoreAfterMaintenance(spaceId: number, workOrderId: number | null, operatorId: number | null, reason: string) {
    const seats = await this.seatRepo.find({
      where: { spaceId, isActive: true, status: 'maintenance' },
    });
    for (const seat of seats) {
      await this.apply(seat, {
        toStatus: 'available',
        source: 'M3',
        refType: 'work_order',
        refId: workOrderId,
        reason,
        operatorId,
      });
    }
    return seats.length;
  }

  /**
   * M3 座位粒度下架（批量）。
   *
   * 用于「部分下架」：一间教室只有部分座位损坏时，只下架受影响的座位，
   * 其余座位保持可预约。幂等：已是 maintenance 的座位跳过，返回实际变更数。
   *
   * 来源标记与整房间下架保持一致（source=M3、refType=work_order），
   * 因此 SeatStatusLog 的追溯口径不需要区分两种粒度。
   */
  async setSeatsMaintenance(
    seatIds: number[],
    workOrderId: number | null,
    operatorId: number | null,
    reason: string,
  ): Promise<number> {
    if (!seatIds.length) return 0;
    const seats = await this.seatRepo.findBy({ id: In(seatIds) });
    let count = 0;
    for (const seat of seats) {
      if (seat.status === 'maintenance') continue;
      await this.apply(seat, {
        toStatus: 'maintenance',
        source: 'M3',
        refType: 'work_order',
        refId: workOrderId,
        reason,
        operatorId,
      });
      count++;
    }
    return count;
  }

  /** 单座位下架（批量方法的便捷包装） */
  async setSeatMaintenance(
    seatId: number,
    workOrderId: number | null,
    operatorId: number | null,
    reason: string,
  ): Promise<boolean> {
    return (await this.setSeatsMaintenance([seatId], workOrderId, operatorId, reason)) > 0;
  }

  /**
   * M3 座位粒度恢复（批量）。
   * 只恢复由维修导致下架的座位；非 maintenance 状态不动，避免误伤 M2 占用。
   */
  async restoreSeatsAfterMaintenance(
    seatIds: number[],
    workOrderId: number | null,
    operatorId: number | null,
    reason: string,
  ): Promise<number> {
    if (!seatIds.length) return 0;
    const seats = await this.seatRepo.findBy({ id: In(seatIds) });
    let count = 0;
    for (const seat of seats) {
      if (seat.status !== 'maintenance') continue;
      await this.apply(seat, {
        toStatus: 'available',
        source: 'M3',
        refType: 'work_order',
        refId: workOrderId,
        reason,
        operatorId,
      });
      count++;
    }
    return count;
  }

  /** 单座位恢复（批量方法的便捷包装） */
  async restoreSeatAfterMaintenance(
    seatId: number,
    workOrderId: number | null,
    operatorId: number | null,
    reason: string,
  ): Promise<boolean> {
    return (await this.restoreSeatsAfterMaintenance([seatId], workOrderId, operatorId, reason)) > 0;
  }

  /** M2 审批通过：占用指定座位（该时段不接受个人预约） */
  async occupyByRoom(spaceId: number, requestId: number, seatIds: number[], operatorId: number | null, reason: string) {
    const seats = await this.seatRepo.findBy({ id: In(seatIds) });
    let count = 0;
    for (const seat of seats) {
      if (seat.status === 'maintenance') continue; // 维修中座位不占用
      await this.apply(seat, {
        toStatus: 'occupied_by_room',
        source: 'M2',
        refType: 'room_request',
        refId: requestId,
        reason,
        operatorId,
      });
      count++;
    }
    return count;
  }

  /** M2 驳回/超时撤销：回滚座位为 available */
  async releaseRoom(spaceId: number, requestId: number, seatIds: number[], operatorId: number | null, reason: string) {
    const seats = await this.seatRepo.findBy({ id: In(seatIds) });
    let count = 0;
    for (const seat of seats) {
      if (seat.status !== 'occupied_by_room') continue;
      await this.apply(seat, {
        toStatus: 'available',
        source: 'M2',
        refType: 'room_request',
        refId: requestId,
        reason,
        operatorId,
      });
      count++;
    }
    return count;
  }

  /** 查询座位状态历史（追溯写入来源） */
  async history(seatId: number, limit = 50) {
    return this.logRepo.find({
      where: { seatId },
      order: { id: 'DESC' },
      take: limit,
    });
  }
}
