import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, In, Repository } from 'typeorm';
import { Reservation, ReservationStatus } from '../../database/entities/reservation.entity';
import { RoomBookingRequest } from '../../database/entities/room-booking-request.entity';
import { Seat } from '../../database/entities/seat.entity';
import { Space, SpaceType } from '../../database/entities/space.entity';
import { SpacesService } from '../../shared/spaces/spaces.service';
import { SystemConfigService } from '../../shared/system-config/system-config.service';

export interface SearchSeatsQuery {
  spaceId?: number;
  spaceName?: string;
  date: string;
  startHour: number;
  endHour: number;
  hasSocket?: boolean;
}

export interface SearchSeatItem {
  seatId: number;
  seatNo: string;
  hasSocket: boolean;
  spaceId: number;
  spaceCode: string;
  spaceName: string;
  spaceType: SpaceType;
  ownerDept: string;
  openTime: string;
  closeTime: string;
}

export interface BookSeatInput {
  seatId: number;
  date: string;
  startHour: number;
  endHour: number;
}

export interface ReservationStatsRow {
  spaceId: number;
  code: string;
  name: string;
  bookingCount: number;
  noShowCount: number;
  checkedInCount: number;
}

/** 调用者上下文（用于院系自习室开放范围校验） */
export interface CallerContext {
  department?: string;
}

/** 冲突检测中视为占用预约的状态 */
const ACTIVE_RESERVATION_STATUSES: ReservationStatus[] = ['booked', 'checked_in'];

/** 历史记录分页大小 */
const HISTORY_PAGE_SIZE = 10;

/**
 * M1 自习座位预约核心业务。
 * 冲突检测（searchSeats / bookSeat 共用）：
 *   座位可预约 ⇔ Seat.isActive && status='available'
 *     && 无 Reservation 冲突（同 seatId+date+时段重叠+booked/checked_in）
 *     && 无 M2 冲突（同 spaceId+date+时段重叠+approved 的 RoomBookingRequest）
 *     && 院系自习室（ownerDept 非空）仅本系可见/可约
 */
@Injectable()
export class ReservationsService {
  constructor(
    @InjectRepository(Reservation) private readonly resvRepo: Repository<Reservation>,
    @InjectRepository(RoomBookingRequest) private readonly roomReqRepo: Repository<RoomBookingRequest>,
    @InjectRepository(Seat) private readonly seatRepo: Repository<Seat>,
    @InjectRepository(Space) private readonly spaceRepo: Repository<Space>,
    private readonly spacesService: SpacesService,
    private readonly configService: SystemConfigService,
  ) {}

  // ===== 搜索 =====

  /**
   * 搜索可预约座位：Seat.isActive && status=available，且该座位在该日期时段无冲突。
   * user.department 用于院系自习室（ownerDept 非空）可见性过滤。
   */
  async searchSeats(query: SearchSeatsQuery, user?: CallerContext): Promise<SearchSeatItem[]> {
    const { spaceId, spaceName, date, startHour, endHour, hasSocket } = query;
    this.assertValidSlot(date, startHour, endHour);

    const qb = this.seatRepo
      .createQueryBuilder('seat')
      .innerJoinAndSelect('seat.space', 'space')
      .where('seat.isActive = :isActive', { isActive: true })
      .andWhere('seat.status = :status', { status: 'available' });
    if (spaceId !== undefined) qb.andWhere('seat.spaceId = :spaceId', { spaceId });
    if (spaceName) qb.andWhere('space.name LIKE :name', { name: `%${spaceName}%` });
    if (hasSocket !== undefined) qb.andWhere('seat.hasSocket = :hasSocket', { hasSocket });

    const seats = await qb.getMany();
    const result: SearchSeatItem[] = [];
    for (const seat of seats) {
      const space = seat.space;
      // 院系自习室：仅当调用者 department === ownerDept 可见（M1-05）
      if (space.ownerDept && user?.department !== space.ownerDept) continue;
      const conflicted = await this.hasConflict(seat.id, space.id, date, startHour, endHour);
      if (conflicted) continue;
      result.push({
        seatId: seat.id,
        seatNo: seat.seatNo,
        hasSocket: seat.hasSocket,
        spaceId: space.id,
        spaceCode: space.code,
        spaceName: space.name,
        spaceType: space.type,
        ownerDept: space.ownerDept,
        openTime: space.openTime,
        closeTime: space.closeTime,
      });
    }
    return result;
  }

  // ===== 预约 =====

