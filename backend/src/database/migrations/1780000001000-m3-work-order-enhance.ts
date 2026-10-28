import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * M3 一期增强：工单事件表 + 返工计数 + 升级标记。
 *
 * 兼容 SQLite（开发，sql.js）与 PostgreSQL（生产）：
 * - 只使用 ADD COLUMN，避免 SQLite 不支持的列变更；
 * - 事件表字段全部为通用类型。
 */
export class M3WorkOrderEnhance1780000001000 implements MigrationInterface {
  name = 'M3WorkOrderEnhance1780000001000';

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

  private now(runner: QueryRunner): string {
    return this.isPg(runner) ? 'DEFAULT NOW()' : "DEFAULT (datetime('now'))";
  }

  /** 布尔默认值：PG 用 false，SQLite 用 0 */
  private boolDefault(runner: QueryRunner): string {
    return this.isPg(runner) ? 'false' : '0';
  }

  public async up(runner: QueryRunner): Promise<void> {
    const id = this.id(runner);
    const dt = this.dt(runner);
    const bool = this.bool(runner);
    const now = this.now(runner);
    const boolDef = this.boolDefault(runner);

    // 1. work_orders 增列（仅加法，不改变已有列语义）
    await runner.query(`ALTER TABLE "work_orders" ADD COLUMN "reopenCount" integer NOT NULL DEFAULT 0`);
    await runner.query(
      `ALTER TABLE "work_orders" ADD COLUMN "escalated" ${bool} NOT NULL DEFAULT ${boolDef}`,
    );

    // 2. 工单事件表（时间线 / 追溯，只追加不修改）
    await runner.query(`CREATE TABLE "work_order_events" (
      "id" ${id},
      "workOrderId" integer NOT NULL,
      "type" varchar NOT NULL,
      "fromStatus" varchar,
      "toStatus" varchar NOT NULL,
      "operatorId" integer,
      "operatorName" varchar NOT NULL DEFAULT '',
      "note" text NOT NULL DEFAULT '',
      "createdAt" ${dt} NOT NULL ${now}
    )`);

    // 3. 索引：时间线按工单查询、列表按状态 + 升级筛选
    await runner.query(
      `CREATE INDEX "IDX_wo_events_workOrderId" ON "work_order_events" ("workOrderId")`,
    );
    await runner.query(`CREATE INDEX "IDX_work_orders_status" ON "work_orders" ("status")`);
    await runner.query(`CREATE INDEX "IDX_work_orders_escalated" ON "work_orders" ("escalated")`);
  }

  public async down(runner: QueryRunner): Promise<void> {
    await runner.query(`DROP INDEX IF EXISTS "IDX_work_orders_escalated"`);
    await runner.query(`DROP INDEX IF EXISTS "IDX_work_orders_status"`);
    await runner.query(`DROP TABLE IF EXISTS "work_order_events"`);

    // 删列：PG 与 SQLite 3.35+ 支持；低版本 SQLite 会抛错，此时保留空列（无害）
    for (const col of ['reopenCount', 'escalated']) {
      try {
        await runner.query(`ALTER TABLE "work_orders" DROP COLUMN "${col}"`);
      } catch {
        // 忽略：低版本 SQLite 不支持 DROP COLUMN
      }
    }
  }
}
