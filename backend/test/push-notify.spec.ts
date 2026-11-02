import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { getRepositoryToken, TypeOrmModule } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Notification, NotificationType } from '../src/database/entities/notification.entity';
import { SystemConfig } from '../src/database/entities/system-config.entity';
import { User } from '../src/database/entities/user.entity';
import { Role } from '../src/database/entities/role.entity';
import { Permission } from '../src/database/entities/permission.entity';
import { InitSchema1780000000000 } from '../src/database/migrations/1780000000000-init-schema';
import { NotificationsService } from '../src/shared/notifications/notifications.service';
import { SystemConfigService } from '../src/shared/system-config/system-config.service';
import { EmailChannel } from '../src/shared/notifications/channels/email.channel';
import { WechatChannel } from '../src/shared/notifications/channels/wechat.channel';
import { PushService } from '../src/shared/notifications/push.service';

/**
 * D 公共层推送服务测试：验证「先站内、后外部、失败降级」的真实行为。
 * 外部边界（SMTP / 微信 HTTP）用假实现替换，被测逻辑（渠道选择、降级、落库）不做 mock。
 */
describe('PushService（站内保底 + 外部推送降级）', () => {
  let configService: SystemConfigService;
  let notificationsService: NotificationsService;
  let notifRepo: Repository<Notification>;
  let userRepo: Repository<User>;
  let userWithEmail: User;
  let userNoEmail: User;

  let emailChannel: EmailChannel;
  let wechatChannel: WechatChannel;
  let pushService: PushService;
  let sendMail: jest.Mock;
  let fetchMock: jest.Mock;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot({
          type: 'sqljs',
          autoSave: false,
          migrationsRun: true,
          migrations: [InitSchema1780000000000],
          entities: [Notification, SystemConfig, User, Role, Permission],
        }),
        TypeOrmModule.forFeature([Notification, SystemConfig, User, Role, Permission]),
      ],
      providers: [NotificationsService, SystemConfigService],
    }).compile();

    configService = moduleRef.get(SystemConfigService);
    notificationsService = moduleRef.get(NotificationsService);
    notifRepo = moduleRef.get(getRepositoryToken(Notification));
    userRepo = moduleRef.get(getRepositoryToken(User));

    userWithEmail = await userRepo.save(
      userRepo.create({ username: 'push-has-email', passwordHash: 'x', name: '有邮箱', email: 'push@campushub.edu', isActive: true }),
    );
    userNoEmail = await userRepo.save(
      userRepo.create({ username: 'push-no-email', passwordHash: 'x', name: '无邮箱', email: '', isActive: true }),
    );
  });

  beforeEach(async () => {
    await notifRepo.clear();
    await configService.set('PUSH_ENABLED', 'false');
    await configService.set('PUSH_EMAIL_ENABLED', 'false');
    await configService.set('PUSH_WECHAT_ENABLED', 'false');

    sendMail = jest.fn().mockResolvedValue({ messageId: 'ok' });
    fetchMock = jest.fn().mockImplementation((url: string) => {
      if (url.includes('/cgi-bin/token')) {
        return Promise.resolve({ json: async () => ({ access_token: 'TOKEN-123', expires_in: 7200 }) });
      }
      return Promise.resolve({ json: async () => ({ errcode: 0, errmsg: 'ok' }) });
    });

    // 每用例新建渠道实例，避免 transporter/token 缓存串场
    emailChannel = new EmailChannel(configService);
    jest.spyOn(emailChannel as any, 'createTransport').mockReturnValue({ sendMail });
    wechatChannel = new WechatChannel(configService);
    jest.spyOn(wechatChannel as any, 'fetcher').mockReturnValue(fetchMock);

    pushService = new PushService(userRepo, notificationsService, configService, emailChannel, wechatChannel);
  });

  it('总开关关闭：只落站内通知，不尝试任何外部渠道', async () => {
    await configService.set('PUSH_ENABLED', 'false');
    const res = await pushService.notify(userWithEmail.id, 'reminder', '预约提醒', '请按时签到');

    const saved = await notifRepo.findBy({ userId: userWithEmail.id });
    expect(saved).toHaveLength(1);
    expect(saved[0].title).toBe('预约提醒');
    expect(saved[0].content).toBe('请按时签到');
    expect(saved[0].isRead).toBe(false);

    expect(res.external.enabled).toBe(false);
    expect(res.external.outcomes).toHaveLength(0);
    expect(sendMail).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('邮件成功：站内通知落库，且按用户邮箱发送邮件', async () => {
    await configService.set('PUSH_ENABLED', 'true');
    await configService.set('PUSH_EMAIL_ENABLED', 'true');
    await configService.set('SMTP_HOST', 'smtp.test.local');
    await configService.set('SMTP_FROM', 'from@campushub.edu');

    const res = await pushService.notify(userWithEmail.id, 'reminder', '预约提醒', '请按时签到');

    expect(await notifRepo.countBy({ userId: userWithEmail.id })).toBe(1);
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(sendMail).toHaveBeenCalledWith({
      from: 'from@campushub.edu',
      to: 'push@campushub.edu',
      subject: '预约提醒',
      text: '请按时签到',
    });

    const emailOutcome = res.external.outcomes.find((o) => o.channel === 'email');
    expect(emailOutcome?.ok).toBe(true);
  });

  it('邮件发送异常：降级为仅站内通知，不抛出、不丢通知', async () => {
    await configService.set('PUSH_ENABLED', 'true');
    await configService.set('PUSH_EMAIL_ENABLED', 'true');
    await configService.set('SMTP_HOST', 'smtp.test.local');
    sendMail.mockRejectedValueOnce(new Error('SMTP down'));

    // 不抛出异常即降级成功
    const res = await pushService.notify(userWithEmail.id, 'reminder', '预约提醒', '内容');

    expect(await notifRepo.countBy({ userId: userWithEmail.id })).toBe(1);
    const outcome = res.external.outcomes.find((o) => o.channel === 'email');
    expect(outcome?.ok).toBe(false);
    expect(outcome?.reason).toBe('SMTP down');
  });

  it('用户无邮箱：邮件渠道跳过并标记原因，站内通知仍保底', async () => {
    await configService.set('PUSH_ENABLED', 'true');
    await configService.set('PUSH_EMAIL_ENABLED', 'true');
    await configService.set('SMTP_HOST', 'smtp.test.local');

    const res = await pushService.notify(userNoEmail.id, 'reminder', '预约提醒', '内容');
    expect(await notifRepo.countBy({ userId: userNoEmail.id })).toBe(1);
    expect(sendMail).not.toHaveBeenCalled();
    const outcome = res.external.outcomes.find((o) => o.channel === 'email');
    expect(outcome?.ok).toBe(false);
    expect(outcome?.reason).toBe('no email address');
  });

  it('微信服务号：获取 access_token 后按模板消息发送', async () => {
    await configService.set('PUSH_ENABLED', 'true');
    await configService.set('PUSH_WECHAT_ENABLED', 'true');
    await configService.set('WECHAT_APPID', 'wx-appid');
    await configService.set('WECHAT_SECRET', 'wx-secret');
    await configService.set('WECHAT_TEMPLATE_ID', 'tpl-1');
    await configService.set('WECHAT_DEMO_OPENID', 'openid-1');

    const res = await pushService.notify(userWithEmail.id, 'reminder', '预约提醒', '请按时签到');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const tokenUrl = fetchMock.mock.calls[0][0] as string;
    expect(tokenUrl).toContain('grant_type=client_credential');
    expect(tokenUrl).toContain('appid=wx-appid');
    expect(tokenUrl).toContain('secret=wx-secret');

    const sendUrl = fetchMock.mock.calls[1][0] as string;
    expect(sendUrl).toContain('/cgi-bin/message/template/send');
    expect(sendUrl).toContain('access_token=TOKEN-123');
    const body = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(body.touser).toBe('openid-1');
    expect(body.template_id).toBe('tpl-1');
    expect(body.data.title.value).toBe('预约提醒');
    expect(body.data.content.value).toBe('请按时签到');

    const outcome = res.external.outcomes.find((o) => o.channel === 'wechat');
    expect(outcome?.ok).toBe(true);
  });
});
