/**
 * Token-based channel connectors.
 *
 * For platforms that DON'T require a developer-portal OAuth app:
 *   - TELEGRAM    — bot token (+ optional chat ID)
 *   - DISCORD     — channel webhook URL
 *   - BLUESKY     — handle + app password
 *   - MASTODON    — instance URL + access token
 *   - WORDPRESS   — site URL + username + application password (self-hosted)
 *   - MEDIUM      — integration token
 *   - DEVTO       — API key
 *
 * Each validator returns a normalized `ValidatedChannel` shape that the
 * caller upserts as a Channel row. Validation is done by calling the
 * platform's own API so credentials are always real, never stored blind.
 */

import { TRPCError } from "@trpc/server";

export type TokenPlatform =
  | "TELEGRAM"
  | "DISCORD"
  | "BLUESKY"
  | "MASTODON"
  | "WORDPRESS"
  | "MEDIUM"
  | "DEVTO";

export const TOKEN_PLATFORMS: readonly TokenPlatform[] = [
  "TELEGRAM",
  "DISCORD",
  "BLUESKY",
  "MASTODON",
  "WORDPRESS",
  "MEDIUM",
  "DEVTO",
] as const;

export interface ValidatedChannel {
  platformId: string;
  name: string;
  username: string | null;
  avatar: string | null;
  accessToken: string;
  refreshToken?: string | null;
  tokenExpiresAt?: Date | null;
  scopes: string[];
  metadata: Record<string, unknown>;
}

// Each platform exposes the form fields its UI dialog asks the user for.
// `type: "password"` renders as masked input.
export interface TokenFieldSpec {
  name: string;
  label: string;
  placeholder?: string;
  type: "text" | "password" | "url";
  required: boolean;
  /** Longer paragraph shown under the field — keep brief, normie language. */
  helpText?: string;
  /** Short example shown in italics under the field, e.g. "Looks like: 123:abc...". */
  tip?: string;
}

export interface TokenPlatformSpec {
  platform: TokenPlatform;
  displayName: string;
  description: string;
  /** Link to the platform's docs / settings page where credentials live. */
  helpUrl: string;
  /** Button label for the help link, e.g. "Open @BotFather". */
  helpLinkLabel?: string;
  /** Step-by-step instructions, one entry per step. Renders as a numbered list. */
  steps: string[];
  fields: TokenFieldSpec[];
  /**
   * Platform-specific feature flags the UI special-cases. Right now only
   * Telegram uses `chatDetect` to surface the "Detect chats" picker.
   */
  features?: { chatDetect?: boolean };
}

