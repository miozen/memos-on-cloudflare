import { Hono, type Context } from "hono";
import type { Env, UserPayload } from "../types";
import { authRequired, authOptional } from "../middleware/auth";
import * as memoDB from "../db/memo";
import * as relationDB from "../db/relation";
import * as reactionDB from "../db/reaction";
import * as shareDB from "../db/share";
import * as settingDB from "../db/setting";
import { createErrorBody } from "../error";
import { deleteCachedKeys, getCachedJson, putCachedJson, sha256Hex } from "../cache";
import { buildMemoFilterWhere, MemoFilterError } from "../filter/memo-filter";
import { deliverMemoWebhookEvent, getWebhookActor, type MemoWebhookEventType } from "../webhook";
import {
  chunkValues,
  createPlaceholders,
  extractMentionUsernames,
  parseIsoTimestampSeconds,
  parsePageSize,
  parsePageTokenOffset,
  safeJsonParse,
  VALID_MEMO_VISIBILITIES,
  VALID_ROW_STATUSES,
} from "../validation";
import {
  createInboxNotifications,
  deliverNotificationEmails,
  findActiveMentionedUsers,
  type DeliverInboxNotificationOptions,
} from "../notification";
import { findUserById } from "../db/user";

type MemoApp = { Bindings: Env; Variables: { user: UserPayload } };
type MemoContext = Context<MemoApp>;

export const memoRoutes = new Hono<MemoApp>();

const getUtf8ByteLength = (value: string) => new TextEncoder().encode(value).length;

const getMemoContentLengthLimit = async (db: D1Database) => {
  const setting = await settingDB.getInstanceSetting(db, "MEMO_RELATED");
  if (!setting) {
    return 0;
  }
  try {
    const parsed = JSON.parse(setting.value) || {};
    return Number(parsed.contentLengthLimit) || 0;
  } catch {
    return 0;
  }
};

function generateUid(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 22);
}

interface LinkMetadata {
  url?: string;
  title: string;
  description: string;
  image: string;
}

const MAX_LINK_METADATA_BATCH_SIZE = 10;
const MAX_LINK_METADATA_URL_LENGTH = 2048;

function isBlockedLinkMetadataHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!host || host === "localhost" || host.endsWith(".localhost") || host === "metadata.google.internal") {
    return true;
  }
  if (host === "::1" || (host.includes(":") && (host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80:")))) {
    return true;
  }

  const ipv4Parts = host.split(".");
  if (ipv4Parts.length !== 4) {
    return false;
  }

  const octets = ipv4Parts.map((part) => Number(part));
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return false;
  }

  const [first, second] = octets;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}

