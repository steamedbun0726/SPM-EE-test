import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * ADR-0002：新增时段占用表，把「时段占用」从 Seat.status 中拆出来。
 *
 * 结构变更一律走版本化迁移；本迁移在空库上可一次性重放，在已有库上重复执行安全
 * （使用 IF NOT EXISTS）。
 */
export class M2Occupancy1780000004000 implements MigrationInterface {
  name = 'M2Occupancy1780000004000';

  private isPg(runner: QueryRunner): boolean {
    return (runner.connection.options as { type?: string }).type === 'postgres';
  }

  private id(runner: QueryRunner): string {
    return this.isPg(runner) ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT';
  }

  private dt(runner: QueryRunner): string {
    return this.isPg(runner) ? 'TIMESTAMP' : 'datetime';
  }

  private now(runner: QueryRunner): string {
    return this.isPg(runner) ? 'DEFAULT NOW()' : "DEFAULT (datetime('now'))";
  }

  public async up(runner: QueryRunner): Promise<void> {
    await runner.query(`CREATE TABLE IF NOT EXISTS "occupancies" (
      "id" ${this.id(runner)},
      "scope" varchar NOT NULL DEFAULT 'seat',
      "spaceId" integer NOT NULL,
      "seatId" integer,
      "date" varchar NOT NULL,
      "startHour" integer NOT NULL,
      "endHour" integer NOT NULL,
      "source" varchar NOT NULL,
      "refType" varchar NOT NULL,
      "refId" integer NOT NULL,
      "operatorId" integer,
      "reason" varchar NOT NULL DEFAULT '',
      "releasedAt" ${this.dt(runner)},
      "createdAt" ${this.dt(runner)} NOT NULL ${this.now(runner)}
    )`);

    await runner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_occupancies_space_date" ON "occupancies" ("spaceId","date")`,
    );
    await runner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_occupancies_seat_date" ON "occupancies" ("seatId","date")`,
    );
    await runner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_occupancies_ref" ON "occupancies" ("refType","refId")`,
    );

    // ADR-0003 第 7 节：每级审批最多一条记录，用唯一约束兜底并发。
    // 原型库可能已有重复行，先清理再建索引，保证迁移可重复执行。
    await runner.query(
      `DELETE FROM "approval_records" WHERE "id" NOT IN (
         SELECT MIN("id") FROM "approval_records" GROUP BY "requestId", "level"
       )`,
    );
    await runner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_approval_records_request_level"
         ON "approval_records" ("requestId","level")`,
    );

    // 原型遗留：M2 曾经把座位写成 occupied_by_room（无时间维度，见 ADR-0002）。
    // 该状态在语义上已不存在，回退为 available；真实占用由 occupancies 表达。
    await runner.query(`UPDATE "seats" SET "status" = 'available' WHERE "status" = 'occupied_by_room'`);
  }

  public async down(runner: QueryRunner): Promise<void> {
    await runner.query(`DROP INDEX IF EXISTS "UQ_approval_records_request_level"`);
    await runner.query(`DROP INDEX IF EXISTS "IDX_occupancies_ref"`);
    await runner.query(`DROP INDEX IF EXISTS "IDX_occupancies_seat_date"`);
    await runner.query(`DROP INDEX IF EXISTS "IDX_occupancies_space_date"`);
    await runner.query(`DROP TABLE IF EXISTS "occupancies"`);
  }
}
