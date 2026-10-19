import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PERMISSIONS_KEY } from '../../common/decorators/permissions.decorator';
import { JwtUser } from '../../common/decorators/current-user.decorator';

/** RBAC 权限守卫：校验当前用户是否拥有接口要求的任一权限 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string[]>(
      PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!required || required.length === 0) return true;

    const user = context.switchToHttp().getRequest().user as JwtUser;
    if (!user) throw new ForbiddenException('未认证');
    const has = user.permissions.some((p) => required.includes(p));
    if (!has) {
      throw new ForbiddenException(`缺少权限：${required.join(' 或 ')}`);
    }
    return true;
  }
}
