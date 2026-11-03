import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import {
  Occupancy,
  OccupancyScope,
  OccupancySource,
} from '../../database/entities/occupancy.entity';

export interface BlockInput {
  scope: OccupancyScope;
  spaceId: number;
  seatId?: number | null;
  date: string;
  startHour: number;
  endHour: number;
  source: OccupancySource;
  refType: string;
  refId: number;
  operatorId?: number | null;
  reason?: string;
}

/** 占用解释：回答「这个座位这个时段为什么不可预约」 */
export interface BlockInfo {
  occupancyId: number;
  scope: OccupancyScope;
  source: OccupancySource;
  refType: string;
  refId: number;
  seatId: number | null;
  date: string;
  startHour: number;
  endHour: number;
  reason: string;
}

/**
 * 时段占用服务（D3 / ADR-0002）。
 *
 * 这是座位「能否预约」的唯一判据：M1/M2/M3 都通过本服务登记与释放占用，
 * 不再直接改写 `Seat.status` 来表达「被预约」。
 *
 * 所有方法都接受可选的 `manager`，以便调用方把占用写入与业务写入放进同一个事务。
 */
@Injectable()
export class OccupancyService {
  constructor(
    @InjectRepository(Occupancy)
    private readonly repo: Repository<Occupancy>,
  ) {}

  private repoOf(manager?: EntityManager): Repository<Occupancy> {
    return (manager ?? this.repo.manager).getRepository(Occupancy);
  }

  /** 登记一条占用 */
  async block(input: BlockInput, manager?: EntityManager): Promise<Occupancy> {
    if (input.scope === 'seat' && !input.seatId) {
      throw new Error('scope=seat 时必须提供 seatId');
    }
    if (input.startHour >= input.endHour) {
      throw new Error('占用时段不合法：startHour 必须小于 endHour');
    }
    const repo = this.repoOf(manager);
    return repo.save(
      repo.create({
        scope: input.scope,
        spaceId: input.spaceId,
        seatId: input.scope === 'seat' ? input.seatId ?? null : null,
        date: input.date,
        startHour: input.startHour,
        endHour: input.endHour,
        source: input.source,
        refType: input.refType,
        refId: input.refId,
        operatorId: input.operatorId ?? null,
        reason: input.reason ?? '',
        releasedAt: null,
      }),
    );
  }

  /** 按业务对象释放全部有效占用（驳回 / 撤销 / 超时） */
  async releaseByRef(
    refType: string,
    refId: number,
    manager?: EntityManager,
  ): Promise<number> {
    const repo = this.repoOf(manager);
    const result = await repo
      .createQueryBuilder()
      .update(Occupancy)
      .set({ releasedAt: new Date() })
      .where('"refType" = :refType AND "refId" = :refId AND "releasedAt" IS NULL', {
        refType,
        refId,
      })
      .execute();
    return result.affected ?? 0;
  }

  /** 某业务对象当前有效的占用 */
  async activeByRef(refType: string, refId: number): Promise<Occupancy[]> {
    return this.repo
      .createQueryBuilder('o')
      .where('o.refType = :refType', { refType })
      .andWhere('o.refId = :refId', { refId })
      .andWhere('o.releasedAt IS NULL')
      .orderBy('o.id', 'ASC')
      .getMany();
  }

  /** 与给定时段重叠的有效占用（内部工具） */
  private overlapQuery(
    repo: Repository<Occupancy>,
    date: string,
    startHour: number,
    endHour: number,
  ) {
    return repo
      .createQueryBuilder('o')
      .where('o.date = :date', { date })
      .andWhere('o.startHour < :endHour', { endHour })
      .andWhere('o.endHour > :startHour', { startHour })
      .andWhere('o.releasedAt IS NULL');
  }

  /**
   * 座位在给定时段是否可约。
   * 可约 = 无座位级重叠占用 ∧ 无所属空间的整间占用。
   */
  async isSeatAvailable(
    seatId: number,
    spaceId: number,
    date: string,
    startHour: number,
    endHour: number,
  ): Promise<boolean> {
    return (await this.explain(seatId, spaceId, date, startHour, endHour)) === null;
  }

  /**
   * 给出不可预约的原因；可预约时返回 null。
   * 空间级（整教室）占用优先返回，因为它解释了「整间教室都不行」。
   */
  async explain(
    seatId: number,
    spaceId: number,
    date: string,
    startHour: number,
    endHour: number,
  ): Promise<BlockInfo | null> {
    const spaceBlock = await this.overlapQuery(this.repo, date, startHour, endHour)
      .andWhere('o.scope = :scope', { scope: 'space' })
      .andWhere('o.spaceId = :spaceId', { spaceId })
      .orderBy('o.id', 'ASC')
      .getOne();
    if (spaceBlock) return this.toInfo(spaceBlock);

    const seatBlock = await this.overlapQuery(this.repo, date, startHour, endHour)
      .andWhere('o.scope = :scope', { scope: 'seat' })
      .andWhere('o.seatId = :seatId', { seatId })
      .orderBy('o.id', 'ASC')
      .getOne();
    return seatBlock ? this.toInfo(seatBlock) : null;
  }

  /** 某空间在给定时段内被占用的座位数（用于整教室申请前的冲突提示） */
  async countSeatBlocks(
    spaceId: number,
    date: string,
    startHour: number,
    endHour: number,
  ): Promise<number> {
    return this.overlapQuery(this.repo, date, startHour, endHour)
      .andWhere('o.scope = :scope', { scope: 'seat' })
      .andWhere('o.spaceId = :spaceId', { spaceId })
      .getCount();
  }

  /** 某空间某天仍然有效的占用，供前端展示占用来源 */
  async listBySpace(spaceId: number, date: string): Promise<BlockInfo[]> {
    const rows = await this.repo
      .createQueryBuilder('o')
      .where('o.spaceId = :spaceId', { spaceId })
      .andWhere('o.date = :date', { date })
      .andWhere('o.releasedAt IS NULL')
      .orderBy('o.startHour', 'ASC')
      .addOrderBy('o.id', 'ASC')
      .getMany();
    return rows.map((row) => this.toInfo(row));
  }

  /** 座位占用轨迹（追溯写入来源） */
  async historyBySeat(seatId: number, limit = 50): Promise<Occupancy[]> {
    return this.repo.find({
      where: { seatId },
      order: { id: 'DESC' },
      take: limit,
    });
  }

  private toInfo(row: Occupancy): BlockInfo {
    return {
      occupancyId: row.id,
      scope: row.scope,
      source: row.source,
      refType: row.refType,
      refId: row.refId,
      seatId: row.seatId,
      date: row.date,
      startHour: row.startHour,
      endHour: row.endHour,
      reason: row.reason,
    };
  }
}
