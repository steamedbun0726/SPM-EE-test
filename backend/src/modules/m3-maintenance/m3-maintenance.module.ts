import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WorkOrder } from '../../database/entities/work-order.entity';
import { WorkOrderEvent } from '../../database/entities/work-order-event.entity';
import { Seat } from '../../database/entities/seat.entity';
import { Space } from '../../database/entities/space.entity';
import { M1SeatsModule } from '../m1-seats/m1-seats.module';
import { WorkOrdersService } from './work-orders.service';
import { WorkOrdersController } from './work-orders.controller';

/**
 * M3 物业报修工单模块：上报/派单/维修/超时升级/完工验收与评价。
 *
 * 依赖 M1SeatsModule 的原因：座位下架后必须作废该座位上已有的预约，
 * 而预约数据的属主是 M1。跨模块调用只能走 M1 导出的公开 Service 方法
 * （AGENTS.md「模块间不得直接访问对方数据库」），因此显式引入 M1 模块。
 * 依赖方向单向 M3 → M1，不存在循环。
 */
@Module({
  imports: [TypeOrmModule.forFeature([WorkOrder, WorkOrderEvent, Seat, Space]), M1SeatsModule],
  controllers: [WorkOrdersController],
  providers: [WorkOrdersService],
  exports: [WorkOrdersService],
})
export class M3MaintenanceModule {}
