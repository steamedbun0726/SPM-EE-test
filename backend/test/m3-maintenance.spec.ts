import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';

import { M3MaintenanceModule } from '../src/modules/m3-maintenance/m3-maintenance.module';
import { WorkOrdersService } from '../src/modules/m3-maintenance/work-orders.service';
import { SharedModule } from '../src/shared/shared.module';
import { InitSchema1780000000000 } from '../src/database/migrations/1780000000000-init-schema';

import { WorkOrder } from '../src/database/entities/work-order.entity';
import { Seat } from '../src/database/entities/seat.entity';
import { Space } from '../src/database/entities/space.entity';
import { SeatStatusLog } from '../src/database/entities/seat-status-log.entity';
import { Notification } from '../src/database/entities/notification.entity';
import { SystemConfig } from '../src/database/entities/system-config.entity';
import { Reservation } from '../src/database/entities/reservation.entity';
import { AuditLog } from '../src/database/entities/audit-log.entity';
import { User } from '../src/database/entities/user.entity';
import { Role } from '../src/database/entities/role.entity';
import { Permission } from '../src/database/entities/permission.entity';

/**
 * M3 物业报修工单集成测试（内存 sqljs 库）：
 * 覆盖 下架/恢复（M3→M1 集成）、派单流转、超时升级、取消恢复。
 */
