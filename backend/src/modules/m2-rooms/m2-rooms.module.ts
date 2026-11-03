import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RoomBookingRequest } from '../../database/entities/room-booking-request.entity';
import { ApprovalRecord } from '../../database/entities/approval-record.entity';
import { Space } from '../../database/entities/space.entity';
import { RoomRequestsService } from './room-requests.service';
import { RoomRequestsController } from './room-requests.controller';

/**
 * M2 整教室预约与审批模块。
 * - 占用写入走公共层 OccupancyService（SharedModule 为 @Global，无需在此 import）。
 * - 不再注入 Seat 仓库：审批通过不再改写 Seat.status（ADR-0002）。
 */
@Module({
  imports: [TypeOrmModule.forFeature([RoomBookingRequest, ApprovalRecord, Space])],
  controllers: [RoomRequestsController],
  providers: [RoomRequestsService],
  exports: [RoomRequestsService],
})
export class M2RoomsModule {}
