import type { SocialPlatform } from "@postautomation/db";
import { SocialProvider } from "../abstract/social.abstract";
import type {
  SocialPostPayload,
  SocialPostResult,
  OAuthTokens,
  OAuthConfig,
  SocialProfile,
  PlatformConstraints,
} from "../abstract/social.types";

export class TelegramProvider extends SocialProvider {
  readonly platform: SocialPlatform = "TELEGRAM";
  readonly displayName = "Telegram";
  readonly constraints: PlatformConstraints = {
    maxContentLength: 4096,
    supportedMediaTypes: ["image/jpeg", "image/png", "image/gif", "video/mp4"],
    maxMediaCount: 10,
    maxMediaSize: 50 * 1024 * 1024, // 50MB
  };

  /**
   * Telegram uses bot tokens directly, not OAuth.
   * Returns a URL where the user can configure the bot / add it to a channel.
   */
  getOAuthUrl(config: OAuthConfig, state: string): string {
    const params = new URLSearchParams({
      state,
      redirect_uri: config.callbackUrl,
    });
    // Direct the user to BotFather or a setup page; the clientId is the bot username
    return `https://t.me/${config.clientId}?start=${state}&${params.toString()}`;
  }

  /**
   * Telegram bots don't use an OAuth code exchange.
   * The "code" here is expected to be the bot token itself.
   * We return it as the accessToken. The metadata.chat_id should be
   * provided via OAuthConfig or passed in the code as "botToken:chatId".
   */
  async exchangeCodeForTokens(code: string, _config: OAuthConfig): Promise<OAuthTokens> {
    // code format: "botToken" or "botToken:chatId"
    const botToken = code.includes(":") ? code.split(":").slice(0, 2).join(":") : code;

    // Validate the bot token by calling getMe
    const res = await fetch(`https://api.telegram.org/bot${botToken}/getMe`, {
      method: "POST",
    });

    const data: any = await res.json();
    if (!res.ok || !data.ok) {
      throw new Error(`Telegram bot token validation failed: ${JSON.stringify(data)}`);
    }

    return {
      accessToken: botToken,
      // Telegram bot tokens don't expire
    };
  }

  /**
   * Telegram bot tokens don't expire, so refresh is a no-op
   * that returns the same token.
   */
  async refreshAccessToken(refreshToken: string, _config: OAuthConfig): Promise<OAuthTokens> {
    return {
      accessToken: refreshToken,
    };
  }

  async publishPost(tokens: OAuthTokens, payload: SocialPostPayload): Promise<SocialPostResult> {
    const botToken = tokens.accessToken;
    const chatId = (payload.metadata?.chatId as string) || (payload.metadata?.chat_id as string);
    if (!chatId) {
      throw new Error("Telegram publishPost requires metadata.chatId (channel or group ID)");
    }

    // If media is attached, send as a media group or single photo/video
    if (payload.mediaUrls?.length) {
      return this.sendMediaMessage(botToken, chatId, payload);
    }

    // Text-only message
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: payload.content,
        parse_mode: "HTML",
      }),
    });

    const data: any = await res.json();
    if (!res.ok || !data.ok) {
      throw new Error(`Telegram sendMessage failed: ${JSON.stringify(data)}`);
    }

    const messageId = String(data.result.message_id);
    return {
      platformPostId: `${chatId}:${messageId}`,
      url: data.result.chat?.username
        ? `https://t.me/${data.result.chat.username}/${messageId}`
        : `https://t.me/c/${String(chatId).replace("-100", "")}/${messageId}`,
      metadata: data.result,
    };
  }

  async deletePost(tokens: OAuthTokens, platformPostId: string): Promise<void> {
    const botToken = tokens.accessToken;
    // platformPostId format: "chatId:messageId"
    const [chatId, messageId] = platformPostId.split(":");
    if (!chatId || !messageId) {
      throw new Error("Telegram deletePost requires platformPostId in format 'chatId:messageId'");
    }

    const res = await fetch(`https://api.telegram.org/bot${botToken}/deleteMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: Number(messageId),
      }),
    });

    const data: any = await res.json();
    if (!res.ok || !data.ok) {
      throw new Error(`Telegram deleteMessage failed: ${JSON.stringify(data)}`);
    }
  }

  async getProfile(tokens: OAuthTokens): Promise<SocialProfile> {
    const botToken = tokens.accessToken;

    const res = await fetch(`https://api.telegram.org/bot${botToken}/getMe`, {
      method: "POST",
    });

    const data: any = await res.json();
    if (!res.ok || !data.ok) {
      throw new Error(`Telegram getMe failed: ${JSON.stringify(data)}`);
    }

    return {
      id: String(data.result.id),
      name: `${data.result.first_name}${data.result.last_name ? " " + data.result.last_name : ""}`,
      username: data.result.username,
    };
  }

  private async sendMediaMessage(
    botToken: string,
    chatId: string,
    payload: SocialPostPayload
  ): Promise<SocialPostResult> {
    const mediaUrls = payload.mediaUrls!;

    if (mediaUrls.length === 1) {
      // Single photo — use sendPhoto
      const res = await fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          photo: mediaUrls[0],
          caption: payload.content,
          parse_mode: "HTML",
        }),
      });

      const data: any = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(`Telegram sendPhoto failed: ${JSON.stringify(data)}`);
      }

      const messageId = String(data.result.message_id);
      return {
        platformPostId: `${chatId}:${messageId}`,
        url: data.result.chat?.username
          ? `https://t.me/${data.result.chat.username}/${messageId}`
          : `https://t.me/c/${String(chatId).replace("-100", "")}/${messageId}`,
        metadata: data.result,
      };
    }

    // Multiple media — use sendMediaGroup
    const media = mediaUrls.map((url, index) => ({
      type: "photo" as const,
      media: url,
      ...(index === 0 ? { caption: payload.content, parse_mode: "HTML" } : {}),
    }));

    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMediaGroup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        media,
      }),
    });

    const data: any = await res.json();
    if (!res.ok || !data.ok) {
      throw new Error(`Telegram sendMediaGroup failed: ${JSON.stringify(data)}`);
    }

    // sendMediaGroup returns an array of messages; use the first one
    const firstMessage = data.result[0];
    const messageId = String(firstMessage.message_id);
    return {
      platformPostId: `${chatId}:${messageId}`,
      url: firstMessage.chat?.username
        ? `https://t.me/${firstMessage.chat.username}/${messageId}`
        : `https://t.me/c/${String(chatId).replace("-100", "")}/${messageId}`,
      metadata: data.result,
    };
  }
}