export const TOKEN_PLATFORM_SPECS: Record<TokenPlatform, TokenPlatformSpec> = {
  TELEGRAM: {
    platform: "TELEGRAM",
    displayName: "Telegram",
    description: "Post to a Telegram channel, group, or DM via a bot you control.",
    helpUrl: "https://t.me/BotFather",
    helpLinkLabel: "Open @BotFather",
    features: { chatDetect: true },
    steps: [
      "Open Telegram → search @BotFather → start a chat → send /newbot.",
      "Pick a name and username for your bot — @BotFather replies with a long bot token. Copy the WHOLE thing.",
      "Paste the bot token below and click Detect chats.",
      "Now add your bot to a channel or group as an Administrator, post any message, then come back and click Detect chats — you'll see the chat in a dropdown to pick.",
    ],
    fields: [
      {
        name: "botToken",
        label: "Bot Token",
        placeholder: "123456789:ABCdefGhIJKlmNoPQRstuvwxyz",
        type: "password",
        required: true,
        tip: "Format: digits, then a colon, then ~35 random letters/digits.",
      },
      {
        name: "chatId",
        label: "Chat ID (auto-filled by Detect)",
        placeholder: "Click Detect chats above to fill this in",
        type: "text",
        required: false,
        tip: "Leave blank if you don't know it — use Detect chats. Manual entry is fine if you already know the ID (e.g. -1001234567890 for a channel).",
      },
    ],
  },
  DISCORD: {
    platform: "DISCORD",
    displayName: "Discord (Webhook)",
    description: "Post to a Discord channel via a webhook URL. No developer app required.",
    helpUrl: "https://support.discord.com/hc/en-us/articles/228383668-Intro-to-Webhooks",
    helpLinkLabel: "Discord webhook docs",
    steps: [
      "In Discord, open the server where you want to post.",
      "Hover the target text channel → click the gear icon → Integrations → Webhooks.",
      "Click 'New Webhook'. Optionally rename it / set an avatar.",
      "Click 'Copy Webhook URL', paste it below, and click Connect.",
    ],
    fields: [
      {
        name: "webhookUrl",
        label: "Webhook URL",
        placeholder: "https://discord.com/api/webhooks/123.../abc...",
        type: "url",
        required: true,
        tip: "Always starts with https://discord.com/api/webhooks/ — never share this URL publicly.",
      },
    ],
  },
  BLUESKY: {
    platform: "BLUESKY",
    displayName: "Bluesky",
    description: "Post to Bluesky using a handle and an app password (NOT your account password).",
    helpUrl: "https://bsky.app/settings/app-passwords",
    helpLinkLabel: "Open Bluesky App Passwords",
    steps: [
      "Go to bsky.app/settings/app-passwords (sign in if asked).",
      "Click 'Add App Password', name it 'PostAutomation', then copy the password shown.",
      "Paste your full handle (with .bsky.social) and the app password below.",
    ],
    fields: [
      {
        name: "identifier",
        label: "Handle",
        placeholder: "you.bsky.social",
        type: "text",
        required: true,
        tip: "Include the full handle with .bsky.social (or your custom domain).",
      },
      {
        name: "appPassword",
        label: "App Password",
        placeholder: "xxxx-xxxx-xxxx-xxxx",
        type: "password",
        required: true,
        tip: "Looks like four 4-char blocks separated by dashes. NEVER paste your real Bluesky password here.",
      },
    ],
  },
  MASTODON: {
    platform: "MASTODON",
    displayName: "Mastodon",
    description: "Post to any Mastodon instance using an access token.",
    helpUrl: "https://docs.joinmastodon.org/user/profile/#development",
    helpLinkLabel: "Mastodon dev docs",
    steps: [
      "Sign into YOUR Mastodon instance (e.g. mastodon.social, hachyderm.io, etc.).",
      "Click your avatar → Preferences → Development (in the left sidebar) → New application.",
      "Set the application name to PostAutomation. In the 'Scopes' section, tick ONLY `write:statuses`, `write:media`, and `read:accounts`. Untick everything else.",
      "Click Submit. Open the new application — your access token is shown at the top of the page.",
      "Copy the access token and paste it below along with your instance's full URL.",
    ],
    fields: [
      {
        name: "instance",
        label: "Instance URL",
        placeholder: "https://mastodon.social",
        type: "url",
        required: true,
        tip: "The full URL of your Mastodon instance, including https://. Examples: https://mastodon.social, https://hachyderm.io.",
      },
      {
        name: "accessToken",
        label: "Access Token",
        placeholder: "Long random string from your application's page",
        type: "password",
        required: true,
        tip: "Found at the TOP of the application's settings page on your instance — labeled 'Your access token'.",
      },
    ],
  },
  WORDPRESS: {
    platform: "WORDPRESS",
    displayName: "WordPress (self-hosted)",
    description: "Post to a self-hosted WordPress site using an application password. Requires WordPress 5.6 or newer.",
    helpUrl: "https://wordpress.org/documentation/article/application-passwords/",
    helpLinkLabel: "WordPress App Password docs",
    steps: [
      "Log into your WordPress admin dashboard as an admin/editor.",
      "Go to Users → Profile (or Users → Your Profile).",
      "Scroll to the BOTTOM of the page to the 'Application Passwords' section.",
      "Type 'PostAutomation' in the 'New Application Password Name' box and click 'Add New Application Password'.",
      "Copy the password shown (it has spaces — paste it exactly as is, the spaces don't matter).",
      "Paste your site URL, your WordPress username, and the application password below.",
    ],
    fields: [
      {
        name: "siteUrl",
        label: "Site URL",
        placeholder: "https://yourblog.com",
        type: "url",
        required: true,
        tip: "The root URL of your WP site (no /wp-admin, no trailing slash).",
      },
      {
        name: "username",
        label: "WordPress Username",
        placeholder: "admin",
        type: "text",
        required: true,
        tip: "The username you use to log into WordPress.",
      },
      {
        name: "appPassword",
        label: "Application Password",
        placeholder: "xxxx xxxx xxxx xxxx xxxx xxxx",
        type: "password",
        required: true,
        tip: "Six 4-char blocks separated by spaces. NOT your WordPress login password.",
      },
    ],
  },
  MEDIUM: {
    platform: "MEDIUM",
    displayName: "Medium",
    description: "Cross-post to Medium using an integration token.",
    helpUrl: "https://help.medium.com/hc/en-us/articles/213480228-API-access",
    helpLinkLabel: "Medium API docs",
    steps: [
      "Note: Medium stopped issuing NEW integration tokens in 2023.",
      "If you have an existing token from before then, paste it below.",
      "If not, Medium isn't accessible from this platform — apologies, it's their restriction, not ours.",
    ],
    fields: [
      {
        name: "integrationToken",
        label: "Integration Token",
        placeholder: "Existing Medium integration token",
        type: "password",
        required: true,
        tip: "Long random string issued by Medium before 2023.",
      },
    ],
  },
  DEVTO: {
    platform: "DEVTO",
    displayName: "Dev.to",
    description: "Publish articles to Dev.to using an API key.",
    helpUrl: "https://dev.to/settings/extensions",
    helpLinkLabel: "Open Dev.to API Keys",
    steps: [
      "Go to dev.to/settings/extensions (sign in if asked).",
      "Scroll to 'DEV Community API Keys'.",
      "Type 'PostAutomation' in the description box and click 'Generate API Key'.",
      "Copy the key shown and paste it below.",
    ],
    fields: [
      {
        name: "apiKey",
        label: "API Key",
        placeholder: "Long alphanumeric string",
        type: "password",
        required: true,
        tip: "Generated on dev.to/settings/extensions — usually ~32 hex characters.",
      },
    ],
  },
};

