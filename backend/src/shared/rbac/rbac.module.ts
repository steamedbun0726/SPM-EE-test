import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from '../../database/entities/user.entity';
import { Role } from '../../database/entities/role.entity';
import { Permission } from '../../database/entities/permission.entity';
import { UsersService } from './users.service';
import { RolesService } from './roles.service';
import { UsersController, RolesController } from './rbac.controller';

/**
 * D1 身份与权限模块（用户 / 角色的增删改查与授权）。
 *
 * 为什么需要单独一个模块：`UsersController` 与 `RolesController` 此前只被定义、
 * 从未被任何模块注册在 `controllers` 中，导致 `/api/users`、`/api/roles`
 * 全部返回 404，前端「用户管理」「角色与权限」两个页面不可用。
 *
 * 边界说明：本模块只做用户与角色的管理与数据访问，不涉及登录签发（属 AuthModule）。
 */
@Module({
  imports: [TypeOrmModule.forFeature([User, Role, Permission])],
  controllers: [UsersController, RolesController],
  providers: [UsersService, RolesService],
  exports: [UsersService, RolesService],
})
export class RbacModule {}
