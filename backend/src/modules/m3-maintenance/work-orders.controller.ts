import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { WorkOrdersService, ReportWorkOrderInput, WorkOrderListSort } from './work-orders.service';
import { Permissions } from '../../common/decorators/permissions.decorator';
import { CurrentUser, JwtUser } from '../../common/decorators/current-user.decorator';
import { WorkOrderPriority, WorkOrderStatus } from '../../database/entities/work-order.entity';

/** 查询串转整数：非法值直接 400，避免把 'abc' 当 undefined 静默忽略 */
function toInt(raw: string | undefined, field: string): number | undefined {
  if (raw == null || raw === '') return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value)) throw new BadRequestException(`${field} 必须为整数`);
  return value;
}

class ReportWorkOrderDto implements ReportWorkOrderInput {
  @IsString() title: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsString() category?: string;
  @IsOptional() @IsString() priority?: 'low' | 'medium' | 'high' | 'urgent';
  @IsString() targetType: 'space' | 'seat' | 'other';
  @IsOptional() @IsNumber() targetId?: number;
  @IsOptional() @IsNumber() spaceId?: number;
  /** 部分下架：仅下架这些座位 */
  @IsOptional() @IsArray() @IsInt({ each: true }) seatIds?: number[];
  /** 现场照片，最多 3 张（服务端二次校验） */
  @IsOptional() @IsArray() @IsString({ each: true }) @ArrayMaxSize(3) photoUrls?: string[];
  /** 预计恢复时间（ISO 字符串） */
  @IsOptional() @IsString() etaAt?: string;
  /** 合并到主线工单（M3-15）：同目标已存在未完结工单时，用户确认后带上此 id 重提 */
  @IsOptional() @IsInt() mergeIntoId?: number;
}

class DispatchDto {
  @IsInt() assigneeId: number;
}

class ReassignDto {
  @IsInt() assigneeId: number;
  @IsOptional() @IsString() reason?: string;
}

/** 完工：维修说明必填（M3-17），服务层复核，DTO 层不给空串放行 */
class CompleteDto {
  @IsString() resolutionNote: string;
  @IsOptional() @IsArray() @IsString({ each: true }) @ArrayMaxSize(3) photoUrls?: string[];
}

class HoldDto {
  @IsString() reason: string;
}

class HoldConfirmDto {
  @IsIn([true, false]) approve: boolean;
  @IsOptional() @IsString() note?: string;
}

class MergeDto {
  /** 主线工单 id */
  @IsInt() intoId: number;
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

class CommentDto {
  @IsString() content: string;
}

class EtaDto {
  @IsString() etaAt: string;
}

class PhotosDto {
  @IsArray() @IsString({ each: true }) @ArrayMaxSize(3) photoUrls: string[];
}

class AppealDto {
  @IsString() reason: string;
}

class ResolveAppealDto {
  @IsIn(['upheld', 'overturned']) result: 'upheld' | 'overturned';
  @IsOptional() @IsString() note?: string;
}

class RevisitDto {
  @IsString() note: string;
}

@Controller('m3/work-orders')
export class WorkOrdersController {
  constructor(private readonly workOrdersService: WorkOrdersService) {}

  // ===== 字典（必须声明在 :id 之前） =====

  /** 分类/优先级/状态字典与各项限制（M3-31）：前端选择器唯一数据源 */
  @Get('meta')
  meta() {
    return this.workOrdersService.meta();
  }

  // ===== 上报与流转 =====

  @Post()
  @Permissions('workorder.report')
  async report(@CurrentUser() user: JwtUser, @Body() dto: ReportWorkOrderDto) {
    return this.workOrdersService.toView(await this.workOrdersService.report(user.userId, dto, user.name));
  }

  @Post(':id/dispatch')
  @Permissions('workorder.dispatch')
  async dispatch(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: JwtUser,
    @Body() dto: DispatchDto,
  ) {
    return this.workOrdersService.toView(
      await this.workOrdersService.dispatch(id, dto.assigneeId, user.userId, user.name),
    );
  }

  /** 改派：派错维修员时使用，工单号与状态不变（M3-09） */
  @Post(':id/reassign')
  @Permissions('workorder.dispatch')
  async reassign(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: JwtUser,
    @Body() dto: ReassignDto,
  ) {
    return this.workOrdersService.toView(
      await this.workOrdersService.reassign(id, dto.assigneeId, user.userId, user.name, dto.reason),
    );
  }