// ───────────────────────────────────────────────────────────────────────
// Validators — call the platform's own API to confirm credentials work
// before storing anything. Errors are user-friendly (TRPCError BAD_REQUEST).
// ───────────────────────────────────────────────────────────────────────

function badRequest(message: string): never {
  throw new TRPCError({ code: "BAD_REQUEST", message });
}

async function validateTelegram(creds: Record<string, string>): Promise<ValidatedChannel> {
  const botToken = creds.botToken?.trim();
  const chatIdRaw = creds.chatId?.trim();
  if (!botToken) badRequest("Bot token is required. Get one from @BotFather on Telegram.");
  if (!/^\d{6,}:[A-Za-z0-9_-]{20,}$/.test(botToken)) {
    badRequest("That doesn't look like a Telegram bot token. Format: 123456789:ABCdef...");
  }

  const res = await fetch(`https://api.telegram.org/bot${botToken}/getMe`);
  const data: any = await res.json().catch(() => null);
  if (!res.ok || !data?.ok) {
    badRequest("Telegram rejected the bot token. Double-check by sending /mybots to @BotFather.");
  }

  const botUsername: string = data.result.username;
  const botName: string = data.result.first_name || botUsername;

  let chatTitle: string | null = null;
  let chatType: string | null = null;
  let resolvedChatId: string | null = null;
  if (chatIdRaw) {
    const chatRes = await fetch(
      `https://api.telegram.org/bot${botToken}/getChat?chat_id=${encodeURIComponent(chatIdRaw)}`
    );
    const chatData: any = await chatRes.json().catch(() => null);
    if (!chatRes.ok || !chatData?.ok) {
      badRequest(
        "Couldn't reach that chat. Add the bot to the channel/group as an administrator first, then retry."
      );
    }
    chatTitle = chatData.result.title || chatData.result.username || null;
    chatType = chatData.result.type;
    resolvedChatId = String(chatData.result.id);
  }

  return {
    platformId: resolvedChatId ? `bot:${botUsername}|chat:${resolvedChatId}` : `bot:${botUsername}`,
    name: chatTitle || botName,
    username: chatTitle ? botUsername : botUsername,
    avatar: null,
    accessToken: botToken,
    scopes: ["bot"],
    metadata: {
      botUsername,
      chatId: resolvedChatId,
      chatType,
      chatTitle,
    },
  };
}

