import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { IsBoolean, IsOptional, IsString } from 'class-validator';
import { SpacesService } from './spaces.service';
import { SeatStateService } from './seat-state.service';
import { SpaceType } from '../../database/entities/space.entity';
import { Permissions } from '../../common/decorators/permissions.decorator';
import { CurrentUser, JwtUser } from '../../common/decorators/current-user.decorator';

class CreateSpaceDto {
  @IsString() code: string;
  @IsString() name: string;
  @IsOptional() @IsString() type?: SpaceType;
  @IsOptional() @IsString() ownerDept?: string;
  @IsOptional() @IsString() openTime?: string;
  @IsOptional() @IsString() closeTime?: string;
  @IsOptional() @IsString() description?: string;
}

class UpdateSpaceDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() type?: SpaceType;
  @IsOptional() @IsString() ownerDept?: string;
  @IsOptional() @IsString() openTime?: string;
  @IsOptional() @IsString() closeTime?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

class CreateSeatDto {
  @IsString() seatNo: string;
  @IsOptional() @IsBoolean() hasSocket?: boolean;
}

class UpdateSeatDto {
  @IsOptional() @IsString() seatNo?: string;
  @IsOptional() @IsBoolean() hasSocket?: boolean;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

@Controller('spaces')
export class SpacesController {
  constructor(
    private readonly spacesService: SpacesService,
    private readonly seatStateService: SeatStateService,
  ) {}

  @Get()
  list(@Query('keyword') keyword?: string, @Query('type') type?: string, @Query('isActive') isActive?: string) {
    return this.spacesService.findAll({ keyword, type: type as never, isActive });
  }

  @Get('stats')
  @Permissions('stats.view')
  stats() {
    return this.spacesService.occupancyStats();
  }

  @Get(':id')
  detail(@Param('id', ParseIntPipe) id: number) {
    return this.spacesService.findById(id);
  }

  @Post()
  @Permissions('space.manage')
  create(@Body() dto: CreateSpaceDto) {
    return this.spacesService.create(dto);
  }

  @Put(':id')
  @Permissions('space.manage')
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateSpaceDto) {
    return this.spacesService.update(id, dto);
  }

  @Delete(':id')
  @Permissions('space.manage')
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.spacesService.remove(id);
  }

  // ===== 座位 =====

  @Get(':id/seats')
  seats(@Param('id', ParseIntPipe) id: number) {
    return this.spacesService.listSeats(id);
  }

  @Post(':id/seats')
  @Permissions('seat.manage')
  createSeat(@Param('id', ParseIntPipe) id: number, @Body() dto: CreateSeatDto) {
    return this.spacesService.createSeat(id, dto);
  }

  @Put('seats/:seatId')
  @Permissions('seat.manage')
  updateSeat(@Param('seatId', ParseIntPipe) seatId: number, @Body() dto: UpdateSeatDto) {
    return this.spacesService.updateSeat(seatId, dto);
  }

  @Get('seats/:seatId/history')
  seatHistory(@Param('seatId', ParseIntPipe) seatId: number, @Query('limit') limit?: string) {
    return this.seatStateService.history(seatId, limit ? Number(limit) : 50);
  }
}
