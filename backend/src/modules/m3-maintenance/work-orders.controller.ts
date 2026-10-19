import { Body, Controller, Get, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import { IsInt, IsNumber, IsOptional, IsString, Max, Min } from 'class-validator';
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

class AcceptDto {
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
    return this.workOrdersService.report(user.userId, dto);
  }

  @Post(':id/dispatch')
  @Permissions('workorder.dispatch')
  dispatch(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: JwtUser, @Body() dto: DispatchDto) {
    return this.workOrdersService.dispatch(id, dto.assigneeId, user.userId);
  }

  @Post(':id/start')
  start(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: JwtUser) {
    return this.workOrdersService.startWork(id, user.userId);
  }

  @Post(':id/complete')
  complete(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: JwtUser) {
    return this.workOrdersService.complete(id, user.userId);
  }

  @Post(':id/accept')
  accept(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: JwtUser, @Body() dto: AcceptDto) {
    return this.workOrdersService.accept(id, user.userId, { rating: dto.rating, comment: dto.comment });
  }

  @Post(':id/cancel')
  cancel(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: JwtUser, @Body() dto: CancelDto) {
    return this.workOrdersService.cancel(id, user.userId, { reason: dto.reason });
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

  @Get('assignments')
  assignments(@CurrentUser() user: JwtUser) {
    return this.workOrdersService.listAssignments(user.userId);
  }

  @Get(':id')
  status(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: JwtUser) {
    return this.workOrdersService.getStatus(user.userId, id, user);
  }
}