async function validateDiscord(creds: Record<string, string>): Promise<ValidatedChannel> {
  const webhookUrl = creds.webhookUrl?.trim();
  if (!webhookUrl) badRequest("Webhook URL is required.");
  if (!/^https:\/\/(discord(app)?\.com|ptb\.discord\.com|canary\.discord\.com)\/api\/webhooks\/\d+\/[\w-]+$/.test(webhookUrl)) {
    badRequest("That URL doesn't look like a Discord webhook. It should start with https://discord.com/api/webhooks/...");
  }

  const res = await fetch(webhookUrl);
  const data: any = await res.json().catch(() => null);
  if (!res.ok || !data?.id) {
    badRequest("Discord doesn't recognise that webhook. It may have been deleted or revoked.");
  }

  const avatarUrl = data.avatar
    ? `https://cdn.discordapp.com/avatars/${data.id}/${data.avatar}.png`
    : null;

  return {
    platformId: data.id as string,
    name: (data.name as string) || "Discord webhook",
    username: data.channel_id as string,
    avatar: avatarUrl,
    accessToken: webhookUrl, // Webhook URL IS the credential — anyone holding it can post.
    scopes: ["webhook"],
    metadata: {
      webhookUrl,
      channelId: data.channel_id,
      guildId: data.guild_id ?? null,
      kind: "webhook",
    },
  };
}

async function validateBluesky(creds: Record<string, string>): Promise<ValidatedChannel> {
  const identifier = creds.identifier?.trim().replace(/^@/, "");
  const appPassword = creds.appPassword?.trim();
  if (!identifier) badRequest("Bluesky handle is required (e.g. you.bsky.social).");
  if (!appPassword) badRequest("App password is required. Create one at bsky.app/settings/app-passwords.");

  const service = "https://bsky.social";
  const res = await fetch(`${service}/xrpc/com.atproto.server.createSession`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier, password: appPassword }),
  });
  const data: any = await res.json().catch(() => null);
  if (!res.ok || !data?.accessJwt) {
    badRequest(
      "Bluesky rejected those credentials. NEVER use your real Bluesky password — create an App Password at bsky.app/settings/app-passwords."
    );
  }

  return {
    platformId: data.did as string,
    name: (data.handle as string) || identifier,
    username: (data.handle as string) || identifier,
    avatar: null,
    accessToken: data.accessJwt as string,
    refreshToken: (data.refreshJwt as string) ?? null,
    scopes: ["atproto"],
    metadata: { service, handle: data.handle, did: data.did },
  };
}