describe('M3 物业报修工单', () => {
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let service: WorkOrdersService;
  let spaceRepo: Repository<Space>;
  let seatRepo: Repository<Seat>;
  let woRepo: Repository<WorkOrder>;
  let notifRepo: Repository<Notification>;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot({
          type: 'sqljs',
          autoSave: false,
          migrationsRun: true,
          entities: [
            User, Role, Permission,
            Space, Seat, SeatStatusLog,
            Reservation, Notification, AuditLog, SystemConfig,
            WorkOrder,
          ],
          migrations: [InitSchema1780000000000],
        }),
        SharedModule,
        M3MaintenanceModule,
      ],
    }).compile();

    dataSource = moduleRef.get(DataSource);
    service = moduleRef.get(WorkOrdersService);
    spaceRepo = moduleRef.get(getRepositoryToken(Space));
    seatRepo = moduleRef.get(getRepositoryToken(Seat));
    woRepo = moduleRef.get(getRepositoryToken(WorkOrder));
    notifRepo = moduleRef.get(getRepositoryToken(Notification));
  });

  beforeEach(async () => {
    await dataSource.synchronize(true);
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  async function createSpaceWithSeats(n = 2): Promise<{ space: Space; seats: Seat[] }> {
    const space = await spaceRepo.save(
      spaceRepo.create({ code: `T-${Date.now()}-${Math.floor(Math.random() * 1e6)}`, name: '测试自习室' }),
    );
    const seats: Seat[] = [];
    for (let i = 1; i <= n; i++) {
      seats.push(await seatRepo.save(seatRepo.create({ spaceId: space.id, seatNo: `S${i}` })));
    }
    return { space, seats };
  }

  it('上报 space 工单后该室座位全部下架（maintenance/M3），派单-开工-完工-验收后恢复', async () => {
    const { space, seats } = await createSpaceWithSeats(2);
    const wo = await service.report(1, {
      title: '灯管损坏',
      description: '灯管闪烁',
      priority: 'high',
      targetType: 'space',
      spaceId: space.id,
    });

    // 工单初始状态与编号
    expect(wo.status).toBe('reported');
    expect(wo.workOrderNo).toMatch(/^WO-\d{8}-\d{3}$/);
    expect(wo.workOrderNo.endsWith('001')).toBe(true);
    expect(wo.escalateLevel).toBe(0);
    expect(wo.slaDeadline!.getTime()).toBeGreaterThan(Date.now() + 47 * 3600_000); // 默认 48h SLA

    // M3 → M1：座位下架，写入来源 M3
    const down = await seatRepo.findBy({ spaceId: space.id });
    expect(down).toHaveLength(2);
    for (const s of down) {
      expect(s.status).toBe('maintenance');
      expect(s.statusSource).toBe('M3');
    }

    // 派单流转
    const dispatched = await service.dispatch(wo.id, 99, 1);
    expect(dispatched.status).toBe('dispatched');
    expect(dispatched.assigneeId).toBe(99);
    expect(dispatched.dispatchedAt).toBeTruthy();

    const started = await service.startWork(wo.id, 99);
    expect(started.status).toBe('in_progress');
    expect(started.inProgressAt).toBeTruthy();

    const completed = await service.complete(wo.id, 99);
    expect(completed.status).toBe('completed');
    expect(completed.completedAt).toBeTruthy();

    // 维修中座位仍下架
    const mid = await seatRepo.findBy({ spaceId: space.id });
    expect(mid.every((s) => s.status === 'maintenance')).toBe(true);

    // 验收 + 评价
    const accepted = await service.accept(wo.id, 1, { rating: 5, comment: '修好了' });
    expect(accepted.status).toBe('accepted');
    expect(accepted.acceptedAt).toBeTruthy();
    expect(accepted.rating).toBe(5);
    expect(accepted.ratingComment).toBe('修好了');

    // M3 → M1：验收后座位恢复 available
    const up = await seatRepo.findBy({ spaceId: space.id });
    for (const s of up) {
      expect(s.status).toBe('available');
      expect(s.statusSource).toBe('M3');
    }
  });

  it('escalateOverdue 仅升级 SLA 超时的未完工工单并通知上报人', async () => {
    const wo = await service.report(1, { title: '空调故障', targetType: 'other' });
    // 模拟 SLA 超时
    await woRepo.update(wo.id, { slaDeadline: new Date(Date.now() - 3600_000) });

    const count = await service.escalateOverdue();
    expect(count).toBe(1);

    const after = await woRepo.findOneBy({ id: wo.id });
    expect(after!.escalateLevel).toBe(1);
    expect(after!.slaDeadline!.getTime()).toBeGreaterThan(Date.now() + 23 * 3600_000); // 升级后重设 24h

    const notifs = await notifRepo.find();
    expect(notifs).toHaveLength(1);
    expect(notifs[0].type).toBe('workorder');
    expect(notifs[0].title).toBe('工单已升级');
    expect(notifs[0].userId).toBe(1);

    // 未超时工单不升级
    const wo2 = await service.report(1, { title: '门锁故障', targetType: 'other' });
    expect(await service.escalateOverdue()).toBe(0);
    const wo2After = await woRepo.findOneBy({ id: wo2.id });
    expect(wo2After!.escalateLevel).toBe(0);
  });

  it('取消 space 工单后座位恢复 available 并记录取消原因', async () => {
    const { space } = await createSpaceWithSeats(3);
    const wo = await service.report(2, { title: '桌椅损坏', targetType: 'space', spaceId: space.id });

    const down = await seatRepo.findBy({ spaceId: space.id });
    expect(down.every((s) => s.status === 'maintenance')).toBe(true);

    const cancelled = await service.cancel(wo.id, 2, { reason: '不需要维修了' });
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.cancelReason).toBe('不需要维修了');

    const up = await seatRepo.findBy({ spaceId: space.id });
    for (const s of up) expect(s.status).toBe('available');
  });

  it('身份与状态机校验：非维修员不可开工、非上报人不可验收、非法流转被拒', async () => {
    const wo = await service.report(1, { title: '插座故障', targetType: 'other' });
    await service.dispatch(wo.id, 99, 1);

    // 非指派维修员不可开工
    await expect(service.startWork(wo.id, 100)).rejects.toThrow(ForbiddenException);
    // 已派单不可重复派单
    await expect(service.dispatch(wo.id, 99, 1)).rejects.toThrow(ConflictException);

    // reported 状态未派单：无维修员身份，不可开工
    const wo2 = await service.report(1, { title: '门锁损坏', targetType: 'other' });
    await expect(service.startWork(wo2.id, 1)).rejects.toThrow(ForbiddenException);
    // 已派单但未开工：不可直接完工（状态机校验）
    await service.dispatch(wo2.id, 99, 1);
    await expect(service.complete(wo2.id, 99)).rejects.toThrow(ConflictException);

    // 完整流转后验收：非上报人 Forbidden；评分越界 BadRequest
    await service.startWork(wo.id, 99);
    await service.complete(wo.id, 99);
    await expect(service.accept(wo.id, 2)).rejects.toThrow(ForbiddenException);
    await expect(service.accept(wo.id, 1, { rating: 9 })).rejects.toThrow(BadRequestException);

    const accepted = await service.accept(wo.id, 1, { rating: 4 });
    expect(accepted.status).toBe('accepted');
    // 已验收不可重复验收
    await expect(service.accept(wo.id, 1)).rejects.toThrow(ConflictException);
    // 已验收不可取消
    await expect(service.cancel(wo.id, 1, { reason: 'x' })).rejects.toThrow(ConflictException);
  });
});
