import { Body, Controller, Get, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import { IsIn, IsInt, IsNumber, IsOptional, IsString, Max, Min } from 'class-validator';
import { WorkOrdersService, ReportWorkOrderInput } from './work-orders.service';
import { Permissions } from '../../common/decorators/permissions.decorator';
import { CurrentUser, JwtUser } from '../../common/decorators/current-user.decorator';
import { WorkOrderStatus } from '../../database/entities/work-order.entity';

class ReportWorkOrderDto implements ReportWorkOrderInput {
  @IsString() title: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsString() category?: string;
  @IsOptional() @IsString() priority?: 'low' | 'medium' | 'high' | 'urgent';
  @IsString() targetType: 'space' | 'seat' | 'other';
  @IsOptional() @IsNumber() targetId?: number;
  @IsOptional() @IsNumber() spaceId?: number;
}

class DispatchDto {
  @IsInt() assigneeId: number;
}

class ReassignDto {
  @IsInt() assigneeId: number;
  @IsOptional() @IsString() reason?: string;
}

class AcceptDto {
  /** pass=通过（默认） fail=不通过，退回返工 */
  @IsOptional() @IsIn(['pass', 'fail']) result?: 'pass' | 'fail';
  @IsOptional() @IsNumber() @Min(1) @Max(5) rating?: number;
  @IsOptional() @IsString() comment?: string;
}

class CancelDto {
  @IsOptional() @IsString() reason?: string;
}

@Controller('m3/work-orders')
export class WorkOrdersController {
  constructor(private readonly workOrdersService: WorkOrdersService) {}

  @Post()
  @Permissions('workorder.report')
  report(@CurrentUser() user: JwtUser, @Body() dto: ReportWorkOrderDto) {
    return this.workOrdersService.report(user.userId, dto, user.name);
  }

  @Post(':id/dispatch')
  @Permissions('workorder.dispatch')
  dispatch(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: JwtUser,
    @Body() dto: DispatchDto,
  ) {
    return this.workOrdersService.dispatch(id, dto.assigneeId, user.userId, user.name);
  }

  /** 改派：派错维修员时使用，工单号与状态不变（M3-09） */
  @Post(':id/reassign')
  @Permissions('workorder.dispatch')
  reassign(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: JwtUser,
    @Body() dto: ReassignDto,
  ) {
    return this.workOrdersService.reassign(id, dto.assigneeId, user.userId, user.name, dto.reason);
  }

  @Post(':id/start')
  @Permissions('workorder.handle')
  start(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: JwtUser) {
    return this.workOrdersService.startWork(id, user.userId, user.name);
  }

  @Post(':id/complete')
  @Permissions('workorder.handle')
  complete(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: JwtUser) {
    return this.workOrdersService.complete(id, user.userId, user.name);
  }

  /** 验收：默认通过；result=fail 时退回维修中返工（M3-10） */
  @Post(':id/accept')
  @Permissions('workorder.accept')
  accept(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: JwtUser,
    @Body() dto: AcceptDto,
  ) {
    return this.workOrdersService.accept(
      id,
      user.userId,
      { result: dto.result, rating: dto.rating, comment: dto.comment },
      user.name,
    );
  }

  @Post(':id/cancel')
  cancel(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: JwtUser,
    @Body() dto: CancelDto,
  ) {
    return this.workOrdersService.cancel(id, user.userId, { reason: dto.reason }, user.name);
  }

  @Get('mine')
  mine(@CurrentUser() user: JwtUser, @Query('status') status?: WorkOrderStatus) {
    return this.workOrdersService.listMine(user.userId, status ? { status } : {});
  }

  @Get('pending')
  @Permissions('workorder.dispatch')
  pending() {
    return this.workOrdersService.listPending();
  }

  /** 升级待处理队列（M3-12）：SLA 超时且未被处理的工单 */
  @Get('escalated')
  @Permissions('workorder.dispatch')
  escalated() {
    return this.workOrdersService.listEscalated();
  }

  @Get('assignments')
  assignments(@CurrentUser() user: JwtUser) {
    return this.workOrdersService.listAssignments(user.userId);
  }

  @Get(':id')
  status(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: JwtUser) {
    return this.workOrdersService.getStatus(user.userId, id, user);
  }

  /** 工单时间线（M3-08）：访问控制与详情一致 */
  @Get(':id/events')
  async events(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: JwtUser) {
    await this.workOrdersService.getStatus(user.userId, id, user); // 先做访问控制
    return this.workOrdersService.listEvents(id);
  }
}
