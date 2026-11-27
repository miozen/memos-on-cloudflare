import * as webhookDB from "./db/webhook";
import type { UserPayload } from "./types";
import { normalizePublicHttpUrl } from "./validation";

export type MemoWebhookEventType = "memo.created" | "memo.updated" | "memo.deleted";

interface MemoWebhookActor {
  id: number;
  username: string;
  role?: string;
}

interface DeliverMemoWebhookEventOptions {
  db: D1Database;
  creatorId: number;
  eventType: MemoWebhookEventType;
  memo: unknown;
  actor?: MemoWebhookActor;
}

const MAX_WEBHOOK_URL_LENGTH = 2048;
const WEBHOOK_TIMEOUT_MS = 10_000;

export function normalizeWebhookUrl(rawUrl: string | undefined): string | undefined {
  return normalizePublicHttpUrl(rawUrl, MAX_WEBHOOK_URL_LENGTH);
}

export function getWebhookUrlValidationError(rawUrl: string | undefined): string | undefined {
  if (!rawUrl?.trim()) {
    return "url is required";
  }
  if (!normalizeWebhookUrl(rawUrl)) {
    return "url must be a valid public HTTP or HTTPS URL";
  }
  return undefined;
}

function getActorPayload(actor: MemoWebhookActor | undefined) {
  if (!actor) {
    return undefined;
  }
  return {
    id: actor.id,
    name: `users/${actor.username}`,
    username: actor.username,
    role: actor.role,
  };
}

function buildMemoWebhookPayload(eventType: MemoWebhookEventType, memo: unknown, actor?: MemoWebhookActor) {
  return {
    type: eventType,
    createdAt: new Date().toISOString(),
    actor: getActorPayload(actor),
    memo,
  };
}

async function postWebhook(webhook: webhookDB.WebhookRow, payload: unknown) {
  const url = normalizeWebhookUrl(webhook.url);
  if (!url) {
    console.warn(`Skipping webhook ${webhook.id}: invalid URL`);
    return;
  }

  const deliveryId = crypto.randomUUID();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "cfmemos-webhook/1.0",
        "x-memos-event": (payload as { type?: string }).type || "",
        "x-memos-delivery": deliveryId,
        "x-memos-webhook-id": String(webhook.id),
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!response.ok) {
      console.warn(`Webhook ${webhook.id} delivery ${deliveryId} failed with status ${response.status}`);
    }
  } catch (error) {
    console.warn(`Webhook ${webhook.id} delivery ${deliveryId} failed`, error);
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function deliverMemoWebhookEvent(options: DeliverMemoWebhookEventOptions): Promise<void> {
  const webhooks = await webhookDB.listWebhooksByCreatorId(options.db, options.creatorId);
  if (webhooks.length === 0) {
    return;
  }

  const payload = buildMemoWebhookPayload(options.eventType, options.memo, options.actor);
  await Promise.all(webhooks.map((webhook) => postWebhook(webhook, payload)));
}

export function getWebhookActor(user: UserPayload): MemoWebhookActor {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
  };
}
