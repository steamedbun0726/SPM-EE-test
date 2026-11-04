import { Body, Controller, Get, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import { IsInt, IsOptional, IsString, Matches, Max, Min } from 'class-validator';
import { RoomRequestsService, ReviewerContext } from './room-requests.service';
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
  @Min(1)
  @Max(24)
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

/** 从 JWT 载荷构造审批人上下文，Service 不依赖 HTTP 层 */
function reviewerOf(user: JwtUser): ReviewerContext {
  return { userId: user.userId, name: user.name, permissions: user.permissions };
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

  /** 提交前冲突预检（不落库），前端用于提前提示 */
  @Post('preflight')
  @Permissions('room.apply')
  preflight(@Body() dto: ApplyRoomRequestDto) {
    return this.roomRequestsService.preflight(dto);
  }

  /** 审批通过（M2-03）。真正校验第几级权限在 Service 内按 currentLevel 判断 */
  @Post(':id/approve')
  @Permissions('room.approve.l1', 'room.approve.l2')
  approve(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ReviewDto,
    @CurrentUser() user: JwtUser,
  ) {
    return this.roomRequestsService.approve(id, reviewerOf(user), { comment: dto?.comment });
  }

  /** 审批驳回（M2-03） */
  @Post(':id/reject')
  @Permissions('room.approve.l1', 'room.approve.l2')
  reject(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ReviewDto,
    @CurrentUser() user: JwtUser,
  ) {
    return this.roomRequestsService.reject(id, reviewerOf(user), { comment: dto?.comment || '' });
  }

  /** 申请人撤销（本人） */
  @Post(':id/cancel')
  cancel(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: JwtUser) {
    return this.roomRequestsService.cancel(user.userId, id);
  }

  /** 我的申请 */
  @Get('mine')
  listMine(@CurrentUser() user: JwtUser, @Query('status') status?: string) {
    return this.roomRequestsService.listMine(
      user.userId,
      status ? { status: status as RoomRequestStatus } : {},
    );
  }

  /** 审批队列（按权限层级过滤） */
  @Get('pending')
  @Permissions('room.approve.l1', 'room.approve.l2')
  listPending(@CurrentUser() user: JwtUser) {
    return this.roomRequestsService.listPending(reviewerOf(user));
  }

  /** 申请状态（本人或审批人，含审批记录与占用） */
  @Get(':id')
  getStatus(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: JwtUser) {
    return this.roomRequestsService.getStatus(user.userId, user.permissions, id);
  }

  /** 审批记录（本人或审批人） */
  @Get(':id/approvals')
  getApprovals(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: JwtUser) {
    return this.roomRequestsService.getApprovals(user.userId, user.permissions, id);
  }
}
