import { Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Put, Query } from '@nestjs/common';
import { IsArray, IsOptional, IsString } from 'class-validator';
import { UsersService } from './users.service';
import { RolesService } from './roles.service';
import { Role } from '../../database/entities/role.entity';
import { Permissions } from '../../common/decorators/permissions.decorator';

export class CreateUserDto {
  @IsString() username: string;
  @IsString() password: string;
  @IsString() name: string;
  @IsOptional() @IsString() email?: string;
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsString() department?: string;
  @IsOptional() @IsArray() roleCodes?: string[];
}

export class UpdateUserDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() email?: string;
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsString() department?: string;
  @IsOptional() roleCodes?: string[];
  @IsOptional() isActive?: boolean;
  @IsOptional() @IsString() password?: string;
}

export class CreateRoleDto {
  @IsString() code: string;
  @IsString() name: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsArray() permissionCodes?: string[];
}

export class SetRolePermissionsDto {
  @IsArray() permissionCodes: string[];
}

@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get()
  @Permissions('user.manage')
  list(@Query('keyword') keyword?: string, @Query('page') page?: string, @Query('pageSize') pageSize?: string) {
    return this.usersService.findAll({
      keyword,
      page: page ? Number(page) : 1,
      pageSize: pageSize ? Number(pageSize) : 20,
    });
  }

  @Get(':id')
  @Permissions('user.manage')
  detail(@Param('id', ParseIntPipe) id: number) {
    return this.usersService.findById(id);
  }

  @Post()
  @Permissions('user.manage')
  create(@Body() dto: CreateUserDto) {
    return this.usersService.create(dto);
  }

  @Put(':id')
  @Permissions('user.manage')
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateUserDto) {
    return this.usersService.update(id, dto);
  }
}

@Controller('roles')
export class RolesController {
  constructor(private readonly rolesService: RolesService) {}

  @Get()
  @Permissions('role.manage')
  list(): Promise<Role[]> {
    return this.rolesService.findAll();
  }

  @Get('permissions')
  @Permissions('role.manage')
  permissions() {
    return this.rolesService.listPermissions();
  }

  @Post()
  @Permissions('role.manage')
  create(@Body() dto: CreateRoleDto) {
    return this.rolesService.create(dto);
  }

  @Put(':id')
  @Permissions('role.manage')
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: Partial<CreateRoleDto>) {
    return this.rolesService.update(id, { name: dto.name, description: dto.description });
  }

  @Put(':id/permissions')
  @Permissions('role.manage')
  setPermissions(@Param('id', ParseIntPipe) id: number, @Body() dto: SetRolePermissionsDto) {
    return this.rolesService.setPermissions(id, dto.permissionCodes);
  }

  @Delete(':id')
  @Permissions('role.manage')
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.rolesService.remove(id);
  }
}
