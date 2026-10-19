import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RoomBookingRequest } from '../../database/entities/room-booking-request.entity';
import { ApprovalRecord } from '../../database/entities/approval-record.entity';
import { Seat } from '../../database/entities/seat.entity';
import { Space } from '../../database/entities/space.entity';
import { RoomRequestsService } from './room-requests.service';
import { RoomRequestsController } from './room-requests.controller';

/** M2 整教室预约与审批模块 */
@Module({
  imports: [TypeOrmModule.forFeature([RoomBookingRequest, ApprovalRecord, Seat, Space])],
  controllers: [RoomRequestsController],
  providers: [RoomRequestsService],
  exports: [RoomRequestsService],
})
export class M2RoomsModule {}
