import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';

import { M3MaintenanceModule } from '../src/modules/m3-maintenance/m3-maintenance.module';
import { WorkOrdersService } from '../src/modules/m3-maintenance/work-orders.service';
import { SharedModule } from '../src/shared/shared.module';
import { InitSchema1780000000000 } from '../src/database/migrations/1780000000000-init-schema';
import { M3WorkOrderEnhance1780000001000 } from '../src/database/migrations/1780000001000-m3-work-order-enhance';
import { M3WorkOrderFields1780000002000 } from '../src/database/migrations/1780000002000-m3-work-order-fields';
import { M3HoldMergeStats1780000003000 } from '../src/database/migrations/1780000003000-m3-hold-merge-stats';

import { WorkOrder } from '../src/database/entities/work-order.entity';
import { WorkOrderEvent } from '../src/database/entities/work-order-event.entity';
import { Seat } from '../src/database/entities/seat.entity';
import { Space } from '../src/database/entities/space.entity';
import { SeatStatusLog } from '../src/database/entities/seat-status-log.entity';
import { Notification } from '../src/database/entities/notification.entity';
import { SystemConfig } from '../src/database/entities/system-config.entity';
import { Reservation } from '../src/database/entities/reservation.entity';
import { Violation } from '../src/database/entities/violation.entity';
import { RoomBookingRequest } from '../src/database/entities/room-booking-request.entity';
import { AuditLog } from '../src/database/entities/audit-log.entity';
import { User } from '../src/database/entities/user.entity';
import { Role } from '../src/database/entities/role.entity';
import { Permission } from '../src/database/entities/permission.entity';

/**
 * M3 一期增强集成测试（内存 sqljs）：
 * 覆盖事件时间线、改派、验收返工与上限、SLA 升级处置。
 * 全部断言真实行为，不 mock 被测逻辑。
 */