  /**
   * 预约座位。校验：时段整点、时长 <= BOOKING_MAX_HOURS（默认 4）、
   * 座位存在且可约、空间开放时间范围、无冲突。成功后创建 status='booked' 记录。
   * M1 个人预约不改变 Seat.status（占用关系由 Reservation 表达）。
   */
  async bookSeat(userId: number, input: BookSeatInput, user?: CallerContext): Promise<Reservation> {
    const { seatId, date, startHour, endHour } = input;
    this.assertValidSlot(date, startHour, endHour);

    const maxHours = await this.configService.getInt('BOOKING_MAX_HOURS', 4);
    if (endHour - startHour > maxHours) {
      throw new BadRequestException(`单次预约时长不能超过 ${maxHours} 小时`);
    }

    const seat = await this.spacesService.findSeatById(seatId); // 不存在抛 404
    if (!seat.isActive || seat.status !== 'available') {
      throw new ConflictException('该座位当前不可预约');
    }

    const space = seat.space;
    // 院系自习室：仅本系可预约
    if (space.ownerDept && user?.department !== space.ownerDept) {
      throw new ForbiddenException('该自习室仅对所属院系开放');
    }

    // 空间开放时间（openTime/closeTime 为 HH:mm 字符串）
    const openHour = this.parseHour(space.openTime);
    const closeHour = this.parseHour(space.closeTime);
    if (startHour < openHour || endHour > closeHour) {
      throw new BadRequestException(`空间开放时间为 ${space.openTime}-${space.closeTime}，预约时段不在开放范围内`);
    }

    if (await this.hasConflict(seatId, space.id, date, startHour, endHour)) {
      throw new ConflictException('该座位在该时段已被预约或整教室占用');
    }

    const resv = this.resvRepo.create({
      userId,
      seatId,
      spaceId: space.id,
      spaceCode: space.code,
      spaceName: space.name,
      seatNo: seat.seatNo,
      date,
      startHour,
      endHour,
      status: 'booked',
    });
    return this.resvRepo.save(resv);
  }

  // ===== 签到 =====

  /** 签到：code 必须与预约座位所在空间的动态码一致；成功置 checked_in + checkInAt */
  async checkIn(userId: number, reservationId: number, code: string): Promise<Reservation> {
    const resv = await this.resvRepo.findOneBy({ id: reservationId, userId });
    if (!resv) throw new NotFoundException('预约不存在');
    if (resv.status !== 'booked') throw new ConflictException('当前状态不可签到');

    const expected = this.getDynamicCode(resv.spaceId, resv.date).code;
    if (code !== expected) throw new BadRequestException('签到码错误');

    resv.status = 'checked_in';
    resv.checkInAt = new Date();
    resv.checkInCode = code;
    return this.resvRepo.save(resv);
  }

  // ===== 查询 =====

  async listMyReservations(userId: number, query: { status?: string } = {}): Promise<Reservation[]> {
    const where: FindOptionsWhere<Reservation> = { userId };
    if (query.status) where.status = query.status as ReservationStatus;
    return this.resvRepo.find({ where, order: { date: 'DESC', startHour: 'DESC', id: 'DESC' } });
  }

  /** 历史预定（completed / no_show / cancelled），分页 */
  async history(userId: number, query: { page?: number } = {}): Promise<{ items: Reservation[]; total: number }> {
    const page = Math.max(1, query.page ?? 1);
    const [items, total] = await this.resvRepo.findAndCount({
      where: { userId, status: In(['completed', 'no_show', 'cancelled']) },
      order: { date: 'DESC', startHour: 'DESC', id: 'DESC' },
      skip: (page - 1) * HISTORY_PAGE_SIZE,
      take: HISTORY_PAGE_SIZE,
    });
    return { items, total };
  }

  // ===== 取消 / 复用 =====

  /** 仅未开始的 booked 可取消 */
  async cancel(userId: number, reservationId: number): Promise<Reservation> {
    const resv = await this.resvRepo.findOneBy({ id: reservationId, userId });
    if (!resv) throw new NotFoundException('预约不存在');
    if (resv.status !== 'booked') throw new ConflictException('仅已预约未开始的记录可取消');
    if (this.slotStartTime(resv.date, resv.startHour).getTime() <= Date.now()) {
      throw new ConflictException('预约已开始，无法取消');
    }
    resv.status = 'cancelled';
    resv.cancelledAt = new Date();
    return this.resvRepo.save(resv);
  }