function normalizeLinkMetadataUrl(rawUrl: string | undefined): string | undefined {
  const trimmedUrl = rawUrl?.trim();
  if (!trimmedUrl || trimmedUrl.length > MAX_LINK_METADATA_URL_LENGTH) {
    return undefined;
  }

  try {
    const url = new URL(trimmedUrl);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || isBlockedLinkMetadataHostname(url.hostname)) {
      return undefined;
    }
    url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

function emptyLinkMetadata(url?: string): LinkMetadata {
  return {
    ...(url ? { url } : {}),
    title: "",
    description: "",
    image: "",
  };
}

function parseMemoPayload(content: string) {
  const tags: string[] = [];
  const tagRegex = /#([a-zA-Z0-9_一-鿿぀-ゟ゠-ヿ/\-]+)/g;
  let match;
  while ((match = tagRegex.exec(content)) !== null) {
    tags.push(match[1]);
  }

  const hasLink = /https?:\/\/[^\s]+/.test(content);
  const hasTaskList = /- \[[ x]\]/.test(content);
  const hasCode = /```[\s\S]*?```/.test(content) || /`[^`]+`/.test(content);
  const hasIncompleteTask = /- \[ \]/.test(content);

  const lines = content.split("\n");
  let title = "";
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed) {
      title = trimmed.replace(/^#+\s*/, "").slice(0, 100);
      break;
    }
  }

  return {
    tags,
    property: { hasLink, hasTaskList, hasCode, hasIncompleteTask, title },
  };
}

function formatMemo(memo: memoDB.MemoRow, creatorUsername?: string) {
  const payload = safeJsonParse<Record<string, any>>(memo.payload, {});
  return {
    name: `memos/${memo.uid}`,
    creator: `users/${creatorUsername || memo.creator_id}`,
    createTime: new Date(memo.created_ts * 1000).toISOString(),
    updateTime: new Date(memo.updated_ts * 1000).toISOString(),
    state: memo.row_status === "ARCHIVED" ? "ARCHIVED" : "NORMAL",
    content: memo.content,
    visibility: memo.visibility,
    pinned: memo.pinned === 1,
    tags: payload.tags || [],
    property: payload.property || {},
    location: payload.location || null,
    parent: payload.parent || "",
  };
}

function getMemoReadDeniedStatus(memo: Pick<memoDB.MemoRow, "visibility" | "creator_id">, user: UserPayload | undefined): 401 | 403 | undefined {
  if (memo.visibility === "PRIVATE" && (!user || user.id !== memo.creator_id)) {
    return 403;
  }
  if (memo.visibility === "PROTECTED" && !user) {
    return 401;
  }
  return undefined;
}

function getMemoReadErrorMessage(status: 401 | 403): string {
  return status === 401 ? "Authentication required" : "Permission denied";
}

function formatMemoRelationSnippet(memo: Pick<memoDB.MemoRow, "uid" | "content" | "visibility" | "creator_id"> | undefined, user: UserPayload | undefined) {
  if (!memo || getMemoReadDeniedStatus(memo, user)) {
    return undefined;
  }
  return { name: `memos/${memo.uid}`, snippet: memo.content.slice(0, 120) };
}

async function getMemoAttachments(db: D1Database, memoId: number, memoUid: string) {
  const { results } = await db.prepare("SELECT * FROM attachment WHERE memo_id = ? ORDER BY created_ts ASC").bind(memoId).all<any>();
  return results.map((att) => ({
    id: att.id,
    name: `attachments/${att.uid}`,
    uid: att.uid,
    createTime: new Date(att.created_ts * 1000).toISOString(),
    updateTime: new Date((att.updated_ts || att.created_ts) * 1000).toISOString(),
    filename: att.filename,
    type: att.type,
    size: att.size,
    memo: `memos/${memoUid}`,
    externalLink: "",
    motionMedia: (() => {
      try {
        return att.payload ? JSON.parse(att.payload).motionMedia : undefined;
      } catch {
        return undefined;
      }
    })(),
  }));
}

async function getMemoRelations(db: D1Database, memoId: number, user?: UserPayload) {
  const relations = await relationDB.listRelations(db, memoId);
  const relationMemoMap = await getMemoSnippetMapByIds(db, relations.flatMap((relation) => [relation.memo_id, relation.related_memo_id]));
  const resolved = relations.map((relation) => {
    const memo = relationMemoMap.get(relation.memo_id);
    const relatedMemo = relationMemoMap.get(relation.related_memo_id);
    const formattedRelation = {
      memo: formatMemoRelationSnippet(memo, user),
      relatedMemo: formatMemoRelationSnippet(relatedMemo, user),
      type: relation.type,
    };
    return formattedRelation.memo && formattedRelation.relatedMemo ? formattedRelation : undefined;
  });
  return resolved.filter((relation) => relation !== undefined);
}

function formatReaction(reaction: reactionDB.ReactionRow, creatorUsername?: string) {
  return {
    id: reaction.id,
    creator: `users/${creatorUsername || reaction.creator_id}`,
    contentId: reaction.content_id,
    reactionType: reaction.reaction_type,
    createTime: new Date(reaction.created_ts * 1000).toISOString(),
  };
}

async function resolveUsernamesByIds(db: D1Database, ids: number[]): Promise<Map<number, string>> {
  const uniqueIds = [...new Set(ids)].filter((id) => Number.isFinite(id));
  const usernameMap = new Map<number, string>();
  if (uniqueIds.length === 0) return usernameMap;

  for (const chunk of chunkValues(uniqueIds, 900)) {
    const { results } = await db.prepare(
      `SELECT id, username FROM user WHERE id IN (${createPlaceholders(chunk.length)})`
    ).bind(...chunk).all<{ id: number; username: string }>();

    for (const user of results) {
      usernameMap.set(user.id, user.username);
    }
  }
  return usernameMap;
}

async function getMemoReactions(db: D1Database, memoUid: string) {
  const reactions = await reactionDB.listReactions(db, memoUid);
  const usernameMap = await resolveUsernamesByIds(db, reactions.map((r) => r.creator_id));
  return reactions.map((r) => formatReaction(r, usernameMap.get(r.creator_id)));
}

function formatShare(share: shareDB.ShareRow, memoUid: string) {
  return {
    name: `memos/${memoUid}/shares/${share.uid}`,
    uid: share.uid,
    createTime: new Date(share.created_ts * 1000).toISOString(),
    expireTime: share.expires_ts ? new Date(share.expires_ts * 1000).toISOString() : null,
  };
}

async function enrichMemo(db: D1Database, memo: memoDB.MemoRow, creatorUsername?: string, user?: UserPayload) {
  const [attachments, relations, reactions] = await Promise.all([
    getMemoAttachments(db, memo.id, memo.uid),
    getMemoRelations(db, memo.id, user),
    getMemoReactions(db, memo.uid),
  ]);
  return {
    ...formatMemo(memo, creatorUsername),
    attachments,
    relations,
    reactions,
  };
}

async function resolveCreatorUsernames(db: D1Database, memos: memoDB.MemoRow[]): Promise<Map<number, string>> {
  return resolveUsernamesByIds(db, memos.map((m) => m.creator_id));
}

async function listAttachmentRowsByMemoIds(db: D1Database, memoIds: number[]) {
  const rows: any[] = [];
  for (const chunk of chunkValues(memoIds, 900)) {
    const { results } = await db.prepare(
      `SELECT * FROM attachment WHERE memo_id IN (${createPlaceholders(chunk.length)}) ORDER BY memo_id ASC, created_ts ASC`
    ).bind(...chunk).all<any>();
    rows.push(...results);
  }
  return rows;
}

async function listRelationRowsByMemoIds(db: D1Database, memoIds: number[]) {
  const rows: relationDB.RelationRow[] = [];
  for (const chunk of chunkValues(memoIds, 450)) {
    const placeholders = createPlaceholders(chunk.length);
    const { results } = await db.prepare(
      `SELECT * FROM memo_relation WHERE memo_id IN (${placeholders}) OR related_memo_id IN (${placeholders})`
    ).bind(...chunk, ...chunk).all<relationDB.RelationRow>();
    rows.push(...results);
  }
  return rows;
}

async function listReactionRowsByContentIds(db: D1Database, contentIds: string[]) {
  const rows: reactionDB.ReactionRow[] = [];
  for (const chunk of chunkValues(contentIds, 900)) {
    const { results } = await db.prepare(
      `SELECT * FROM reaction WHERE content_id IN (${createPlaceholders(chunk.length)}) ORDER BY content_id ASC, created_ts ASC`
    ).bind(...chunk).all<reactionDB.ReactionRow>();
    rows.push(...results);
  }
  return rows;
}

async function getMemoSnippetMapByIds(db: D1Database, memoIds: number[]) {
  const memoMap = new Map<number, Pick<memoDB.MemoRow, "uid" | "content" | "visibility" | "creator_id">>();
  const uniqueIds = [...new Set(memoIds)];
  if (uniqueIds.length === 0) {
    return memoMap;
  }

  for (const chunk of chunkValues(uniqueIds, 900)) {
    const { results } = await db.prepare(
      `SELECT id, uid, content, visibility, creator_id FROM memo WHERE id IN (${createPlaceholders(chunk.length)})`
    ).bind(...chunk).all<memoDB.MemoRow>();
    for (const memo of results) {
      memoMap.set(memo.id, memo);
    }
  }
  return memoMap;
}

async function getMemoRowMapByIds(db: D1Database, memoIds: number[]) {
  const memoMap = new Map<number, memoDB.MemoRow>();
  const uniqueIds = [...new Set(memoIds)].filter((id) => Number.isFinite(id));
  if (uniqueIds.length === 0) {
    return memoMap;
  }

  for (const chunk of chunkValues(uniqueIds, 900)) {
    const { results } = await db.prepare(
      `SELECT * FROM memo WHERE id IN (${createPlaceholders(chunk.length)})`
    ).bind(...chunk).all<memoDB.MemoRow>();
    for (const memo of results) {
      memoMap.set(memo.id, memo);
    }
  }
  return memoMap;
}

async function enrichMemos(db: D1Database, memos: memoDB.MemoRow[], creatorUsernameMap?: Map<number, string>, user?: UserPayload) {
  if (memos.length === 0) {
    return [];
  }

  const memoIds = memos.map((m) => m.id);
  const memoUids = memos.map((m) => m.uid);
  const memoUidById = new Map(memos.map((m) => [m.id, m.uid]));
  const memoIdSet = new Set(memoIds);

  const [
    attachmentRows,
    relationRows,
    reactionRows,
  ] = await Promise.all([
    listAttachmentRowsByMemoIds(db, memoIds),
    listRelationRowsByMemoIds(db, memoIds),
    listReactionRowsByContentIds(db, memoUids),
  ]);

  const attachmentsByMemoId = new Map<number, any[]>();
  for (const att of attachmentRows) {
    const memoUid = memoUidById.get(att.memo_id);
    if (!memoUid) continue;
    const attachments = attachmentsByMemoId.get(att.memo_id) || [];
    attachments.push({
      id: att.id,
      name: `attachments/${att.uid}`,
      uid: att.uid,
      createTime: new Date(att.created_ts * 1000).toISOString(),
      updateTime: new Date((att.updated_ts || att.created_ts) * 1000).toISOString(),
      filename: att.filename,
      type: att.type,
      size: att.size,
      memo: `memos/${memoUid}`,
      externalLink: "",
      motionMedia: (() => {
        try {
          return att.payload ? JSON.parse(att.payload).motionMedia : undefined;
        } catch {
          return undefined;
        }
      })(),
    });
    attachmentsByMemoId.set(att.memo_id, attachments);
  }

  const relationMemoIds = relationRows.flatMap((relation) => [relation.memo_id, relation.related_memo_id]);
  const relationMemoMap = await getMemoSnippetMapByIds(db, relationMemoIds);

  const relationsByMemoId = new Map<number, any[]>();
  for (const relation of relationRows) {
    const memo = relationMemoMap.get(relation.memo_id);
    const relatedMemo = relationMemoMap.get(relation.related_memo_id);
    const formattedRelation = {
      memo: formatMemoRelationSnippet(memo, user),
      relatedMemo: formatMemoRelationSnippet(relatedMemo, user),
      type: relation.type,
    };
    if (!formattedRelation.memo || !formattedRelation.relatedMemo) {
      continue;
    }

    if (memoIdSet.has(relation.memo_id)) {
      const relations = relationsByMemoId.get(relation.memo_id) || [];
      relations.push(formattedRelation);
      relationsByMemoId.set(relation.memo_id, relations);
    }
    if (memoIdSet.has(relation.related_memo_id) && relation.related_memo_id !== relation.memo_id) {
      const relations = relationsByMemoId.get(relation.related_memo_id) || [];
      relations.push(formattedRelation);
      relationsByMemoId.set(relation.related_memo_id, relations);
    }
  }

  const reactionUsernameMap = await resolveUsernamesByIds(db, reactionRows.map((r) => r.creator_id));
  const reactionsByContentId = new Map<string, ReturnType<typeof formatReaction>[]>();
  for (const reaction of reactionRows) {
    const reactions = reactionsByContentId.get(reaction.content_id) || [];
    reactions.push(formatReaction(reaction, reactionUsernameMap.get(reaction.creator_id)));
    reactionsByContentId.set(reaction.content_id, reactions);
  }

  return memos.map((memo) => ({
    ...formatMemo(memo, creatorUsernameMap?.get(memo.creator_id)),
    attachments: attachmentsByMemoId.get(memo.id) || [],
    relations: relationsByMemoId.get(memo.id) || [],
    reactions: reactionsByContentId.get(memo.uid) || [],
  }));
}

async function invalidateMemoDerivedCaches(cache: KVNamespace | undefined, usernames: Array<string | undefined>) {
  const keys = ["user:stats:all", "user:stats:all:public", "instance:stats"];
  for (const username of usernames) {
    if (username) {
      keys.push(`user:stats:${username}`);
      keys.push(`user:stats:${username}:public`);
      keys.push(`user:stats:${username}:authenticated`);
      keys.push(`user:stats:${username}:owner`);
    }
  }
  await deleteCachedKeys(cache, keys);
}

function runInBackground(c: MemoContext, task: Promise<unknown>) {
  try {
    c.executionCtx.waitUntil(task);
  } catch {
    void task.catch((error) => {
      console.warn("Background task failed", error);
    });
  }
}

function enqueueMemoWebhook(
  c: MemoContext,
  eventType: MemoWebhookEventType,
  creatorId: number,
  memo: unknown,
  actor: UserPayload,
) {
  runInBackground(
    c,
    deliverMemoWebhookEvent({
      db: c.env.DB,
      creatorId,
      eventType,
      memo,
      actor: getWebhookActor(actor),
    }),
  );
}

async function notifyMentionedUsers(
  c: MemoContext,
  options: {
    sender: UserPayload;
    visibility: string;
    content: string;
    memoUid: string;
    relatedMemoUid?: string;
    relatedMemoContent?: string;
    excludeUserIds?: Set<number>;
    onlyUsernames?: Set<string>;
  },
) {
  if (options.visibility === "PRIVATE") {
    return;
  }

  const excludeUserIds = new Set(options.excludeUserIds);
  excludeUserIds.add(options.sender.id);
  const receivers = await findActiveMentionedUsers(
    c.env.DB,
    options.content,
    excludeUserIds,
    options.onlyUsernames,
  );
  if (receivers.length === 0) {
    return;
  }

  const notificationOptions: DeliverInboxNotificationOptions = {
    db: c.env.DB,
    sender: { id: options.sender.id, username: options.sender.username },
    receivers,
    type: "MEMO_MENTION",
    memoUid: options.memoUid,
    memoContent: options.content,
    relatedMemoUid: options.relatedMemoUid,
    relatedMemoContent: options.relatedMemoContent,
  };
  await createInboxNotifications(notificationOptions);
  runInBackground(c, deliverNotificationEmails(notificationOptions));
}

function getAttachmentReference(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value && typeof value === "object") {
    const attachment = value as { name?: unknown; uid?: unknown; id?: unknown };
    if (typeof attachment.name === "string") return attachment.name;
    if (typeof attachment.uid === "string") return attachment.uid;
    if (typeof attachment.id === "number" || typeof attachment.id === "string") return String(attachment.id);
  }
  return "";
}

async function getLinkMetadata(env: Env, url: string, includeUrl = false): Promise<LinkMetadata> {
  const cacheKey = `link-metadata:${await sha256Hex(url)}`;
  const cached = await getCachedJson<LinkMetadata>(env.CACHE, cacheKey);
  if (cached) {
    return includeUrl ? { ...cached, url } : cached;
  }

  let metadata: LinkMetadata;
  try {
    const resp = await fetch(url, {
      headers: { "User-Agent": "cfmemos-bot/1.0" },
      redirect: "follow",
    });
    const html = await resp.text();

    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    const descMatch = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i);
    const imageMatch = html.match(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/i);

    metadata = {
      title: titleMatch?.[1]?.trim() || "",
      description: descMatch?.[1]?.trim() || "",
      image: imageMatch?.[1]?.trim() || "",
    };
  } catch {
    metadata = { title: "", description: "", image: "" };
  }

  await putCachedJson(env.CACHE, cacheKey, metadata, 60 * 60 * 24 * 14);
  return includeUrl ? { ...metadata, url } : metadata;
}

async function resolveAttachmentIds(db: D1Database, user: UserPayload, references: unknown[]): Promise<number[]> {
  const ids: number[] = [];
  const seen = new Set<number>();
  const tokens: string[] = [];

  for (const referenceValue of references) {
    const reference = getAttachmentReference(referenceValue);
    if (!reference) continue;

    const token = reference.startsWith("attachments/") ? reference.slice("attachments/".length) : reference;
    tokens.push(token);
  }

  const uniqueTokens = [...new Set(tokens)];
  if (uniqueTokens.length === 0) {
    return ids;
  }

  const rowsByUid = new Map<string, { id: number; uid: string; creator_id: number }>();
  const rowsById = new Map<number, { id: number; uid: string; creator_id: number }>();

  for (const tokenChunk of chunkValues(uniqueTokens, 450)) {
    const numericIds = tokenChunk
      .map((token) => Number(token))
      .filter((id) => Number.isInteger(id) && id > 0);
    const uidPlaceholders = createPlaceholders(tokenChunk.length);
    const conditions = [`uid IN (${uidPlaceholders})`];
    const params: Array<string | number> = [...tokenChunk];

    if (numericIds.length > 0) {
      conditions.push(`id IN (${createPlaceholders(numericIds.length)})`);
      params.push(...numericIds);
    }

    const { results } = await db.prepare(
      `SELECT id, uid, creator_id FROM attachment WHERE ${conditions.join(" OR ")}`
    ).bind(...params).all<{ id: number; uid: string; creator_id: number }>();

    for (const row of results) {
      rowsByUid.set(row.uid, row);
      rowsById.set(row.id, row);
    }
  }

  for (const token of tokens) {
    const row = rowsByUid.get(token) || rowsById.get(Number(token));
    if (!row) continue;
    if (row.creator_id !== user.id && user.role !== "ADMIN") continue;
    if (!seen.has(row.id)) {
      ids.push(row.id);
      seen.add(row.id);
    }
  }

  return ids;
}

async function setMemoAttachments(db: D1Database, memoId: number, user: UserPayload, references: unknown[]) {
  const attachmentIds = await resolveAttachmentIds(db, user, references);

  await db.prepare("UPDATE attachment SET memo_id = NULL WHERE memo_id = ?").bind(memoId).run();
  if (attachmentIds.length === 0) {
    return;
  }

  for (const chunk of chunkValues(attachmentIds, 900)) {
    const placeholders = createPlaceholders(chunk.length);
    if (user.role === "ADMIN") {
      await db.prepare(`UPDATE attachment SET memo_id = ? WHERE id IN (${placeholders})`).bind(memoId, ...chunk).run();
    } else {
      await db.prepare(`UPDATE attachment SET memo_id = ? WHERE id IN (${placeholders}) AND creator_id = ?`).bind(memoId, ...chunk, user.id).run();
    }
  }
}

// Create memo
memoRoutes.post("/", authRequired, async (c) => {
  const user = c.get("user");
  const body = await c.req.json();
  const { content, visibility, createTime, updateTime, location } = body;

  if (typeof content !== "string") {
    return c.json({ error: "Content is required" }, 400);
  }

  const nextVisibility = visibility ?? "PRIVATE";
  if (typeof nextVisibility !== "string" || !VALID_MEMO_VISIBILITIES.has(nextVisibility)) {
    return c.json({ error: "Invalid visibility" }, 400);
  }

  const createdTs = parseIsoTimestampSeconds(createTime);
  if (createdTs === null) {
    return c.json({ error: "Invalid createTime" }, 400);
  }
  const updatedTs = parseIsoTimestampSeconds(updateTime);
  if (updatedTs === null) {
    return c.json({ error: "Invalid updateTime" }, 400);
  }

  const contentLengthLimit = await getMemoContentLengthLimit(c.env.DB);
  if (contentLengthLimit > 0 && getUtf8ByteLength(content) > contentLengthLimit) {
    return c.json(
      createErrorBody(`Memo content exceeds the maximum allowed length of ${contentLengthLimit} bytes.`, {
        errorKey: "message.memo-content-too-long",
        errorParams: { size: contentLengthLimit },
      }),
      400,
    );
  }

  const uid = generateUid();
  const payload = {
    ...parseMemoPayload(content),
    ...(location ? { location } : {}),
  };

  const memo = await memoDB.createMemo(c.env.DB, {
    uid,
    creatorId: user.id,
    content,
    visibility: nextVisibility,
    payload: JSON.stringify(payload),
    createdTs,
    updatedTs,
  });

  if (Array.isArray(body.attachments) && body.attachments.length > 0) {
    await setMemoAttachments(c.env.DB, memo.id, user, body.attachments);
  }

  await notifyMentionedUsers(c, {
    sender: user,
    visibility: memo.visibility,
    content: memo.content,
    memoUid: memo.uid,
  });

  await invalidateMemoDerivedCaches(c.env.CACHE, [user.username]);
  const enrichedMemo = await enrichMemo(c.env.DB, memo, user.username, user);
  enqueueMemoWebhook(c, "memo.created", memo.creator_id, enrichedMemo, user);
  return c.json(enrichedMemo, 201);
});

// List memos
memoRoutes.get("/", authOptional, async (c) => {
  const user = c.get("user");
  const pageSize = parsePageSize(c.req.query("pageSize"));
  const pageToken = c.req.query("pageToken");
  const filter = c.req.query("filter") || "";
  const orderBy = c.req.query("orderBy") || "";
  const state = c.req.query("state") || "NORMAL";
  const offset = parsePageTokenOffset(pageToken);

  const opts: memoDB.ListMemosOpts = {
    pageSize,
    offset,
    orderBy,
    rowStatus: state === "ARCHIVED" ? "ARCHIVED" : "NORMAL",
    excludeComments: true,
  };

  if (filter) {
    try {
      const compiledFilter = await buildMemoFilterWhere(c.env.DB, filter);
      opts.filterWhere = compiledFilter.sql;
      opts.filterParams = compiledFilter.params;
    } catch (error) {
      const message = error instanceof MemoFilterError ? error.message : "Invalid memo filter";
      return c.json(
        createErrorBody(message, {
          errorKey: "message.invalid-memo-filter",
          errorParams: { filter },
        }),
        400,
      );
    }
  }

  if (!user) {
    opts.visibility = "PUBLIC";
  } else {
    opts.readableByUserId = user.id;
  }

  const { memos, total } = await memoDB.listMemos(c.env.DB, opts);

  const nextPageToken = offset + pageSize < total ? btoa(String(offset + pageSize)) : "";

  const usernameMap = await resolveCreatorUsernames(c.env.DB, memos);

  return c.json({
    memos: await enrichMemos(c.env.DB, memos, usernameMap, user),
    nextPageToken,
    totalSize: total,
  });
});

// Get memo by ID (supports both numeric id and uid)
memoRoutes.get("/:id", authOptional, async (c) => {
  const id = c.req.param("id");
  const user = c.get("user");

  let memo: memoDB.MemoRow | null;
  if (/^\d+$/.test(id)) {
    memo = await memoDB.getMemoById(c.env.DB, Number(id));
  } else {
    memo = await memoDB.getMemoByUid(c.env.DB, id);
  }

  if (!memo) {
    return c.json({ error: "Memo not found" }, 404);
  }

  const deniedStatus = getMemoReadDeniedStatus(memo, user);
  if (deniedStatus) {
    return c.json({ error: getMemoReadErrorMessage(deniedStatus) }, deniedStatus);
  }

  const creatorUser = await c.env.DB.prepare("SELECT username FROM user WHERE id = ?").bind(memo.creator_id).first<{ username: string }>();
  return c.json(await enrichMemo(c.env.DB, memo, creatorUser?.username, user));
});

// Update memo
memoRoutes.patch("/:id", authRequired, async (c) => {
  const id = c.req.param("id");
  const user = c.get("user");
  const body = await c.req.json();

  let memo: memoDB.MemoRow | null;
  if (/^\d+$/.test(id)) {
    memo = await memoDB.getMemoById(c.env.DB, Number(id));
  } else {
    memo = await memoDB.getMemoByUid(c.env.DB, id);
  }

  if (!memo) {
    return c.json({ error: "Memo not found" }, 404);
  }
  if (memo.creator_id !== user.id && user.role !== "ADMIN") {
    return c.json({ error: "Permission denied" }, 403);
  }

  const updateData: Parameters<typeof memoDB.updateMemo>[2] = {};

  if (body.content !== undefined) {
    if (typeof body.content !== "string") {
      return c.json({ error: "Content must be a string" }, 400);
    }
    const contentLengthLimit = await getMemoContentLengthLimit(c.env.DB);
    if (contentLengthLimit > 0 && getUtf8ByteLength(body.content) > contentLengthLimit) {
      return c.json(
        createErrorBody(`Memo content exceeds the maximum allowed length of ${contentLengthLimit} bytes.`, {
          errorKey: "message.memo-content-too-long",
          errorParams: { size: contentLengthLimit },
        }),
        400,
      );
    }
    updateData.content = body.content;
    const payload = parseMemoPayload(body.content);
    const existingPayload = safeJsonParse<Record<string, any>>(memo.payload, {});
    updateData.payload = JSON.stringify({ ...existingPayload, ...payload });
  }
  if (body.location !== undefined) {
    const existingPayload = safeJsonParse<Record<string, any>>((updateData.payload as string) || memo.payload, {});
    updateData.payload = JSON.stringify({
      ...existingPayload,
      ...(body.location ? { location: body.location } : { location: null }),
    });
  }
  if (body.visibility !== undefined) {
    if (typeof body.visibility !== "string" || !VALID_MEMO_VISIBILITIES.has(body.visibility)) {
      return c.json({ error: "Invalid visibility" }, 400);
    }
    updateData.visibility = body.visibility;
  }
  if (body.pinned !== undefined) updateData.pinned = body.pinned ? 1 : 0;
  if (body.rowStatus !== undefined) {
    if (typeof body.rowStatus !== "string" || !VALID_ROW_STATUSES.has(body.rowStatus)) {
      return c.json({ error: "Invalid rowStatus" }, 400);
    }
    updateData.row_status = body.rowStatus;
  }
  if (body.createTime !== undefined) {
    const createdTs = parseIsoTimestampSeconds(body.createTime);
    if (createdTs === null) {
      return c.json({ error: "Invalid createTime" }, 400);
    }
    if (createdTs !== undefined) {
      updateData.created_ts = createdTs;
    }
  }
  if (body.updateTime !== undefined) {
    const updatedTs = parseIsoTimestampSeconds(body.updateTime);
    if (updatedTs === null) {
      return c.json({ error: "Invalid updateTime" }, 400);
    }
    if (updatedTs !== undefined) {
      updateData.updated_ts = updatedTs;
    }
  }

  const updated = await memoDB.updateMemo(c.env.DB, memo.id, updateData);
  if (!updated) {
    return c.json({ error: "Update failed" }, 500);
  }

  if (body.content !== undefined) {
    const previousMentions = new Set(extractMentionUsernames(memo.content));
    const newlyMentioned = new Set(
      extractMentionUsernames(updated.content).filter((name) => !previousMentions.has(name)),
    );
    if (newlyMentioned.size > 0) {
      await notifyMentionedUsers(c, {
        sender: user,
        visibility: updated.visibility,
        content: updated.content,
        memoUid: updated.uid,
        onlyUsernames: newlyMentioned,
      });
    }
  }

  const creatorName = updated.creator_id === user.id ? user.username : (await c.env.DB.prepare("SELECT username FROM user WHERE id = ?").bind(updated.creator_id).first<{ username: string }>())?.username;
  await invalidateMemoDerivedCaches(c.env.CACHE, [creatorName]);
  const enrichedMemo = await enrichMemo(c.env.DB, updated, creatorName, user);
  enqueueMemoWebhook(c, "memo.updated", updated.creator_id, enrichedMemo, user);
  return c.json(enrichedMemo);
});

// Delete memo
memoRoutes.delete("/:id", authRequired, async (c) => {
  const id = c.req.param("id");
  const user = c.get("user");

  let memo: memoDB.MemoRow | null;
  if (/^\d+$/.test(id)) {
    memo = await memoDB.getMemoById(c.env.DB, Number(id));
  } else {
    memo = await memoDB.getMemoByUid(c.env.DB, id);
  }

  if (!memo) {
    return c.json({ error: "Memo not found" }, 404);
  }
  if (memo.creator_id !== user.id && user.role !== "ADMIN") {
    return c.json({ error: "Permission denied" }, 403);
  }

  const creatorName = memo.creator_id === user.id ? user.username : (await c.env.DB.prepare("SELECT username FROM user WHERE id = ?").bind(memo.creator_id).first<{ username: string }>())?.username;
  const deletedMemo = await enrichMemo(c.env.DB, memo, creatorName, user);

  // Collect the target memo and any descendant comment memos so deleting does not leave orphan rows or R2 objects.
  const memoIdsToDelete: number[] = [memo.id];
  const seenMemoIds = new Set<number>([memo.id]);
  let frontier = [memo.id];

  while (frontier.length > 0) {
    const nextFrontier: number[] = [];
    for (const chunk of chunkValues(frontier, 900)) {
      const { results } = await c.env.DB.prepare(
        `SELECT related_memo_id FROM memo_relation WHERE type = 'COMMENT' AND memo_id IN (${createPlaceholders(chunk.length)})`
      ).bind(...chunk).all<{ related_memo_id: number }>();
      for (const row of results) {
        if (!seenMemoIds.has(row.related_memo_id)) {
          seenMemoIds.add(row.related_memo_id);
          memoIdsToDelete.push(row.related_memo_id);
          nextFrontier.push(row.related_memo_id);
        }
      }
    }
    frontier = nextFrontier;
  }

  const memoRowsMap = await getMemoRowMapByIds(c.env.DB, memoIdsToDelete);
  const memoUids = [...memoRowsMap.values()].map((row) => row.uid);
  const creatorIds = [...memoRowsMap.values()].map((row) => row.creator_id);
  const affectedUsernames = await resolveUsernamesByIds(c.env.DB, creatorIds);

  const attachmentRows = await listAttachmentRowsByMemoIds(c.env.DB, memoIdsToDelete);
  const r2Keys = attachmentRows.map((att) => att.reference).filter((ref): ref is string => Boolean(ref));

  for (const chunk of chunkValues(memoIdsToDelete, 900)) {
    await c.env.DB.prepare(`DELETE FROM attachment WHERE memo_id IN (${createPlaceholders(chunk.length)})`).bind(...chunk).run();
  }
  for (const chunk of chunkValues(memoIdsToDelete, 450)) {
    const placeholders = createPlaceholders(chunk.length);
    await c.env.DB.prepare(
      `DELETE FROM memo_relation WHERE memo_id IN (${placeholders}) OR related_memo_id IN (${placeholders})`
    ).bind(...chunk, ...chunk).run();
  }
  for (const chunk of chunkValues(memoUids, 900)) {
    await c.env.DB.prepare(`DELETE FROM reaction WHERE content_id IN (${createPlaceholders(chunk.length)})`).bind(...chunk).run();
  }
  for (const chunk of chunkValues(memoIdsToDelete, 900)) {
    await c.env.DB.prepare(`DELETE FROM memo WHERE id IN (${createPlaceholders(chunk.length)})`).bind(...chunk).run();
  }

  if (r2Keys.length > 0) {
    await Promise.allSettled(r2Keys.map((key) => c.env.BUCKET.delete(key)));
  }

  await invalidateMemoDerivedCaches(c.env.CACHE, [creatorName, ...affectedUsernames.values()]);
  enqueueMemoWebhook(c, "memo.deleted", memo.creator_id, deletedMemo, user);
  return c.json({});
});

// --- Memo Relations ---
memoRoutes.get("/:id/relations", authOptional, async (c) => {
  const id = c.req.param("id");
  const user = c.get("user");
  const memo = /^\d+$/.test(id)
    ? await memoDB.getMemoById(c.env.DB, Number(id))
    : await memoDB.getMemoByUid(c.env.DB, id);
  if (!memo) return c.json({ error: "Memo not found" }, 404);
  const deniedStatus = getMemoReadDeniedStatus(memo, user);
  if (deniedStatus) {
    return c.json({ error: getMemoReadErrorMessage(deniedStatus) }, deniedStatus);
  }

  const relations = await relationDB.listRelations(c.env.DB, memo.id);
  const otherMemoIds = relations.map((relation) => relation.memo_id === memo.id ? relation.related_memo_id : relation.memo_id);
  const otherMemoMap = await getMemoSnippetMapByIds(c.env.DB, otherMemoIds);
  const visibleRelations: relationDB.RelationRow[] = [];
  for (const relation of relations) {
    const otherMemoId = relation.memo_id === memo.id ? relation.related_memo_id : relation.memo_id;
    const otherMemo = otherMemoMap.get(otherMemoId);
    if (!otherMemo || !getMemoReadDeniedStatus(otherMemo, user)) {
      visibleRelations.push(relation);
    }
  }
  return c.json({ relations: visibleRelations });
});

memoRoutes.patch("/:id/relations", authRequired, async (c) => {
  const id = c.req.param("id");
  const user = c.get("user");
  const memo = /^\d+$/.test(id)
    ? await memoDB.getMemoById(c.env.DB, Number(id))
    : await memoDB.getMemoByUid(c.env.DB, id);
  if (!memo) return c.json({ error: "Memo not found" }, 404);
  if (memo.creator_id !== user.id && user.role !== "ADMIN") {
    return c.json({ error: "Permission denied" }, 403);
  }

  const body = await c.req.json<{ relations: { relatedMemoId: number; type: string }[] }>();
  await relationDB.setRelations(c.env.DB, memo.id, body.relations || []);
  const relations = await relationDB.listRelations(c.env.DB, memo.id);
  return c.json({ relations });
});

// --- Memo Comments ---
memoRoutes.post("/:id/comments", authRequired, async (c) => {
  const id = c.req.param("id");
  const user = c.get("user");
  const parentMemo = /^\d+$/.test(id)
    ? await memoDB.getMemoById(c.env.DB, Number(id))
    : await memoDB.getMemoByUid(c.env.DB, id);
  if (!parentMemo) return c.json({ error: "Memo not found" }, 404);
  const deniedStatus = getMemoReadDeniedStatus(parentMemo, user);
  if (deniedStatus) {
    return c.json({ error: getMemoReadErrorMessage(deniedStatus) }, deniedStatus);
  }

  const body = await c.req.json();
  const commentContent = body.content ?? "";
  if (typeof commentContent !== "string") {
    return c.json({ error: "Content must be a string" }, 400);
  }

  const commentVisibility = body.visibility ?? parentMemo.visibility;
  if (typeof commentVisibility !== "string" || !VALID_MEMO_VISIBILITIES.has(commentVisibility)) {
    return c.json({ error: "Invalid visibility" }, 400);
  }

  const contentLengthLimit = await getMemoContentLengthLimit(c.env.DB);
  if (contentLengthLimit > 0 && getUtf8ByteLength(commentContent) > contentLengthLimit) {
    return c.json(
      createErrorBody(`Memo content exceeds the maximum allowed length of ${contentLengthLimit} bytes.`, {
        errorKey: "message.memo-content-too-long",
        errorParams: { size: contentLengthLimit },
      }),
      400,
    );
  }

  const uid = generateUid();
  const payload = {
    ...parseMemoPayload(commentContent),
    ...(body.location ? { location: body.location } : {}),
  };

  const comment = await memoDB.createMemo(c.env.DB, {
    uid,
    creatorId: user.id,
    content: commentContent,
    visibility: commentVisibility,
    payload: JSON.stringify({
      ...payload,
      parent: `memos/${parentMemo.uid}`,
    }),
  });

  if (Array.isArray(body.attachments) && body.attachments.length > 0) {
    await setMemoAttachments(c.env.DB, comment.id, user, body.attachments);
  }

  await relationDB.createRelation(c.env.DB, {
    memoId: parentMemo.id,
    relatedMemoId: comment.id,
    type: "COMMENT",
  });

  const excludeMentions = new Set<number>([user.id]);
  if (parentMemo.creator_id !== user.id) {
    const parentAuthor = await findUserById(c.env.DB, parentMemo.creator_id);
    if (parentAuthor && parentAuthor.row_status === "NORMAL") {
      excludeMentions.add(parentAuthor.id);
      const commentNotification: DeliverInboxNotificationOptions = {
        db: c.env.DB,
        sender: { id: user.id, username: user.username },
        receivers: [parentAuthor],
        type: "MEMO_COMMENT",
        memoUid: comment.uid,
        memoContent: comment.content,
        relatedMemoUid: parentMemo.uid,
        relatedMemoContent: parentMemo.content,
      };
      await createInboxNotifications(commentNotification);
      runInBackground(c, deliverNotificationEmails(commentNotification));
    }
  }

  await notifyMentionedUsers(c, {
    sender: user,
    visibility: comment.visibility,
    content: comment.content,
    memoUid: comment.uid,
    relatedMemoUid: parentMemo.uid,
    relatedMemoContent: parentMemo.content,
    excludeUserIds: excludeMentions,
  });

  await invalidateMemoDerivedCaches(c.env.CACHE, [user.username]);
  const enrichedComment = await enrichMemo(c.env.DB, comment, user.username, user);
  enqueueMemoWebhook(c, "memo.created", comment.creator_id, enrichedComment, user);
  return c.json(enrichedComment, 201);
});

memoRoutes.get("/:id/comments", authOptional, async (c) => {
  const id = c.req.param("id");
  const user = c.get("user");
  const memo = /^\d+$/.test(id)
    ? await memoDB.getMemoById(c.env.DB, Number(id))
    : await memoDB.getMemoByUid(c.env.DB, id);
  if (!memo) return c.json({ error: "Memo not found" }, 404);
  const deniedStatus = getMemoReadDeniedStatus(memo, user);
  if (deniedStatus) {
    return c.json({ error: getMemoReadErrorMessage(deniedStatus) }, deniedStatus);
  }

  const relations = await relationDB.listRelations(c.env.DB, memo.id);
  const commentRelations = relations.filter((r) => r.type === "COMMENT");
  const commentMap = await getMemoRowMapByIds(c.env.DB, commentRelations.map((rel) => rel.related_memo_id));
  const comments: memoDB.MemoRow[] = [];
  for (const rel of commentRelations) {
    const comment = commentMap.get(rel.related_memo_id);
    if (comment && !getMemoReadDeniedStatus(comment, user)) comments.push(comment);
  }

  const usernameMap = await resolveCreatorUsernames(c.env.DB, comments);
  return c.json({
    memos: await enrichMemos(c.env.DB, comments, usernameMap, user),
    nextPageToken: "",
    totalSize: comments.length,
  });
});

// --- Memo Reactions ---
memoRoutes.get("/:id/reactions", authOptional, async (c) => {
  const id = c.req.param("id");
  const user = c.get("user");
  const memo = /^\d+$/.test(id)
    ? await memoDB.getMemoById(c.env.DB, Number(id))
    : await memoDB.getMemoByUid(c.env.DB, id);
  if (!memo) return c.json({ error: "Memo not found" }, 404);
  const deniedStatus = getMemoReadDeniedStatus(memo, user);
  if (deniedStatus) {
    return c.json({ error: getMemoReadErrorMessage(deniedStatus) }, deniedStatus);
  }

  const reactions = await getMemoReactions(c.env.DB, memo.uid);
  return c.json({ reactions });
});

memoRoutes.post("/:id/reactions", authRequired, async (c) => {
  const id = c.req.param("id");
  const user = c.get("user");
  const memo = /^\d+$/.test(id)
    ? await memoDB.getMemoById(c.env.DB, Number(id))
    : await memoDB.getMemoByUid(c.env.DB, id);
  if (!memo) return c.json({ error: "Memo not found" }, 404);
  const deniedStatus = getMemoReadDeniedStatus(memo, user);
  if (deniedStatus) {
    return c.json({ error: getMemoReadErrorMessage(deniedStatus) }, deniedStatus);
  }

  const body = await c.req.json<{ reactionType: string }>();
  const reaction = await reactionDB.upsertReaction(c.env.DB, {
    creatorId: user.id,
    contentId: memo.uid,
    reactionType: body.reactionType,
  });
  return c.json(formatReaction(reaction, user.username));
});

memoRoutes.delete("/:id/reactions/:reactionId", authRequired, async (c) => {
  const reactionId = Number(c.req.param("reactionId"));
  const user = c.get("user");

  await reactionDB.deleteReaction(c.env.DB, reactionId, user.id);
  return c.json({});
});

// --- Memo Shares ---
memoRoutes.get("/:id/shares", authRequired, async (c) => {
  const id = c.req.param("id");
  const user = c.get("user");
  const memo = /^\d+$/.test(id)
    ? await memoDB.getMemoById(c.env.DB, Number(id))
    : await memoDB.getMemoByUid(c.env.DB, id);
  if (!memo) return c.json({ error: "Memo not found" }, 404);
  if (memo.creator_id !== user.id && user.role !== "ADMIN") {
    return c.json({ error: "Permission denied" }, 403);
  }

  const shares = await shareDB.listShares(c.env.DB, memo.id);
  return c.json({ shares: shares.map((s) => formatShare(s, memo.uid)) });
});

memoRoutes.post("/:id/shares", authRequired, async (c) => {
  const id = c.req.param("id");
  const user = c.get("user");
  const memo = /^\d+$/.test(id)
    ? await memoDB.getMemoById(c.env.DB, Number(id))
    : await memoDB.getMemoByUid(c.env.DB, id);
  if (!memo) return c.json({ error: "Memo not found" }, 404);
  if (memo.creator_id !== user.id && user.role !== "ADMIN") {
    return c.json({ error: "Permission denied" }, 403);
  }

  const body = await c.req.json<{ expiresTs?: number }>();
  const share = await shareDB.createShare(c.env.DB, {
    memoId: memo.id,
    creatorId: user.id,
    expiresTs: body.expiresTs,
  });
  return c.json(formatShare(share, memo.uid));
});

memoRoutes.delete("/:id/shares/:shareId", authRequired, async (c) => {
  const id = c.req.param("id");
  const shareId = c.req.param("shareId");
  const user = c.get("user");
  const memo = /^\d+$/.test(id)
    ? await memoDB.getMemoById(c.env.DB, Number(id))
    : await memoDB.getMemoByUid(c.env.DB, id);
  if (!memo) return c.json({ error: "Memo not found" }, 404);
  if (memo.creator_id !== user.id && user.role !== "ADMIN") {
    return c.json({ error: "Permission denied" }, 403);
  }

  await shareDB.deleteShare(c.env.DB, shareId, memo.id);
  return c.json({});
});

// --- Memo Attachments ---
memoRoutes.get("/:id/attachments", authOptional, async (c) => {
  const id = c.req.param("id");
  const user = c.get("user");
  const memo = /^\d+$/.test(id)
    ? await memoDB.getMemoById(c.env.DB, Number(id))
    : await memoDB.getMemoByUid(c.env.DB, id);
  if (!memo) return c.json({ error: "Memo not found" }, 404);
  const deniedStatus = getMemoReadDeniedStatus(memo, user);
  if (deniedStatus) {
    return c.json({ error: getMemoReadErrorMessage(deniedStatus) }, deniedStatus);
  }

  const attachments = await getMemoAttachments(c.env.DB, memo.id, memo.uid);
  return c.json({ attachments });
});

memoRoutes.patch("/:id/attachments", authRequired, async (c) => {
  const id = c.req.param("id");
  const user = c.get("user");
  const memo = /^\d+$/.test(id)
    ? await memoDB.getMemoById(c.env.DB, Number(id))
    : await memoDB.getMemoByUid(c.env.DB, id);
  if (!memo) return c.json({ error: "Memo not found" }, 404);
  if (memo.creator_id !== user.id && user.role !== "ADMIN") {
    return c.json({ error: "Permission denied" }, 403);
  }

  const body = await c.req.json<{ attachmentIds?: Array<number | string>; attachments?: unknown[] }>();
  await setMemoAttachments(c.env.DB, memo.id, user, body.attachments || body.attachmentIds || []);

  return c.json({});
});

// --- Get memo by share token ---
memoRoutes.get("/shares/:token", async (c) => {
  const token = c.req.param("token");
  const share = await shareDB.getShareByUid(c.env.DB, token);

  if (!share) {
    return c.json({ error: "Share not found" }, 404);
  }

  if (share.expires_ts && share.expires_ts < Math.floor(Date.now() / 1000)) {
    return c.json({ error: "Share expired" }, 410);
  }

  const memo = await memoDB.getMemoById(c.env.DB, share.memo_id);
  if (!memo) {
    return c.json({ error: "Memo not found" }, 404);
  }

  const creatorUser = await c.env.DB.prepare("SELECT username FROM user WHERE id = ?").bind(memo.creator_id).first<{ username: string }>();
  return c.json(await enrichMemo(c.env.DB, memo, creatorUser?.username));
});

// --- Link metadata ---
memoRoutes.get("/-/linkMetadata", async (c) => {
  const url = normalizeLinkMetadataUrl(c.req.query("url"));
  if (!url) return c.json({ error: "URL required" }, 400);

  return c.json(await getLinkMetadata(c.env, url));
});

memoRoutes.post("/-/linkMetadata\\:batchGet", async (c) => {
  const body = await c.req.json<{ urls: string[] }>();
  const urls = (body.urls || []).slice(0, MAX_LINK_METADATA_BATCH_SIZE);

  const linkMetadata = await Promise.all(
    urls.map((url) => {
      const normalizedUrl = normalizeLinkMetadataUrl(url);
      return normalizedUrl ? getLinkMetadata(c.env, normalizedUrl, true) : emptyLinkMetadata(url);
    }),
  );

  return c.json({ linkMetadata });
});
