import { Body, Controller, Get, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { CurrentUser, JwtUser } from '../../common/decorators/current-user.decorator';

@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @Get()
  list(@CurrentUser() user: JwtUser, @Query('unreadOnly') unreadOnly?: string) {
    return this.notificationsService.listForUser(user.userId, unreadOnly === 'true');
  }

  @Get('unread-count')
  unreadCount(@CurrentUser() user: JwtUser) {
    return this.notificationsService.unreadCount(user.userId);
  }

  @Post(':id/read')
  markRead(@CurrentUser() user: JwtUser, @Param('id', ParseIntPipe) id: number) {
    return this.notificationsService.markRead(id, user.userId);
  }

  @Post('read-all')
  markAllRead(@CurrentUser() user: JwtUser) {
    return this.notificationsService.markAllRead(user.userId);
  }
}
