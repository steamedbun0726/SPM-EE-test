import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * M3 批次 B：挂起（M3-14）、重复工单合并（M3-15）、维修记录（M3-17）与统计口径字段（M3-18）。
 *
 * - hold* / onHoldSince / preHoldStatus / totalHoldMinutes：挂起两级确认 + SLA 暂停计时
 * - holdEscalated：挂起超期只告警一次
 * - mergedIntoId / mergedCount：合并关系与主线吸收数
 * - resolutionNote：完工必填的维修说明
 * - firstRespondedAt：首响时长计算终点（不能用 inProgressAt 顶替，返工后 inProgressAt 会被重写）
 * - originalSlaDeadline：原始解决时限。slaDeadline 会在每次升级时被推后，
 *   直接用它算 SLA 达标率会系统性偏高，故单独留一份不变值供统计使用。
 *
 * 仅使用 ADD COLUMN，兼容 SQLite（sql.js）与 PostgreSQL；不使用外键与 DEFAULT 表达式。
 */
export class M3HoldMergeStats1780000003000 implements MigrationInterface {
  name = 'M3HoldMergeStats1780000003000';

  private isPg(runner: QueryRunner): boolean {
    return (runner.connection.options as { type?: string }).type === 'postgres';
  }

  private dt(runner: QueryRunner): string {
    return this.isPg(runner) ? 'TIMESTAMP' : 'datetime';
  }

  private bool(runner: QueryRunner): string {
    return this.isPg(runner) ? 'BOOLEAN' : 'boolean';
  }

  private boolDef(runner: QueryRunner): string {
    return this.isPg(runner) ? 'false' : '0';
  }

  public async up(runner: QueryRunner): Promise<void> {
    const dt = this.dt(runner);
    const bool = this.bool(runner);
    const boolDef = this.boolDef(runner);

    // 首响与统计口径
    await runner.query(`ALTER TABLE "work_orders" ADD COLUMN "firstRespondedAt" ${dt}`);
    await runner.query(`ALTER TABLE "work_orders" ADD COLUMN "originalSlaDeadline" ${dt}`);

    // 挂起
    await runner.query(`ALTER TABLE "work_orders" ADD COLUMN "holdReason" text NOT NULL DEFAULT ''`);
    await runner.query(
      `ALTER TABLE "work_orders" ADD COLUMN "holdRequested" ${bool} NOT NULL DEFAULT ${boolDef}`,
    );
    await runner.query(`ALTER TABLE "work_orders" ADD COLUMN "holdRequestedAt" ${dt}`);
    await runner.query(`ALTER TABLE "work_orders" ADD COLUMN "holdRequestedBy" integer`);
    await runner.query(`ALTER TABLE "work_orders" ADD COLUMN "onHoldSince" ${dt}`);
    await runner.query(`ALTER TABLE "work_orders" ADD COLUMN "preHoldStatus" varchar NOT NULL DEFAULT ''`);
    await runner.query(`ALTER TABLE "work_orders" ADD COLUMN "totalHoldMinutes" integer NOT NULL DEFAULT 0`);
    await runner.query(
      `ALTER TABLE "work_orders" ADD COLUMN "holdEscalated" ${bool} NOT NULL DEFAULT ${boolDef}`,
    );

    // 合并
    await runner.query(`ALTER TABLE "work_orders" ADD COLUMN "mergedIntoId" integer`);
    await runner.query(`ALTER TABLE "work_orders" ADD COLUMN "mergedCount" integer NOT NULL DEFAULT 0`);

    // 维修记录
    await runner.query(`ALTER TABLE "work_orders" ADD COLUMN "resolutionNote" text NOT NULL DEFAULT ''`);

    // 合并溯源：按主线反查被合并单
    await runner.query(
      `CREATE INDEX "IDX_work_orders_merged_into" ON "work_orders" ("mergedIntoId")`,
    );
    // 统计看板按创建时间做区间扫描
    await runner.query(`CREATE INDEX "IDX_work_orders_created_at" ON "work_orders" ("createdAt")`);
  }

  public async down(runner: QueryRunner): Promise<void> {
    await runner.query(`DROP INDEX IF EXISTS "IDX_work_orders_created_at"`);
    await runner.query(`DROP INDEX IF EXISTS "IDX_work_orders_merged_into"`);

    const columns = [
      'firstRespondedAt',
      'originalSlaDeadline',
      'holdReason',
      'holdRequested',
      'holdRequestedAt',
      'holdRequestedBy',
      'onHoldSince',
      'preHoldStatus',
      'totalHoldMinutes',
      'holdEscalated',
      'mergedIntoId',
      'mergedCount',
      'resolutionNote',
    ];
    for (const col of columns) {
      try {
        await runner.query(`ALTER TABLE "work_orders" DROP COLUMN "${col}"`);
      } catch {
        // 低版本 SQLite 不支持 DROP COLUMN，保留空列（无害）
      }
    }
  }
}
