import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';

import { SharedModule } from '../src/shared/shared.module';
import { NotificationsService } from '../src/shared/notifications/notifications.service';
import { AuditService } from '../src/shared/audit/audit.service';

import { InitSchema1780000000000 } from '../src/database/migrations/1780000000000-init-schema';
import { M3WorkOrderEnhance1780000001000 } from '../src/database/migrations/1780000001000-m3-work-order-enhance';
import { M3WorkOrderFields1780000002000 } from '../src/database/migrations/1780000002000-m3-work-order-fields';
import { M3HoldMergeStats1780000003000 } from '../src/database/migrations/1780000003000-m3-hold-merge-stats';

import { Notification } from '../src/database/entities/notification.entity';
import { AuditLog } from '../src/database/entities/audit-log.entity';
import { User } from '../src/database/entities/user.entity';
import { Role } from '../src/database/entities/role.entity';
import { Permission } from '../src/database/entities/permission.entity';
import { Space } from '../src/database/entities/space.entity';
import { Seat } from '../src/database/entities/seat.entity';
import { SeatStatusLog } from '../src/database/entities/seat-status-log.entity';
import { Reservation } from '../src/database/entities/reservation.entity';
import { Violation } from '../src/database/entities/violation.entity';
import { RoomBookingRequest } from '../src/database/entities/room-booking-request.entity';
import { ApprovalRecord } from '../src/database/entities/approval-record.entity';
import { SystemConfig } from '../src/database/entities/system-config.entity';
import { WorkOrder } from '../src/database/entities/work-order.entity';
import { WorkOrderEvent } from '../src/database/entities/work-order-event.entity';

/**
 * D4 / D5 契约测试（ADR-0004 §4.2：owner 需交付至少一条消费方可通过的契约测试）。
 *
 * 断言对象是 `docs/contracts/d4-notification.md` 与 `d5-audit.md` 里承诺的行为，
 * 不复制实现细节。期望值尽量用仓储另一条查询路径另算后比对。
 */