async function validateMastodon(creds: Record<string, string>): Promise<ValidatedChannel> {
  const instanceRaw = creds.instance?.trim();
  const accessToken = creds.accessToken?.trim();
  if (!instanceRaw) badRequest("Instance URL is required (e.g. https://mastodon.social).");
  if (!accessToken) badRequest("Access token is required.");

  const instance = instanceRaw.replace(/\/+$/, "").replace(/^http:\/\//, "https://");
  if (!/^https:\/\/[\w.-]+\.[a-z]{2,}$/i.test(instance)) {
    badRequest("Instance URL must look like https://mastodon.social — no path or trailing slash.");
  }

  const res = await fetch(`${instance}/api/v1/accounts/verify_credentials`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data: any = await res.json().catch(() => null);
  if (!res.ok || !data?.id) {
    badRequest(
      "Mastodon rejected the access token. Generate a new one at Preferences → Development on your instance, with write:statuses + write:media scopes."
    );
  }

  return {
    platformId: String(data.id),
    name: (data.display_name as string) || (data.username as string),
    username: data.acct as string,
    avatar: (data.avatar as string) || null,
    accessToken,
    scopes: ["write:statuses", "write:media"],
    metadata: { instance, acct: data.acct },
  };
}

async function validateWordPress(creds: Record<string, string>): Promise<ValidatedChannel> {
  const siteUrlRaw = creds.siteUrl?.trim();
  const username = creds.username?.trim();
  const appPasswordRaw = creds.appPassword?.trim();
  if (!siteUrlRaw) badRequest("Site URL is required (e.g. https://yourblog.com).");
  if (!username) badRequest("Username is required.");
  if (!appPasswordRaw) badRequest("Application password is required.");

  const siteUrl = siteUrlRaw.replace(/\/+$/, "");
  if (!/^https?:\/\/[\w.-]+/.test(siteUrl)) {
    badRequest("Site URL must include http:// or https://");
  }

  // WordPress UI shows the app password with spaces — strip them before use.
  const appPassword = appPasswordRaw.replace(/\s+/g, "");
  const auth = Buffer.from(`${username}:${appPassword}`).toString("base64");

  const res = await fetch(`${siteUrl}/wp-json/wp/v2/users/me?context=edit`, {
    headers: { Authorization: `Basic ${auth}` },
  });
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      badRequest("WordPress rejected those credentials. Make sure you're using an Application Password (Users → Profile), not your login password.");
    }
    badRequest(`WordPress responded with HTTP ${res.status}. Confirm the site URL exposes /wp-json (REST API enabled).`);
  }
  const data: any = await res.json().catch(() => null);
  if (!data?.id) badRequest("WordPress returned an unexpected response.");

  // Fetch the site name (best-effort)
  let siteName = siteUrl.replace(/^https?:\/\//, "");
  try {
    const siteRes = await fetch(`${siteUrl}/wp-json`);
    if (siteRes.ok) {
      const siteData = await siteRes.json();
      if (siteData?.name) siteName = String(siteData.name);
    }
  } catch {
    // ignore — fall back to the URL hostname
  }

  return {
    platformId: `${siteUrl}#${data.id}`,
    name: siteName,
    username: (data.slug as string) || username,
    avatar: data.avatar_urls?.["96"] || data.avatar_urls?.["48"] || null,
    accessToken: auth, // base64(username:appPassword) — used as `Authorization: Basic <token>`
    scopes: ["self-hosted"],
    metadata: {
      siteUrl,
      username,
      kind: "self-hosted",
      userId: data.id,
    },
  };
}

async function validateMedium(creds: Record<string, string>): Promise<ValidatedChannel> {
  const integrationToken = creds.integrationToken?.trim();
  if (!integrationToken) badRequest("Integration token is required.");

  const res = await fetch("https://api.medium.com/v1/me", {
    headers: {
      Authorization: `Bearer ${integrationToken}`,
      Accept: "application/json",
    },
  });
  const data: any = await res.json().catch(() => null);
  if (!res.ok || !data?.data?.id) {
    badRequest("Medium rejected the integration token. Note: Medium has restricted new integration tokens since 2023.");
  }
  const me = data.data;

  return {
    platformId: me.id as string,
    name: (me.name as string) || me.username,
    username: me.username as string,
    avatar: (me.imageUrl as string) || null,
    accessToken: integrationToken,
    scopes: ["basicProfile", "publishPost"],
    metadata: { mediumUrl: me.url ?? null },
  };
}

async function validateDevto(creds: Record<string, string>): Promise<ValidatedChannel> {
  const apiKey = creds.apiKey?.trim();
  if (!apiKey) badRequest("API key is required. Get one at dev.to/settings/extensions.");

  const res = await fetch("https://dev.to/api/users/me", {
    headers: { "api-key": apiKey },
  });
  const data: any = await res.json().catch(() => null);
  if (!res.ok || !data?.id) {
    badRequest("Dev.to rejected that API key. Generate a fresh one at dev.to/settings/extensions.");
  }

  return {
    platformId: String(data.id),
    name: (data.name as string) || data.username,
    username: data.username as string,
    avatar: (data.profile_image as string) || null,
    accessToken: apiKey,
    scopes: ["articles:write"],
    metadata: {},
  };
}

const VALIDATORS: Record<
  TokenPlatform,
  (creds: Record<string, string>) => Promise<ValidatedChannel>
> = {
  TELEGRAM: validateTelegram,
  DISCORD: validateDiscord,
  BLUESKY: validateBluesky,
  MASTODON: validateMastodon,
  WORDPRESS: validateWordPress,
  MEDIUM: validateMedium,
  DEVTO: validateDevto,
};

export async function validateAndBuildChannel(
  platform: TokenPlatform,
  credentials: Record<string, string>
): Promise<ValidatedChannel> {
  const validator = VALIDATORS[platform];
  if (!validator) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Token-based connect is not supported for ${platform}.`,
    });
  }
  return validator(credentials);
}
