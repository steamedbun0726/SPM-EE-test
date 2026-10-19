import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 初始 schema：兼容 SQLite（开发，sql.js）与 PostgreSQL（生产）。
 * 禁止手工改库；后续结构变更一律新增版本化迁移脚本。
 */
export class InitSchema1780000000000 implements MigrationInterface {
  name = 'InitSchema1780000000000';

  private isPg(runner: QueryRunner): boolean {
    return (runner.connection.options as { type?: string }).type === 'postgres';
  }

  private id(runner: QueryRunner): string {
    return this.isPg(runner) ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT';
  }

  private dt(runner: QueryRunner): string {
    return this.isPg(runner) ? 'TIMESTAMP' : 'datetime';
  }

  private bool(runner: QueryRunner): string {
    return this.isPg(runner) ? 'BOOLEAN' : 'boolean';
  }

  private json(runner: QueryRunner): string {
    return this.isPg(runner) ? 'json' : 'text';
  }

  private now(runner: QueryRunner): string {
    return this.isPg(runner) ? "DEFAULT NOW()" : "DEFAULT (datetime('now'))";
  }

  public async up(runner: QueryRunner): Promise<void> {
    const id = this.id(runner);
    const dt = this.dt(runner);
    const bool = this.bool(runner);
    const json = this.json(runner);
    const now = this.now(runner);

    const createdAt = `"createdAt" ${dt} NOT NULL ${now}`;
    const updatedAt = `"updatedAt" ${dt} NOT NULL ${now}`;

    await runner.query(`CREATE TABLE "permissions" (
      "id" ${id}, "code" varchar NOT NULL UNIQUE, "name" varchar NOT NULL,
      "description" varchar NOT NULL DEFAULT '', ${createdAt}
    )`);
    await runner.query(`CREATE TABLE "roles" (
      "id" ${id}, "code" varchar NOT NULL UNIQUE, "name" varchar NOT NULL,
      "description" varchar NOT NULL DEFAULT '', ${createdAt}
    )`);
    await runner.query(`CREATE TABLE "role_permissions" (
      "rolesId" integer NOT NULL, "permissionsId" integer NOT NULL
    )`);
    await runner.query(`CREATE INDEX "IDX_role_permissions_roles" ON "role_permissions" ("rolesId")`);
    await runner.query(`CREATE INDEX "IDX_role_permissions_perms" ON "role_permissions" ("permissionsId")`);

    await runner.query(`CREATE TABLE "users" (
      "id" ${id}, "username" varchar NOT NULL UNIQUE, "passwordHash" varchar NOT NULL,
      "name" varchar NOT NULL, "email" varchar NOT NULL DEFAULT '', "phone" varchar NOT NULL DEFAULT '',
      "department" varchar NOT NULL DEFAULT '', "isActive" ${bool} NOT NULL DEFAULT 1,
      ${createdAt}, ${updatedAt}
    )`);
    await runner.query(`CREATE TABLE "user_roles" (
      "usersId" integer NOT NULL, "rolesId" integer NOT NULL
    )`);
    await runner.query(`CREATE INDEX "IDX_user_roles_users" ON "user_roles" ("usersId")`);
    await runner.query(`CREATE INDEX "IDX_user_roles_roles" ON "user_roles" ("rolesId")`);

    await runner.query(`CREATE TABLE "spaces" (
      "id" ${id}, "code" varchar NOT NULL UNIQUE, "name" varchar NOT NULL,
      "type" varchar NOT NULL DEFAULT 'study', "ownerDept" varchar NOT NULL DEFAULT '',
      "openTime" varchar NOT NULL DEFAULT '08:00', "closeTime" varchar NOT NULL DEFAULT '22:00',
      "isActive" ${bool} NOT NULL DEFAULT 1, "description" varchar NOT NULL DEFAULT '',
      ${createdAt}, ${updatedAt}
    )`);

    await runner.query(`CREATE TABLE "seats" (
      "id" ${id}, "spaceId" integer NOT NULL, "seatNo" varchar NOT NULL,
      "hasSocket" ${bool} NOT NULL DEFAULT 0, "isActive" ${bool} NOT NULL DEFAULT 1,
      "status" varchar NOT NULL DEFAULT 'available', "statusSource" varchar,
      "lastStatusAt" ${dt}, ${createdAt}, ${updatedAt}
    )`);
    await runner.query(`CREATE INDEX "IDX_seats_spaceId" ON "seats" ("spaceId")`);
    await runner.query(`CREATE UNIQUE INDEX "IDX_seats_space_seatNo" ON "seats" ("spaceId","seatNo")`);

    await runner.query(`CREATE TABLE "seat_status_logs" (
      "id" ${id}, "seatId" integer NOT NULL, "spaceId" integer NOT NULL,
      "seatNo" varchar NOT NULL DEFAULT '', "fromStatus" varchar NOT NULL,
      "toStatus" varchar NOT NULL, "source" varchar NOT NULL,
      "refType" varchar NOT NULL DEFAULT '', "refId" integer, "reason" varchar NOT NULL DEFAULT '',
      "operatorId" integer, ${createdAt}
    )`);
    await runner.query(`CREATE INDEX "IDX_seat_status_logs_seatId" ON "seat_status_logs" ("seatId")`);

    await runner.query(`CREATE TABLE "reservations" (
      "id" ${id}, "userId" integer NOT NULL, "seatId" integer NOT NULL,
      "spaceId" integer NOT NULL, "spaceCode" varchar NOT NULL, "spaceName" varchar NOT NULL,
      "seatNo" varchar NOT NULL, "date" varchar NOT NULL, "startHour" integer NOT NULL,
      "endHour" integer NOT NULL, "status" varchar NOT NULL DEFAULT 'booked',
      "checkInCode" varchar NOT NULL DEFAULT '', "checkInAt" ${dt},
      "remindBeforeSent" ${bool} NOT NULL DEFAULT 0, "remindAfterSent" ${bool} NOT NULL DEFAULT 0,
      "cancelledAt" ${dt}, "noShowAt" ${dt}, ${createdAt}, ${updatedAt}
    )`);
    await runner.query(`CREATE INDEX "IDX_reservations_userId" ON "reservations" ("userId")`);
    await runner.query(`CREATE INDEX "IDX_reservations_seatId" ON "reservations" ("seatId")`);
    await runner.query(`CREATE INDEX "IDX_reservations_date" ON "reservations" ("date")`);
    await runner.query(`CREATE UNIQUE INDEX "IDX_reservations_seat_slot" ON "reservations" ("seatId","date","startHour")`);

    await runner.query(`CREATE TABLE "violations" (
      "id" ${id}, "userId" integer NOT NULL, "reservationId" integer,
      "type" varchar NOT NULL DEFAULT 'no_show', "reason" varchar NOT NULL DEFAULT '',
      ${createdAt}
    )`);
    await runner.query(`CREATE INDEX "IDX_violations_userId" ON "violations" ("userId")`);

    await runner.query(`CREATE TABLE "room_booking_requests" (
      "id" ${id}, "requestCode" varchar NOT NULL UNIQUE, "requesterId" integer NOT NULL,
      "spaceId" integer NOT NULL, "spaceCode" varchar NOT NULL, "spaceName" varchar NOT NULL,
      "date" varchar NOT NULL, "startHour" integer NOT NULL, "endHour" integer NOT NULL,
      "purpose" varchar NOT NULL DEFAULT '', "status" varchar NOT NULL DEFAULT 'pending',
      "currentLevel" integer NOT NULL DEFAULT 1, "maxLevel" integer NOT NULL DEFAULT 2,
      "timeoutAt" ${dt}, "occupiedSeatIds" ${json}, "rejectReason" varchar NOT NULL DEFAULT '',
      "decidedAt" ${dt}, ${createdAt}, ${updatedAt}
    )`);
    await runner.query(`CREATE INDEX "IDX_room_requests_requester" ON "room_booking_requests" ("requesterId")`);
    await runner.query(`CREATE INDEX "IDX_room_requests_space" ON "room_booking_requests" ("spaceId")`);

    await runner.query(`CREATE TABLE "approval_records" (
      "id" ${id}, "requestId" integer NOT NULL, "approverId" integer NOT NULL,
      "approverName" varchar NOT NULL, "level" integer NOT NULL,
      "action" varchar NOT NULL, "comment" varchar NOT NULL DEFAULT '',
      ${createdAt}
    )`);
    await runner.query(`CREATE INDEX "IDX_approval_records_request" ON "approval_records" ("requestId")`);

    await runner.query(`CREATE TABLE "work_orders" (
      "id" ${id}, "workOrderNo" varchar NOT NULL UNIQUE, "reporterId" integer NOT NULL,
      "title" varchar NOT NULL, "description" text NOT NULL DEFAULT '', "category" varchar NOT NULL DEFAULT 'other',
      "priority" varchar NOT NULL DEFAULT 'medium', "targetType" varchar NOT NULL DEFAULT 'space',
      "targetId" integer, "spaceId" integer, "status" varchar NOT NULL DEFAULT 'reported',
      "assigneeId" integer, "escalateLevel" integer NOT NULL DEFAULT 0, "slaDeadline" ${dt},
      "dispatchedAt" ${dt}, "inProgressAt" ${dt}, "completedAt" ${dt}, "acceptedAt" ${dt},
      "rating" integer, "ratingComment" varchar NOT NULL DEFAULT '', "cancelReason" varchar NOT NULL DEFAULT '',
      ${createdAt}, ${updatedAt}
    )`);
    await runner.query(`CREATE INDEX "IDX_work_orders_reporter" ON "work_orders" ("reporterId")`);
    await runner.query(`CREATE INDEX "IDX_work_orders_space" ON "work_orders" ("spaceId")`);

    await runner.query(`CREATE TABLE "notifications" (
      "id" ${id}, "userId" integer NOT NULL, "type" varchar NOT NULL DEFAULT 'system',
      "title" varchar NOT NULL, "content" text NOT NULL DEFAULT '',
      "isRead" ${bool} NOT NULL DEFAULT 0, ${createdAt}
    )`);
    await runner.query(`CREATE INDEX "IDX_notifications_userId" ON "notifications" ("userId")`);

    await runner.query(`CREATE TABLE "audit_logs" (
      "id" ${id}, "userId" integer, "username" varchar NOT NULL DEFAULT '',
      "action" varchar NOT NULL, "resourceType" varchar NOT NULL DEFAULT '',
      "resourceId" varchar NOT NULL DEFAULT '', "detail" text NOT NULL DEFAULT '',
      "ip" varchar NOT NULL DEFAULT '', ${createdAt}
    )`);
    await runner.query(`CREATE INDEX "IDX_audit_logs_userId" ON "audit_logs" ("userId")`);

    await runner.query(`CREATE TABLE "system_configs" (
      "id" ${id}, "key" varchar NOT NULL UNIQUE, "value" varchar NOT NULL DEFAULT '',
      "description" varchar NOT NULL DEFAULT '', ${createdAt}, ${updatedAt}
    )`);
  }

  public async down(runner: QueryRunner): Promise<void> {
    const tables = [
      'system_configs', 'audit_logs', 'notifications', 'work_orders', 'approval_records',
      'room_booking_requests', 'violations', 'reservations', 'seat_status_logs', 'seats',
      'spaces', 'user_roles', 'users', 'role_permissions', 'roles', 'permissions',
    ];
    for (const t of tables) {
      await runner.query(`DROP TABLE IF EXISTS "${t}"`);
    }
  }
}