describe('D4/D5 公共层契约', () => {
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let notif: NotificationsService;
  let audit: AuditService;
  let notifRepo: Repository<Notification>;
  let auditRepo: Repository<AuditLog>;

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
            Reservation, Violation, RoomBookingRequest, ApprovalRecord,
            Notification, AuditLog, SystemConfig,
            WorkOrder, WorkOrderEvent,
          ],
          migrations: [
            InitSchema1780000000000,
            M3WorkOrderEnhance1780000001000,
            M3WorkOrderFields1780000002000,
            M3HoldMergeStats1780000003000,
          ],
        }),
        SharedModule,
      ],
    }).compile();

    dataSource = moduleRef.get(DataSource);
    notif = moduleRef.get(NotificationsService);
    audit = moduleRef.get(AuditService);
    notifRepo = moduleRef.get(getRepositoryToken(Notification));
    auditRepo = moduleRef.get(getRepositoryToken(AuditLog));
  });

  afterAll(async () => {
    await dataSource?.destroy();
    await moduleRef?.close();
  });

  describe('D4 通知服务', () => {
    it('send 落库并返回带 id 的实体，未读为 false', async () => {
      const created = await notif.send(101, 'workorder', '派单通知', '工单 WO-1 已派给你');

      expect(created.id).toBeGreaterThan(0);
      const rows = await notifRepo.find({ where: { userId: 101 } });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        type: 'workorder',
        title: '派单通知',
        content: '工单 WO-1 已派给你',
        isRead: false,
      });
      expect(rows[0].createdAt).toBeInstanceOf(Date);
    });

    it('sendBatch 给每个 userId 各生成一条，空数组返回 0 且不落库', async () => {
      const before = await notifRepo.count();

      const count = await notif.sendBatch([201, 202, 203], 'workorder', '批量提醒', '同一段内容');
      expect(count).toBe(3);

      const rows = await notifRepo.find({ where: { userId: In([201, 202, 203]) } });
      expect(rows).toHaveLength(3);
      expect(new Set(rows.map((r) => r.userId))).toEqual(new Set([201, 202, 203]));
      expect(rows.every((r) => r.content === '同一段内容' && r.type === 'workorder')).toBe(true);

      const zero = await notif.sendBatch([], 'system', '空批次', '不应落库');
      expect(zero).toBe(0);
      expect(await notifRepo.count()).toBe(before + 3);
    });

    it('listForUser 只返回本人通知，按 id 倒序，unreadOnly 过滤已读', async () => {
      await notif.send(301, 'system', '第一条', 'a');
      await notif.send(301, 'system', '第二条', 'b');
      await notif.send(301, 'system', '第三条', 'c');
      await notif.send(399, 'system', '别人的', '不属于 301');

      const all = await notif.listForUser(301);
      expect(all.map((n) => n.title)).toEqual(['第三条', '第二条', '第一条']);
      expect(all.every((n) => n.userId === 301)).toBe(true);

      const middle = all.find((n) => n.title === '第二条')!;
      await notif.markRead(middle.id, 301);

      const unread = await notif.listForUser(301, true);
      expect(unread.map((n) => n.title)).toEqual(['第三条', '第一条']);
    });

    it('markRead 对他人的通知不生效，但也不报错、不泄露存在性', async () => {
      await notif.send(401, 'system', '给 401 的通知', '内容');
      const [target] = await notif.listForUser(401);

      const result = await notif.markRead(target.id, 402);
      expect(result).toEqual({ ok: true });

      const after = await notifRepo.findOneByOrFail({ id: target.id });
      expect(after.isRead).toBe(false);
      expect(after.userId).toBe(401);
    });

    it('markAllRead 只清当前用户，不波及他人', async () => {
      await notif.send(501, 'system', 'A', 'x');
      await notif.send(501, 'system', 'B', 'y');
      await notif.send(502, 'system', 'C', 'z');

      await notif.markAllRead(501);

      expect(await notif.unreadCount(501)).toBe(0);
      expect(await notif.unreadCount(502)).toBe(1);
    });

    it('unreadCount 与数据库中的实际未读数一致', async () => {
      await notif.send(601, 'approval', 'N1', '');
      await notif.send(601, 'approval', 'N2', '');
      await notif.send(601, 'approval', 'N3', '');

      const mine = await notif.listForUser(601);
      await notif.markRead(mine[0].id, 601);

      const dbCount = await notifRepo.countBy({ userId: 601, isRead: false });
      expect(dbCount).toBe(2);
      expect(await notif.unreadCount(601)).toBe(dbCount);
    });
  });

  describe('D5 操作审计', () => {
    const baseInput = {
      userId: 7,
      username: 'k',
      action: 'POST /api/work-orders/12/dispatch',
      resourceType: 'work-orders',
      resourceId: '12',
      detail: '{"assigneeId":99,"note":"紧急"}',
      ip: '127.0.0.1',
    };

    beforeEach(async () => {
      await auditRepo.clear();
    });

    it('record 原样落库并返回带 id 与 createdAt 的记录', async () => {
      const created = await audit.record(baseInput);
      expect(created.id).toBeGreaterThan(0);

      const row = await auditRepo.findOneByOrFail({ id: created.id });
      expect(row).toMatchObject(baseInput);
      expect(row.createdAt).toBeInstanceOf(Date);
    });

    it('findAll 的 total 是全量、items 是当前页，按 id 倒序', async () => {
      for (let i = 1; i <= 25; i++) {
        await audit.record({ ...baseInput, resourceId: String(i), detail: `第 ${i} 条` });
      }

      const page1 = await audit.findAll({ page: 1, pageSize: 10 });
      expect(page1.total).toBe(25);
      expect(page1.items).toHaveLength(10);
      expect(page1.items[0].detail).toBe('第 25 条');

      const page3 = await audit.findAll({ page: 3, pageSize: 10 });
      expect(page3.total).toBe(25);
      expect(page3.items).toHaveLength(5);
      expect(page3.items[4].detail).toBe('第 1 条');
    });

    it('keyword 可命中 username / action / detail 三列', async () => {
      await audit.record({ ...baseInput, username: 'alice', action: 'POST /api/rooms', detail: 'alpha' });
      await audit.record({ ...baseInput, username: 'bob', action: 'PATCH /api/rooms/9', detail: 'beta' });
      await audit.record({ ...baseInput, username: 'carol', action: 'DELETE /api/seats/3', detail: 'gamma' });

      const byUser = await audit.findAll({ keyword: 'alice' });
      const byAction = await audit.findAll({ keyword: 'PATCH' });
      const byDetail = await audit.findAll({ keyword: 'gamma' });

      expect(byUser.total).toBe(1);
      expect(byUser.items[0].username).toBe('alice');

      expect(byAction.total).toBe(1);
      expect(byAction.items[0].username).toBe('bob');

      expect(byDetail.total).toBe(1);
      expect(byDetail.items[0].username).toBe('carol');
    });

    it('findAll 不传分页参数时默认 page=1 / pageSize=20', async () => {
      for (let i = 1; i <= 25; i++) {
        await audit.record({ ...baseInput, resourceId: String(i) });
      }

      const result = await audit.findAll({});
      expect(result.total).toBe(25);
      expect(result.items).toHaveLength(20);
    });

    it('record 不幂等：同一 action 重复调用产生两条独立记录', async () => {
      const first = await audit.record(baseInput);
      const second = await audit.record(baseInput);

      expect(second.id).not.toBe(first.id);
      expect(await auditRepo.count()).toBe(2);
    });
  });
});