  @Post(':id/start')
  @Permissions('workorder.handle')
  async start(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: JwtUser) {
    return this.workOrdersService.toView(await this.workOrdersService.startWork(id, user.userId, user.name));
  }

  /** 完工：维修说明必填（M3-17），可选补传现场照片 */
  @Post(':id/complete')
  @Permissions('workorder.handle')
  async complete(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: JwtUser,
    @Body() dto: CompleteDto,
  ) {
    return this.workOrdersService.toView(
      await this.workOrdersService.complete(
        id,
        user.userId,
        { resolutionNote: dto.resolutionNote, photoUrls: dto.photoUrls },
        user.name,
      ),
    );
  }

  // ===== 挂起与合并（M3-14 / M3-15） =====

  /** 维修员申请挂起：此时状态与 SLA 都不变，等派单员确认 */
  @Post(':id/hold')
  @Permissions('workorder.handle')
  async hold(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: JwtUser,
    @Body() dto: HoldDto,
  ) {
    return this.workOrdersService.toView(
      await this.workOrdersService.requestHold(id, user.userId, dto.reason, user.name),
    );
  }

  /** 派单员确认/驳回挂起：确认后状态置 on_hold，SLA 暂停计时 */
  @Post(':id/hold/confirm')
  @Permissions('workorder.dispatch')
  async confirmHold(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: JwtUser,
    @Body() dto: HoldConfirmDto,
  ) {
    return this.workOrdersService.toView(
      await this.workOrdersService.confirmHold(id, user.userId, dto.approve, user.name, dto.note),
    );
  }

  /** 恢复维修：状态回到挂起前，两个时限按挂起时长顺延 */
  @Post(':id/resume')
  async resume(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: JwtUser) {
    return this.workOrdersService.toView(
      await this.workOrdersService.resumeFromHold(id, user.userId, user.name, user.permissions),
    );
  }

  /** 事后合并：把本单并入主线工单，座位恢复责任随之转移 */
  @Post(':id/merge')
  async merge(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: JwtUser,
    @Body() dto: MergeDto,
  ) {
    return this.workOrdersService.toView(
      await this.workOrdersService.mergeInto(id, dto.intoId, user.userId, user.name, user.permissions),
    );
  }

  /** 验收：默认通过；result=fail 时退回维修中返工（M3-10） */
  @Post(':id/accept')
  @Permissions('workorder.accept')
  async accept(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: JwtUser,
    @Body() dto: AcceptDto,
  ) {
    return this.workOrdersService.toView(
      await this.workOrdersService.accept(
        id,
        user.userId,
        { result: dto.result, rating: dto.rating, comment: dto.comment },
        user.name,
      ),
    );
  }

  @Post(':id/cancel')
  async cancel(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: JwtUser,
    @Body() dto: CancelDto,
  ) {
    return this.workOrdersService.toView(
      await this.workOrdersService.cancel(id, user.userId, { reason: dto.reason }, user.name),
    );
  }

  // ===== 协作（留言 / ETA / 照片 / 申诉） =====

  /** 工单留言（M3-20）：上报人、维修员、派单员均可，进入时间线 */
  @Post(':id/comments')
  comment(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: JwtUser,
    @Body() dto: CommentDto,
  ) {
    return this.workOrdersService.addComment(id, user.userId, dto.content, user.name, user.permissions);
  }

  /** 更新预计恢复时间（M3-21）并通知上报人 */
  @Patch(':id/eta')
  async eta(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: JwtUser,
    @Body() dto: EtaDto,
  ) {
    return this.workOrdersService.toView(
      await this.workOrdersService.updateEta(id, user.userId, dto.etaAt, user.name, user.permissions),
    );
  }

  /** 补传现场照片（M3-28）：最多 3 张，协议白名单校验 */
  @Patch(':id/photos')
  async photos(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: JwtUser,
    @Body() dto: PhotosDto,
  ) {
    return this.workOrdersService.toView(
      await this.workOrdersService.updatePhotos(id, user.userId, dto.photoUrls, user.name, user.permissions),
    );
  }

  /** 维修员申诉（M3-22）：仅返工中的工单、仅指派维修员可提 */
  @Post(':id/appeal')
  @Permissions('workorder.handle')
  async appeal(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: JwtUser,
    @Body() dto: AppealDto,
  ) {
    return this.workOrdersService.toView(
      await this.workOrdersService.appeal(id, user.userId, dto.reason, user.name),
    );
  }

