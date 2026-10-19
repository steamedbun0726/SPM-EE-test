import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WorkOrder } from '../../database/entities/work-order.entity';
import { Seat } from '../../database/entities/seat.entity';
import { Space } from '../../database/entities/space.entity';
import { WorkOrdersService } from './work-orders.service';
import { WorkOrdersController } from './work-orders.controller';

/** M3 物业报修工单模块：上报/派单/维修/超时升级/完工验收与评价 */
@Module({
  imports: [TypeOrmModule.forFeature([WorkOrder, Seat, Space])],
  controllers: [WorkOrdersController],
  providers: [WorkOrdersService],
  exports: [WorkOrdersService],
})
export class M3MaintenanceModule {}
