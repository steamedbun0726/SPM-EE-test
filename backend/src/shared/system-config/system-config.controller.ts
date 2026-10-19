import { Body, Controller, Get, Put } from '@nestjs/common';
import { IsOptional, IsString } from 'class-validator';
import { SystemConfigService } from './system-config.service';
import { Permissions } from '../../common/decorators/permissions.decorator';

class SetConfigDto {
  @IsString() key: string;
  @IsString() value: string;
  @IsOptional() @IsString() description?: string;
}

@Controller('system-configs')
export class SystemConfigController {
  constructor(private readonly service: SystemConfigService) {}

  @Get()
  list() {
    return this.service.findAll();
  }

  @Put()
  @Permissions('config.manage')
  set(@Body() dto: SetConfigDto) {
    return this.service.set(dto.key, dto.value, dto.description);
  }
}