  /** 申诉裁决（M3-22）：派单/管理员终裁，不是报修人自己复议 */
  @Post(':id/appeal/resolve')
  @Permissions('workorder.manage')
  async resolveAppeal(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: JwtUser,
    @Body() dto: ResolveAppealDto,
  ) {
    return this.workOrdersService.toView(
      await this.workOrdersService.resolveAppeal(id, user.userId, dto.result, user.name, dto.note),
    );
  }

  /** 低分回访处置（M3-27） */
  @Post(':id/revisit')
  @Permissions('workorder.manage')
  async revisit(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: JwtUser,
    @Body() dto: RevisitDto,
  ) {
    return this.workOrdersService.toView(
      await this.workOrdersService.handleRevisit(id, user.userId, dto.note, user.name),
    );
  }

  // ===== 查询 =====

  /**
   * 工单台账（M3-16）：多条件组合筛选 + 分页 + 关键字搜索。
   *
   * 覆盖此前三个列表接口的局限：`/mine` 只有 status、`/pending` 与 `/assignments`
   * 既无筛选也不分页，工单量一上来就只能一次性拉全量、也无法按空间和时间排查。
   *
   * 页码越界（如 999）返回空列表而非报错——台账每天要翻，操作太快或书签里的旧页码
   * 越界是常态；非法/非正页码按第 1 页处理。
   */
  @Get()
  @Permissions('workorder.dispatch', 'workorder.manage', 'workorder.stats')
  listAll(
    @Query('status') status?: string,
    @Query('category') category?: string,
    @Query('priority') priority?: string,
    @Query('spaceId') spaceId?: string,
    @Query('assigneeId') assigneeId?: string,
    @Query('reporterId') reporterId?: string,
    @Query('escalated') escalated?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('keyword') keyword?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('sort') sort?: string,
  ) {
    return this.workOrdersService.listAll({
      status,
      category,
      priority: priority as WorkOrderPriority | undefined,
      spaceId: toInt(spaceId, 'spaceId'),
      assigneeId: toInt(assigneeId, 'assigneeId'),
      reporterId: toInt(reporterId, 'reporterId'),
      escalated: escalated == null || escalated === '' ? undefined : escalated === 'true',
      from,
      to,
      keyword,
      page: toInt(page, 'page'),
      pageSize: toInt(pageSize, 'pageSize'),
      sort: sort as WorkOrderListSort | undefined,
    });
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

  /** 低分回访待处理（M3-27） */
  @Get('revisits')
  @Permissions('workorder.manage')
  revisits() {
    return this.workOrdersService.listRevisits();
  }

  /** 疑似设备老化清单（M3-25） */
  @Get('degraded')
  @Permissions('workorder.dispatch')
  degraded() {
    return this.workOrdersService.listDegraded();
  }

  /** 挂起总览（M3-14）：待确认的挂起申请 + 正在挂起的工单 */
  @Get('holds')
  @Permissions('workorder.dispatch')
  holds() {
    return this.workOrdersService.listHoldOverview();
  }

  @Get('assignments')
  assignments(@CurrentUser() user: JwtUser) {
    return this.workOrdersService.listAssignments(user.userId);
  }

  /** 维修员负载与技能画像（M3-26）：派单参考 */
  @Get('technicians')
  @Permissions('workorder.stats')
  technicians() {
    return this.workOrdersService.technicianWorkload();
  }

  /**
   * 工单统计看板（M3-18）。
   * 默认统计近 30 天；返回体自带 definitions 说明每个指标的分母口径。
   */
  @Get('stats')
  @Permissions('workorder.stats')
  stats(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('spaceId') spaceId?: string,
  ) {
    const parsedSpaceId = spaceId != null && spaceId !== '' ? Number(spaceId) : undefined;
    if (parsedSpaceId != null && !Number.isInteger(parsedSpaceId)) {
      throw new BadRequestException('spaceId 必须为整数');
    }
    return this.workOrdersService.stats({ from, to, spaceId: parsedSpaceId });
  }

  @Get(':id')
  detail(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: JwtUser) {
    return this.workOrdersService.getDetail(user.userId, id, user);
  }

  /** 工单时间线（M3-08）：访问控制与详情一致 */
  @Get(':id/events')
  async events(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: JwtUser) {
    await this.workOrdersService.getStatus(user.userId, id, user); // 先做访问控制
    return this.workOrdersService.listEvents(id);
  }
}