describe('M3 工单增强（一期）', () => {
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let service: WorkOrdersService;
  let spaceRepo: Repository<Space>;
  let seatRepo: Repository<Seat>;
  let woRepo: Repository<WorkOrder>;
  let eventRepo: Repository<WorkOrderEvent>;
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
            Reservation, Violation, RoomBookingRequest,
            Notification, AuditLog, SystemConfig,
            WorkOrder, WorkOrderEvent,
          ],
          migrations: [InitSchema1780000000000, M3WorkOrderEnhance1780000001000, M3WorkOrderFields1780000002000, M3HoldMergeStats1780000003000],
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
    eventRepo = moduleRef.get(getRepositoryToken(WorkOrderEvent));
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

  it('完整流转产生 5 条时间线事件，类型与状态均正确', async () => {
    const { space } = await createSpaceWithSeats(1);
    const wo = await service.report(1, { title: '灯管损坏', targetType: 'space', spaceId: space.id }, '张三');
    await service.dispatch(wo.id, 99, 1, '管理员');
    await service.startWork(wo.id, 99, '张师傅');
    await service.complete(wo.id, 99, { resolutionNote: '已更换损坏部件并测试通过' }, '张师傅');
    await service.accept(wo.id, 1, { rating: 5 }, '张三');

    const events = await service.listEvents(wo.id);
    expect(events).toHaveLength(5);
    expect(events.map((e) => e.type)).toEqual([
      'reported',
      'dispatched',
      'started',
      'completed',
      'accepted',
    ]);
    expect(events.map((e) => e.toStatus)).toEqual([
      'reported',
      'dispatched',
      'in_progress',
      'completed',
      'accepted',
    ]);
    // 首条事件无前序状态，后续事件的 fromStatus 与前一条 toStatus 衔接
    expect(events[0].fromStatus).toBeNull();
    for (let i = 1; i < events.length; i++) {
      expect(events[i].fromStatus).toBe(events[i - 1].toStatus);
    }
    // 操作人姓名快照落库
    expect(events[0].operatorName).toBe('张三');
    expect(events[2].operatorName).toBe('张师傅');
  });

  it('改派：状态不变、工单号不变、原维修员失去操作权、时间线记录原维修员', async () => {
    const wo = await service.report(1, { title: '门锁损坏', targetType: 'other' });
    await service.dispatch(wo.id, 99, 1);

    const reassigned = await service.reassign(wo.id, 100, 1, '管理员', '99 当天休息');
    expect(reassigned.status).toBe('dispatched');
    expect(reassigned.assigneeId).toBe(100);
    expect(reassigned.workOrderNo).toBe(wo.workOrderNo); // 工单号不变

    // 原维修员不能再开工
    await expect(service.startWork(wo.id, 99)).rejects.toThrow(ForbiddenException);
    // 新维修员可以开工
    const started = await service.startWork(wo.id, 100);
    expect(started.status).toBe('in_progress');

    const events = await service.listEvents(wo.id);
    const reassignEvent = events.find((e) => e.type === 'reassigned');
    expect(reassignEvent).toBeDefined();
    expect(reassignEvent!.note).toContain('99');
    expect(reassignEvent!.note).toContain('100');
    expect(reassignEvent!.note).toContain('99 当天休息');
    // 改派不改变状态：fromStatus 与 toStatus 相同
    expect(reassignEvent!.fromStatus).toBe(reassignEvent!.toStatus);
  });

  it('改派边界：同一维修员拒绝、终态拒绝', async () => {
    const wo = await service.report(1, { title: '插座故障', targetType: 'other' });
    await service.dispatch(wo.id, 99, 1);
    await expect(service.reassign(wo.id, 99, 1)).rejects.toThrow(BadRequestException);

    await service.startWork(wo.id, 99);
    await service.complete(wo.id, 99, { resolutionNote: '已更换损坏部件并测试通过' });
    await expect(service.reassign(wo.id, 100, 1)).rejects.toThrow(ConflictException);
  });

  it('验收不通过：退回维修中、座位保持下架、返工计数 +1', async () => {
    const { space } = await createSpaceWithSeats(2);
    const wo = await service.report(1, { title: '空调故障', targetType: 'space', spaceId: space.id });
    await service.dispatch(wo.id, 99, 1);
    await service.startWork(wo.id, 99);
    await service.complete(wo.id, 99, { resolutionNote: '已更换损坏部件并测试通过' });

    const rejected = await service.accept(wo.id, 1, { result: 'fail', comment: '还是不出风' }, '张三');
    expect(rejected.status).toBe('in_progress');
    expect(rejected.reopenCount).toBe(1);
    expect(rejected.completedAt).toBeNull();
    expect(rejected.rating).toBeNull();

    // 座位必须保持 maintenance（故障未修复不可恢复可约）
    const seats = await seatRepo.findBy({ spaceId: space.id });
    expect(seats.every((s) => s.status === 'maintenance')).toBe(true);

    const events = await service.listEvents(wo.id);
    const rejectedEvent = events.find((e) => e.type === 'rejected');
    expect(rejectedEvent).toBeDefined();
    expect(rejectedEvent!.toStatus).toBe('in_progress');
    expect(rejectedEvent!.note).toBe('还是不出风');

    // 重新完工并验收通过后，座位才恢复
    await service.complete(wo.id, 99, { resolutionNote: '已更换损坏部件并测试通过' });
    const accepted = await service.accept(wo.id, 1, { rating: 4 });
    expect(accepted.status).toBe('accepted');
    expect(accepted.reopenCount).toBe(1);
    const after = await seatRepo.findBy({ spaceId: space.id });
    expect(after.every((s) => s.status === 'available')).toBe(true);
  });

  it('返工次数达到上限后拒绝继续返工', async () => {
    const wo = await service.report(1, { title: '反复故障', targetType: 'other' });
    await service.dispatch(wo.id, 99, 1);

    // 默认上限 3 次
    await service.startWork(wo.id, 99);
    for (let i = 1; i <= 3; i++) {
      await service.complete(wo.id, 99, { resolutionNote: '已更换损坏部件并测试通过' });
      const r = await service.accept(wo.id, 1, { result: 'fail', comment: `第 ${i} 次不通过` });
      expect(r.status).toBe('in_progress'); // 返工后直接回到维修中
      expect(r.reopenCount).toBe(i);
    }

    await service.complete(wo.id, 99, { resolutionNote: '已更换损坏部件并测试通过' });
    await expect(service.accept(wo.id, 1, { result: 'fail' })).rejects.toThrow(ConflictException);

    // 达到上限后仍可通过验收，避免工单永久卡死
    const ok = await service.accept(wo.id, 1, { rating: 3 });
    expect(ok.status).toBe('accepted');
  });

  it('SLA 超时升级：置升级标记、进入升级队列、写事件、通知上报人', async () => {
    const wo = await service.report(1, { title: '水管漏水', targetType: 'other' });
    await woRepo.update(wo.id, { slaDeadline: new Date(Date.now() - 3600_000) });

    const count = await service.escalateOverdue();
    expect(count).toBe(1);

    const after = await woRepo.findOneBy({ id: wo.id });
    expect(after!.escalated).toBe(true);
    expect(after!.escalateLevel).toBe(1);

    const queue = await service.listEscalated();
    expect(queue.map((w) => w.id)).toContain(wo.id);

    const events = await service.listEvents(wo.id);
    expect(events.some((e) => e.type === 'escalated')).toBe(true);

    const notifs = await notifRepo.find();
    expect(notifs).toHaveLength(1);
    expect(notifs[0].title).toBe('工单已升级');
  });

  it('升级标记在被派单或被完工后清除', async () => {
    const w1 = await service.report(1, { title: 'A', targetType: 'other' });
    await woRepo.update(w1.id, { slaDeadline: new Date(Date.now() - 3600_000) });
    await service.escalateOverdue();
    expect((await woRepo.findOneBy({ id: w1.id }))!.escalated).toBe(true);

    // 派单即视为已处理
    const dispatched = await service.dispatch(w1.id, 99, 1);
    expect(dispatched.escalated).toBe(false);
    expect(await service.listEscalated()).toHaveLength(0);

    // 完工也会清除
    await woRepo.update(w1.id, { escalated: true, slaDeadline: new Date(Date.now() - 3600_000) });
    await service.startWork(w1.id, 99);
    const completed = await service.complete(w1.id, 99, { resolutionNote: '已更换损坏部件并测试通过' });
    expect(completed.escalated).toBe(false);
  });

  it('时间线访问控制：非本人、非维修员、无派单权限者不可查看', async () => {
    const wo = await service.report(1, { title: '桌椅损坏', targetType: 'other' });
    await service.dispatch(wo.id, 99, 1);

    // 无关用户
    await expect(service.getStatus(2, wo.id, { permissions: [] })).rejects.toThrow(ForbiddenException);
    // 上报人可看
    await expect(service.getStatus(1, wo.id, { permissions: [] })).resolves.toBeTruthy();
    // 维修员可看
    await expect(service.getStatus(99, wo.id, { permissions: [] })).resolves.toBeTruthy();
    // 有 workorder.dispatch 权限的管理员可看
    await expect(
      service.getStatus(5, wo.id, { permissions: ['workorder.dispatch'] }),
    ).resolves.toBeTruthy();
    // 不存在的工单
    await expect(service.listEvents(9999)).rejects.toThrow(NotFoundException);
  });

  it('取消工单写入时间线并恢复座位', async () => {
    const { space } = await createSpaceWithSeats(2);
    const wo = await service.report(2, { title: '误报', targetType: 'space', spaceId: space.id });
    const cancelled = await service.cancel(wo.id, 2, { reason: '不需要维修了' }, '李四');

    expect(cancelled.status).toBe('cancelled');
    const events = await service.listEvents(wo.id);
    const cancelEvent = events.find((e) => e.type === 'cancelled');
    expect(cancelEvent).toBeDefined();
    expect(cancelEvent!.note).toBe('不需要维修了');

    const seats = await seatRepo.findBy({ spaceId: space.id });
    expect(seats.every((s) => s.status === 'available')).toBe(true);
  });
});