  /**
   * 历史复用：取原预约的座位/日期/时段重新预约。
   * schema 对 (seatId, date, startHour) 唯一，复用原行重新激活（避免唯一索引冲突），
   * 重新做可约性/冲突/开放时间校验。
   */
  async rebook(userId: number, reservationId: number): Promise<Reservation> {
    const old = await this.resvRepo.findOneBy({ id: reservationId, userId });
    if (!old) throw new NotFoundException('预约不存在');
    if (old.status === 'booked' || old.status === 'checked_in') {
      throw new ConflictException('当前预约仍有效，无需重新预约');
    }

    const { date, startHour, endHour } = old;
    this.assertValidSlot(date, startHour, endHour);

    const maxHours = await this.configService.getInt('BOOKING_MAX_HOURS', 4);
    if (endHour - startHour > maxHours) {
      throw new BadRequestException(`单次预约时长不能超过 ${maxHours} 小时`);
    }

    const seat = await this.spacesService.findSeatById(old.seatId);
    if (!seat.isActive || seat.status !== 'available') {
      throw new ConflictException('该座位当前不可预约');
    }
    const space = seat.space;
    if (startHour < this.parseHour(space.openTime) || endHour > this.parseHour(space.closeTime)) {
      throw new BadRequestException(`空间开放时间为 ${space.openTime}-${space.closeTime}，预约时段不在开放范围内`);
    }
    if (await this.hasConflict(old.seatId, space.id, date, startHour, endHour)) {
      throw new ConflictException('该座位在该时段已被预约或整教室占用');
    }

    old.status = 'booked';
    old.cancelledAt = null;
    old.noShowAt = null;
    old.checkInAt = null;
    old.checkInCode = '';
    old.remindBeforeSent = false;
    old.remindAfterSent = false;
    return this.resvRepo.save(old);
  }

  // ===== 动态码 / 统计 =====

  /**
   * 与教室关联的动态签到码：'A' + spaceId + 日期稳定哈希（4 位数字）。
   * 确定性算法：对 `${spaceId}-${date}` 做字符求和取模 10000。
   * 同空间同日生成同一编码（空间内座位共享码）。
   */
  getDynamicCode(spaceId: number, date: string): { code: string } {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new BadRequestException('日期格式必须为 YYYY-MM-DD');
    }
    const s = `${spaceId}-${date}`;
    let sum = 0;
    for (let i = 0; i < s.length; i++) {
      sum = (sum + s.charCodeAt(i)) % 10000;
    }
    return { code: `A${spaceId}${String(sum % 10000).padStart(4, '0')}` };
  }

  /** 运营统计：按空间统计全部预约数 / no_show 数 / 签到数（M1-11） */
  async stats(): Promise<ReservationStatsRow[]> {
    const spaces = await this.spaceRepo.find({ order: { id: 'ASC' } });
    const rows: ReservationStatsRow[] = [];
    for (const s of spaces) {
      rows.push({
        spaceId: s.id,
        code: s.code,
        name: s.name,
        bookingCount: await this.resvRepo.countBy({ spaceId: s.id }),
        noShowCount: await this.resvRepo.countBy({ spaceId: s.id, status: 'no_show' }),
        checkedInCount: await this.resvRepo.countBy({ spaceId: s.id, status: 'checked_in' }),
      });
    }
    return rows;
  }

  // ===== 内部工具 =====

  /**
   * 冲突检测（searchSeats 与 bookSeat 共用）：
   *   a) Reservation：同 seatId + 同 date + 时段重叠 + status in ('booked','checked_in')
   *   b) RoomBookingRequest（M2 集成读取侧）：同 spaceId + 同 date + 时段重叠 + status='approved'
   */
  private async hasConflict(
    seatId: number,
    spaceId: number,
    date: string,
    startHour: number,
    endHour: number,
  ): Promise<boolean> {
    const resvCount = await this.resvRepo
      .createQueryBuilder('r')
      .where('r.seatId = :seatId', { seatId })
      .andWhere('r.date = :date', { date })
      .andWhere('r.startHour < :endHour', { endHour })
      .andWhere('r.endHour > :startHour', { startHour })
      .andWhere('r.status IN (:...statuses)', { statuses: ACTIVE_RESERVATION_STATUSES })
      .getCount();
    if (resvCount > 0) return true;

    const roomCount = await this.roomReqRepo
      .createQueryBuilder('rb')
      .where('rb.spaceId = :spaceId', { spaceId })
      .andWhere('rb.date = :date', { date })
      .andWhere('rb.startHour < :endHour', { endHour })
      .andWhere('rb.endHour > :startHour', { startHour })
      .andWhere('rb.status = :status', { status: 'approved' })
      .getCount();
    return roomCount > 0;
  }

  /** 校验 date 为 YYYY-MM-DD、startHour/endHour 为整点且 0<=startHour<endHour<=24 */
  private assertValidSlot(date: string, startHour: number, endHour: number): void {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new BadRequestException('日期格式必须为 YYYY-MM-DD');
    }
    if (!Number.isInteger(startHour) || !Number.isInteger(endHour)) {
      throw new BadRequestException('预约时段必须为整点');
    }
    if (startHour < 0 || endHour > 24 || startHour >= endHour) {
      throw new BadRequestException('预约时段不合法');
    }
  }

  /** 解析 HH:mm → 小时数（如 '08:00' → 8） */
  private parseHour(hhmm: string): number {
    const h = Number(hhmm.slice(0, 2));
    return Number.isNaN(h) ? 0 : h;
  }

  /** 预约时段开始时刻（本地时间） */
  private slotStartTime(date: string, hour: number): Date {
    return new Date(`${date}T${String(hour).padStart(2, '0')}:00:00`);
  }
}
