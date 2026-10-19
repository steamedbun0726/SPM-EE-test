import { Body, Controller, Get, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import { IsInt, IsOptional, IsString, Matches, Max, Min } from 'class-validator';
import { RoomRequestsService } from './room-requests.service';
import { Permissions } from '../../common/decorators/permissions.decorator';
import { CurrentUser, JwtUser } from '../../common/decorators/current-user.decorator';
import { RoomRequestStatus } from '../../database/entities/room-booking-request.entity';

class ApplyRoomRequestDto {
  @IsInt()
  spaceId: number;

  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'date 需为 YYYY-MM-DD 格式' })
  date: string;

  @IsInt()
  @Min(0)
  @Max(23)
  startHour: number;

  @IsInt()
  @Min(0)
  @Max(23)
  endHour: number;

  @IsOptional()
  @IsString()
  purpose?: string;
}

class ReviewDto {
  @IsOptional()
  @IsString()
  comment?: string;
}

@Controller('m2/requests')
export class RoomRequestsController {
  constructor(private readonly roomRequestsService: RoomRequestsService) {}

  /** 提交整教室预约申请（M2-02） */
  @Post()
  @Permissions('room.apply')
  apply(@Body() dto: ApplyRoomRequestDto, @CurrentUser() user: JwtUser) {
    return this.roomRequestsService.apply(user.userId, dto);
  }

  /** 审批通过（多级审批，M2-03） */
  @Post(':id/approve')
  @Permissions('room.approve')
  approve(@Param('id', ParseIntPipe) id: number, @Body() dto: ReviewDto, @CurrentUser() user: JwtUser) {
    return this.roomRequestsService.approve(id, user.userId, {
      comment: dto?.comment,
      approverName: user.name,
    });
  }

  /** 审批驳回（M2-03） */
  @Post(':id/reject')
  @Permissions('room.approve')
  reject(@Param('id', ParseIntPipe) id: number, @Body() dto: ReviewDto, @CurrentUser() user: JwtUser) {
    return this.roomRequestsService.reject(id, user.userId, {
      comment: dto?.comment || '',
      approverName: user.name,
    });
  }

  /** 申请人撤销（本人） */
  @Post(':id/cancel')
  cancel(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: JwtUser) {
    return this.roomRequestsService.cancel(user.userId, id);
  }

  /** 我的申请 */
  @Get('mine')
  listMine(@CurrentUser() user: JwtUser, @Query('status') status?: string) {
    return this.roomRequestsService.listMine(user.userId, status ? { status: status as RoomRequestStatus } : {});
  }

  /** 审批队列（待审批） */
  @Get('pending')
  @Permissions('room.approve')
  listPending() {
    return this.roomRequestsService.listPending();
  }

  /** 申请状态（本人或审批人，含审批记录） */
  @Get(':id')
  getStatus(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: JwtUser) {
    return this.roomRequestsService.getStatus(user.userId, id, user.permissions.includes('room.approve'));
  }

  /** 审批记录 */
  @Get(':id/approvals')
  getApprovals(@Param('id', ParseIntPipe) id: number) {
    return this.roomRequestsService.getApprovals(id);
  }
}
