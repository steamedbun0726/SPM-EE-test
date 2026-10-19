import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Reservation } from '../../database/entities/reservation.entity';
import { Violation } from '../../database/entities/violation.entity';
import { Seat } from '../../database/entities/seat.entity';
import { Space } from '../../database/entities/space.entity';
import { RoomBookingRequest } from '../../database/entities/room-booking-request.entity';
import { ReservationsService } from './reservations.service';
import { ReservationsController } from './reservations.controller';

/**
 * M1 自习座位预约模块。
 * - 引入 Reservation / Violation / Seat / Space / RoomBookingRequest
 *   （RoomBookingRequest 用于读取 M2 审批结果做冲突检测，见契约）。
 * - SharedModule 为 @Global，SpacesService / SystemConfigService 等可直接注入。
 * - 导出 ReservationsService 供调度器、Agent 与测试使用。
 */
@Module({
  imports: [TypeOrmModule.forFeature([Reservation, Violation, Seat, Space, RoomBookingRequest])],
  providers: [ReservationsService],
  controllers: [ReservationsController],
  exports: [ReservationsService],
})
export class M1SeatsModule {}
