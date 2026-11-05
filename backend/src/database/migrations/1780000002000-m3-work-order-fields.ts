import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * M3 批次 A：补齐物业报修的业务字段。
 *
 * - seatIds：本次下架的座位清单，保证恢复时精确回滚（部分下架必需）
 * - etaAt：预计恢复时间，用于告知报修人、并展示在 M1 座位卡片上
 * - photoUrls：现场照片（JSON 数组，最多 3 张）
 * - appeal*：维修员申诉与派单员裁决
 * - revisit*：低分自动回访
 * - slaWarned：超时预警是否已发（避免重复提醒）
 * - degradedSuspected：疑似设备老化（同空间同类故障反复发生）
 *
 * 仅使用 ADD COLUMN，兼容 SQLite（sql.js）与 PostgreSQL。
 */
export class M3WorkOrderFields1780000002000 implements MigrationInterface {
  name = 'M3WorkOrderFields1780000002000';

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

    // 座位清单与告知信息
    await runner.query(`ALTER TABLE "work_orders" ADD COLUMN "seatIds" text NOT NULL DEFAULT ''`);
    await runner.query(`ALTER TABLE "work_orders" ADD COLUMN "etaAt" ${dt}`);
    await runner.query(`ALTER TABLE "work_orders" ADD COLUMN "photoUrls" text NOT NULL DEFAULT ''`);

    // 双时限：首响时限（slaDeadline 为解决时限，已在上一迁移中存在）
    await runner.query(`ALTER TABLE "work_orders" ADD COLUMN "responseDeadline" ${dt}`);

    // 维修员申诉与裁决
    await runner.query(`ALTER TABLE "work_orders" ADD COLUMN "appealReason" text NOT NULL DEFAULT ''`);
    await runner.query(`ALTER TABLE "work_orders" ADD COLUMN "appealAt" ${dt}`);
    await runner.query(`ALTER TABLE "work_orders" ADD COLUMN "appealResult" varchar`);
    await runner.query(`ALTER TABLE "work_orders" ADD COLUMN "appealHandledBy" integer`);
    await runner.query(`ALTER TABLE "work_orders" ADD COLUMN "appealHandledAt" ${dt}`);

    // 低分回访
    await runner.query(
      `ALTER TABLE "work_orders" ADD COLUMN "revisitRequired" ${bool} NOT NULL DEFAULT ${boolDef}`,
    );
    await runner.query(
      `ALTER TABLE "work_orders" ADD COLUMN "revisitHandled" ${bool} NOT NULL DEFAULT ${boolDef}`,
    );

    // 超时预警、疑似设备老化
    await runner.query(
      `ALTER TABLE "work_orders" ADD COLUMN "slaWarned" ${bool} NOT NULL DEFAULT ${boolDef}`,
    );
    await runner.query(
      `ALTER TABLE "work_orders" ADD COLUMN "degradedSuspected" ${bool} NOT NULL DEFAULT ${boolDef}`,
    );

    // 管理视图查询：按空间+分类找重复故障、按类别统计
    await runner.query(
      `CREATE INDEX "IDX_work_orders_space_category" ON "work_orders" ("spaceId", "category")`,
    );
    await runner.query(
      `CREATE INDEX "IDX_work_orders_revisit" ON "work_orders" ("revisitRequired")`,
    );
  }

  public async down(runner: QueryRunner): Promise<void> {
    await runner.query(`DROP INDEX IF EXISTS "IDX_work_orders_revisit"`);
    await runner.query(`DROP INDEX IF EXISTS "IDX_work_orders_space_category"`);

    const columns = [
      'seatIds',
      'etaAt',
      'photoUrls',
      'responseDeadline',
      'appealReason',
      'appealAt',
      'appealResult',
      'appealHandledBy',
      'appealHandledAt',
      'revisitRequired',
      'revisitHandled',
      'slaWarned',
      'degradedSuspected',
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
