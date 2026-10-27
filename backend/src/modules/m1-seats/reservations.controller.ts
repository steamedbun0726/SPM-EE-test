import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
} from '@nestjs/common';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, IsString } from 'class-validator';
import { ReservationsService } from './reservations.service';
import { Permissions } from '../../common/decorators/permissions.decorator';
import { CurrentUser, JwtUser } from '../../common/decorators/current-user.decorator';

class SearchSeatsDto {
  @IsOptional() @Type(() => Number) @IsInt() spaceId?: number;
  @IsOptional() @IsString() spaceName?: string;
  @IsString() date: string;
  @Type(() => Number) @IsInt() startHour: number;
  @Type(() => Number) @IsInt() endHour: number;
  @IsOptional()
  @Transform(({ value }) => (value === 'true' ? true : value === 'false' ? false : value))
  @IsBoolean()
  hasSocket?: boolean;
}

class BookSeatDto {
  @Type(() => Number) @IsInt() seatId: number;
  @IsString() date: string;
  @Type(() => Number) @IsInt() startHour: number;
  @Type(() => Number) @IsInt() endHour: number;
}

class CheckInDto {
  @IsString() code: string;
}

class ListMineDto {
  @IsOptional() @IsString() status?: string;
}

class HistoryDto {
  @IsOptional() @Type(() => Number) @IsInt() page?: number;
}

/**
 * M1 自习座位预约路由（全局前缀 api，JWT 守卫全局启用）。
 * 权限见契约：seat.search / seat.book / seat.signin / stats.view。
 */
@Controller('m1')
export class ReservationsController {
  constructor(private readonly reservationsService: ReservationsService) {}

  @Get('seats/search')
  @Permissions('seat.search')
  search(@Query() query: SearchSeatsDto, @CurrentUser() user: JwtUser) {
    return this.reservationsService.searchSeats(query, { department: user.department });
  }

  @Post('reservations')
  @Permissions('seat.book')
  book(@Body() dto: BookSeatDto, @CurrentUser() user: JwtUser) {
    return this.reservationsService.bookSeat(user.userId, dto, { department: user.department });
  }

  @Post('reservations/:id/check-in')
  @Permissions('seat.signin')
  checkIn(@Param('id', ParseIntPipe) id: number, @Body() dto: CheckInDto, @CurrentUser() user: JwtUser) {
    return this.reservationsService.checkIn(user.userId, id, dto.code);
  }

  @Get('reservations/mine')
  listMine(@Query() query: ListMineDto, @CurrentUser() user: JwtUser) {
    return this.reservationsService.listMyReservations(user.userId, query);
  }

  @Get('history')
  history(@Query() query: HistoryDto, @CurrentUser() user: JwtUser) {
    return this.reservationsService.history(user.userId, query);
  }

  @Post('reservations/:id/cancel')
  cancel(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: JwtUser) {
    return this.reservationsService.cancel(user.userId, id);
  }

  @Post('reservations/:id/rebook')
  rebook(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: JwtUser) {
    return this.reservationsService.rebook(user.userId, id);
  }

  @Get('spaces/:spaceId/dynamic-code')
  dynamicCode(@Param('spaceId', ParseIntPipe) spaceId: number, @Query('date') date: string) {
    return this.reservationsService.getDynamicCode(spaceId, date);
  }

  /** 教室屏幕用签到二维码（SVG）：内容与当日动态码一致（阶段 2 新增） */
  @Get('spaces/:spaceId/qrcode')
  qrCode(@Param('spaceId', ParseIntPipe) spaceId: number, @Query('date') date: string) {
    return this.reservationsService.getQrCode(spaceId, date);
  }

  @Get('stats')
  @Permissions('stats.view')
  stats() {
    return this.reservationsService.stats();
  }
}
