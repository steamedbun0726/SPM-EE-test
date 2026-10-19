import { Controller, Get, Query } from '@nestjs/common';
import { AuditService } from './audit.service';
import { Permissions } from '../../common/decorators/permissions.decorator';

@Controller('audit')
export class AuditController {
  constructor(private readonly auditService: AuditService) {}

  @Get()
  @Permissions('audit.view')
  list(@Query('keyword') keyword?: string, @Query('page') page?: string, @Query('pageSize') pageSize?: string) {
    return this.auditService.findAll({
      keyword,
      page: page ? Number(page) : 1,
      pageSize: pageSize ? Number(pageSize) : 20,
    });
  }
}
