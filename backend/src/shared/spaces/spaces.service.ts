import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Like, Repository } from 'typeorm';
import { Space, SpaceType } from '../../database/entities/space.entity';
import { Seat } from '../../database/entities/seat.entity';
import { Reservation } from '../../database/entities/reservation.entity';
import { SeatStateService } from './seat-state.service';

@Injectable()
export class SpacesService {
  constructor(
    @InjectRepository(Space) private readonly spaceRepo: Repository<Space>,
    @InjectRepository(Seat) private readonly seatRepo: Repository<Seat>,
    @InjectRepository(Reservation) private readonly resvRepo: Repository<Reservation>,
    private readonly seatStateService: SeatStateService,
  ) {}

  async findAll(params: { keyword?: string; type?: SpaceType; isActive?: string }) {
    const where: Record<string, unknown> = {};
    if (params.keyword) where.name = Like(`%${params.keyword}%`);
    if (params.type) where.type = params.type;
    if (params.isActive !== undefined) where.isActive = params.isActive === 'true';
    const spaces = await this.spaceRepo.find({ where, order: { id: 'ASC' } });
    const result: Array<Space & { seatCount: number }> = [];
    for (const s of spaces) {
      const seatCount = await this.seatRepo.countBy({ spaceId: s.id });
      result.push({ ...s, seatCount });
    }
    return result;
  }

  async findById(id: number): Promise<Space> {
    const space = await this.spaceRepo.findOneBy({ id });
    if (!space) throw new NotFoundException(`空间 ${id} 不存在`);
    return space;
  }

  async findByCode(code: string): Promise<Space | null> {
    return this.spaceRepo.findOneBy({ code });
  }

  async create(data: {
    code: string;
    name: string;
    type?: SpaceType;
    ownerDept?: string;
    openTime?: string;
    closeTime?: string;
    description?: string;
  }): Promise<Space> {
    const exists = await this.spaceRepo.findOneBy({ code: data.code });
    if (exists) throw new ConflictException(`空间编码 ${data.code} 已存在`);
    const space = this.spaceRepo.create({
      code: data.code,
      name: data.name,
      type: data.type || 'study',
      ownerDept: data.ownerDept || '',
      openTime: data.openTime || '08:00',
      closeTime: data.closeTime || '22:00',
      description: data.description || '',
    });
    return this.spaceRepo.save(space);
  }

  async update(id: number, data: Partial<Space>): Promise<Space> {
    const space = await this.findById(id);
    Object.assign(space, data);
    return this.spaceRepo.save(space);
  }

  /** 注销空间（软删除：置为不可用，座位同步失效） */
  async remove(id: number): Promise<void> {
    const space = await this.findById(id);
    space.isActive = false;
    await this.spaceRepo.save(space);
    await this.seatRepo.update({ spaceId: id }, { isActive: false });
  }

  // ===== 座位管理 =====

  async listSeats(spaceId: number) {
    return this.seatRepo.find({ where: { spaceId }, order: { seatNo: 'ASC' } });
  }

  async createSeat(spaceId: number, data: { seatNo: string; hasSocket?: boolean }) {
    const space = await this.findById(spaceId);
    const dup = await this.seatRepo.findOneBy({ spaceId, seatNo: data.seatNo });
    if (dup) throw new ConflictException(`座位号 ${data.seatNo} 已存在`);
    const seat = this.seatRepo.create({
      spaceId,
      seatNo: data.seatNo,
      hasSocket: data.hasSocket || false,
      status: 'available',
      statusSource: 'SYSTEM',
      space: space,
    });
    return this.seatRepo.save(seat);
  }

  async updateSeat(seatId: number, data: Partial<{ seatNo: string; hasSocket: boolean; isActive: boolean }>) {
    const seat = await this.seatRepo.findOneBy({ id: seatId });
    if (!seat) throw new NotFoundException(`座位 ${seatId} 不存在`);
    Object.assign(seat, data);
    return this.seatRepo.save(seat);
  }

  async findSeatById(seatId: number): Promise<Seat> {
    const seat = await this.seatRepo.findOne({ where: { id: seatId }, relations: ['space'] });
    if (!seat) throw new NotFoundException(`座位 ${seatId} 不存在`);
    return seat;
  }

  /** 座位状态历史（写入来源追溯） */
  seatHistory(seatId: number, limit?: number) {
    return this.seatStateService.history(seatId, limit);
  }

  // ===== 运营统计 =====

  async occupancyStats() {
    const spaces = await this.spaceRepo.find({ order: { id: 'ASC' } });
    const rows: Array<{
      spaceId: number;
      code: string;
      name: string;
      totalSeats: number;
      activeSeats: number;
      maintenanceSeats: number;
      occupiedByRoom: number;
      bookedNow: number;
    }> = [];
    for (const s of spaces) {
      const totalSeats = await this.seatRepo.countBy({ spaceId: s.id });
      const activeSeats = await this.seatRepo.countBy({ spaceId: s.id, isActive: true });
      const bookedNow = await this.resvRepo.countBy({
        spaceId: s.id,
        status: 'booked',
      });
      const maintenanceSeats = await this.seatRepo.countBy({ spaceId: s.id, status: 'maintenance' });
      const occupiedByRoom = await this.seatRepo.countBy({ spaceId: s.id, status: 'occupied_by_room' });
      rows.push({
        spaceId: s.id,
        code: s.code,
        name: s.name,
        totalSeats,
        activeSeats,
        maintenanceSeats,
        occupiedByRoom,
        bookedNow,
      });
    }
    return rows;
  }
}
