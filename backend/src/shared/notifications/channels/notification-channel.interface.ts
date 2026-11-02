import { User } from '../../../database/entities/user.entity';

/** 单个外部渠道的推送结果，用于观测与降级判定 */
export interface PushOutcome {
  channel: string;
  ok: boolean;
  /** 失败原因（渠道未启用 / 缺少目标标识 / 发送异常） */
  reason?: string;
}

/**
 * 外部推送渠道抽象（D 公共层）。
 * 约定：send 失败必须抛错，由 PushService 统一捕获并降级，
 * 不得让外部渠道异常影响站内通知与业务流程。
 */
export interface NotificationChannel {
  readonly name: string;
  /** 总开关 + 渠道开关 + 必填配置齐全时返回 true */
  isEnabled(): Promise<boolean>;
  /** 目标用户可能缺少该渠道所需标识（无邮箱 / 无 openid），此时抛错 */
  send(user: User, title: string, content: string): Promise<void>;
}
