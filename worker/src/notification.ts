import * as settingDB from "./db/setting";
import type { UserRow } from "./db/user";
import { chunkValues, createPlaceholders, extractMentionUsernames, safeJsonParse } from "./validation";

export interface ResendEmailConfig {
  enabled?: boolean;
  apiKey?: string;
  fromEmail?: string;
  fromName?: string;
  replyTo?: string;
}

export interface SendResendEmailOptions {
  apiKey: string;
  fromEmail: string;
  fromName?: string;
  replyTo?: string;
  to: string[];
  subject: string;
  html: string;
}

export type InboxNotificationType = "MEMO_COMMENT" | "MEMO_MENTION";

export interface DeliverInboxNotificationOptions {
  db: D1Database;
  sender: { id: number; username: string };
  receivers: Array<Pick<UserRow, "id" | "username" | "email">>;
  type: InboxNotificationType;
  memoUid: string;
  memoContent: string;
  relatedMemoUid?: string;
  relatedMemoContent?: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export async function sendResendEmail(
  options: SendResendEmailOptions,
): Promise<{ ok: true } | { ok: false; errorText: string }> {
  const from = options.fromName ? `${options.fromName} <${options.fromEmail}>` : options.fromEmail;
  const payload: Record<string, unknown> = {
    from,
    to: options.to,
    subject: options.subject,
    html: options.html,
  };
  if (options.replyTo) {
    payload.reply_to = options.replyTo;
  }

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      return { ok: false, errorText: await res.text() };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, errorText: error instanceof Error ? error.message : String(error) };
  }
}

export async function getEnabledResendConfig(db: D1Database): Promise<Required<Pick<ResendEmailConfig, "apiKey" | "fromEmail">> & ResendEmailConfig | null> {
  const setting = await settingDB.getInstanceSetting(db, "NOTIFICATION");
  if (!setting) {
    return null;
  }

  const parsed = safeJsonParse<{ email?: ResendEmailConfig }>(setting.value, {});
  const email = parsed.email;
  if (!email?.enabled || !email.apiKey?.trim() || !email.fromEmail?.trim()) {
    return null;
  }

  return {
    ...email,
    apiKey: email.apiKey.trim(),
    fromEmail: email.fromEmail.trim(),
    fromName: email.fromName?.trim() || undefined,
    replyTo: email.replyTo?.trim() || undefined,
  };
}

export async function findActiveMentionedUsers(
  db: D1Database,
  content: string,
  excludeUserIds: Set<number>,
  onlyUsernames?: Set<string>,
): Promise<UserRow[]> {
  const usernames = extractMentionUsernames(content).filter((name) => !onlyUsernames || onlyUsernames.has(name));
  if (usernames.length === 0) {
    return [];
  }

  const matchedUsers: UserRow[] = [];
  const seenIds = new Set<number>();

  for (const chunk of chunkValues(usernames, 900)) {
    const { results } = await db
      .prepare(`SELECT * FROM user WHERE row_status = 'NORMAL' AND LOWER(username) IN (${createPlaceholders(chunk.length)})`)
      .bind(...chunk)
      .all<UserRow>();

    for (const user of results) {
      if (excludeUserIds.has(user.id) || seenIds.has(user.id)) {
        continue;
      }
      seenIds.add(user.id);
      matchedUsers.push(user);
    }
  }

  return matchedUsers;
}

export async function createInboxNotifications(options: DeliverInboxNotificationOptions): Promise<void> {
  if (options.receivers.length === 0) {
    return;
  }

  const message = JSON.stringify({
    type: options.type,
    memo: `memos/${options.memoUid}`,
    relatedMemo: options.relatedMemoUid ? `memos/${options.relatedMemoUid}` : "",
    memoSnippet: options.memoContent.slice(0, 150),
    relatedMemoSnippet: (options.relatedMemoContent || "").slice(0, 150),
  });

  for (const receiver of options.receivers) {
    await options.db
      .prepare("INSERT INTO inbox (sender_id, receiver_id, status, message) VALUES (?, ?, ?, ?)")
      .bind(options.sender.id, receiver.id, "UNREAD", message)
      .run();
  }
}

export async function deliverNotificationEmails(options: DeliverInboxNotificationOptions): Promise<void> {
  const recipients = options.receivers.filter((receiver) => Boolean(receiver.email?.trim()));
  if (recipients.length === 0) {
    return;
  }

  const emailConfig = await getEnabledResendConfig(options.db);
  if (!emailConfig) {
    return;
  }

  const subject =
    options.type === "MEMO_COMMENT"
      ? `${options.sender.username} commented on your memo`
      : `${options.sender.username} mentioned you in a memo`;
  const escapedSender = escapeHtml(options.sender.username);
  const escapedSnippet = escapeHtml(options.memoContent.slice(0, 300));
  const actionLabel = options.type === "MEMO_COMMENT" ? "commented on your memo" : "mentioned you in a memo";
  const html = `<p><strong>@${escapedSender}</strong> ${actionLabel}:</p><blockquote>${escapedSnippet}</blockquote>`;

  await Promise.all(
    recipients.map(async (receiver) => {
      const result = await sendResendEmail({
        apiKey: emailConfig.apiKey,
        fromEmail: emailConfig.fromEmail,
        fromName: emailConfig.fromName,
        replyTo: emailConfig.replyTo,
        to: [receiver.email.trim()],
        subject,
        html,
      });
      if (!result.ok) {
        console.warn(`Failed to deliver ${options.type} notification email to user ${receiver.id}:`, result.errorText);
      }
    }),
  );
}
