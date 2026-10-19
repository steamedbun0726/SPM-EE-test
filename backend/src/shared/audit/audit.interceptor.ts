import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import { AuditService } from './audit.service';

/** 全局审计拦截器：自动记录写操作（POST/PUT/PATCH/DELETE） */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(private readonly auditService: AuditService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest();
    const method: string = req.method;
    const url: string = req.originalUrl || req.url;

    // 仅审计写操作
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method.toUpperCase())) {
      return next.handle();
    }

    const user = req.user || null;
    const body = req.body || {};
    const detail = JSON.stringify(body).slice(0, 500);

    return next.handle().pipe(
      tap(() => {
        this.auditService
          .record({
            userId: user?.userId ?? null,
            username: user?.username ?? 'anonymous',
            action: `${method} ${url.split('?')[0]}`,
            resourceType: url.split('/')[2] || '',
            resourceId: url.split('/')[3] || '',
            detail,
            ip: req.ip || '',
          })
          .catch(() => undefined); // 审计失败不影响主流程
      }),
    );
  }
}
