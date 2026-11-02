import { Injectable, Logger } from '@nestjs/common';
import { SystemConfigService } from '../../system-config/system-config.service';
import { User } from '../../../database/entities/user.entity';
import { NotificationChannel } from './notification-channel.interface';

/**
 * 微信服务号模板消息渠道。
 * 启用条件：PUSH_ENABLED 与 PUSH_WECHAT_ENABLED 均为 true，且配置了 WECHAT_APPID / WECHAT_SECRET。
 * 目标用户需有绑定 openid（雏形以 WECHAT_DEMO_OPENID 演示，正式版应由账号绑定获得）。
 */
@Injectable()
export class WechatChannel implements NotificationChannel {
  readonly name = 'wechat';
  private readonly logger = new Logger(WechatChannel.name);
  private tokenCache: { token: string; expiresAt: number } | null = null;

  constructor(private readonly config: SystemConfigService) {}

  async isEnabled(): Promise<boolean> {
    const master = (await this.config.get('PUSH_ENABLED', 'false')) === 'true';
    const on = (await this.config.get('PUSH_WECHAT_ENABLED', 'false')) === 'true';
    const appid = (await this.config.get('WECHAT_APPID', '')).trim();
    const secret = (await this.config.get('WECHAT_SECRET', '')).trim();
    return master && on && appid !== '' && secret !== '';
  }

  /** 独立成方法便于测试替换全局 fetch */
  protected fetcher(): (url: string, init?: any) => Promise<any> {
    return (globalThis as any).fetch;
  }

  private async getAccessToken(): Promise<string> {
    if (this.tokenCache && this.tokenCache.expiresAt > Date.now()) {
      return this.tokenCache.token;
    }
    const appid = (await this.config.get('WECHAT_APPID', '')).trim();
    const secret = (await this.config.get('WECHAT_SECRET', '')).trim();
    const res = await this.fetcher()(
      `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${appid}&secret=${secret}`,
    );
    const json = await res.json();
    if (!json.access_token) {
      throw new Error(`wechat token error: ${json.errmsg ?? 'unknown'}`);
    }
    const ttl = Number(json.expires_in ?? 7200);
    this.tokenCache = { token: json.access_token, expiresAt: Date.now() + ttl * 1000 };
    return json.access_token;
  }

  async send(_user: User, title: string, content: string): Promise<void> {
    const openid = (await this.config.get('WECHAT_DEMO_OPENID', '')).trim();
    if (!openid) throw new Error('no openid bound');
    const templateId = (await this.config.get('WECHAT_TEMPLATE_ID', '')).trim();
    if (!templateId) throw new Error('no template id');

    const token = await this.getAccessToken();
    const res = await this.fetcher()(
      `https://api.weixin.qq.com/cgi-bin/message/template/send?access_token=${token}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          touser: openid,
          template_id: templateId,
          data: { title: { value: title }, content: { value: content } },
        }),
      },
    );
    const json = await res.json();
    if (json.errcode !== 0) {
      throw new Error(`wechat send error ${json.errcode}: ${json.errmsg}`);
    }
    this.logger.debug(`wechat message sent to ${openid}`);
  }
}
