export const VALID_MEMO_VISIBILITIES = new Set(["PUBLIC", "PROTECTED", "PRIVATE"]);
export const VALID_ROW_STATUSES = new Set(["NORMAL", "ARCHIVED"]);

export function createPlaceholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

export function chunkValues<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

export function parsePageSize(raw: string | undefined, defaultSize = 50, maxSize = 1000): number {
  if (!raw) {
    return defaultSize;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return defaultSize;
  }
  return Math.min(Math.floor(parsed), maxSize);
}

export function parsePageTokenOffset(pageToken: string | undefined): number {
  if (!pageToken) {
    return 0;
  }
  try {
    const decoded = atob(pageToken).trim();
    if (!/^\d+$/.test(decoded)) {
      return 0;
    }
    const offset = Number(decoded);
    return Number.isSafeInteger(offset) && offset >= 0 ? offset : 0;
  } catch {
    return 0;
  }
}

export function parseIsoTimestampSeconds(value: unknown): number | undefined | null {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? Math.floor(value) : null;
  }
  if (typeof value !== "string") {
    return null;
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) {
    return null;
  }
  return Math.floor(ms / 1000);
}

export function safeJsonParse<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) {
    return fallback;
  }
  try {
    return (JSON.parse(raw) as T) ?? fallback;
  } catch {
    return fallback;
  }
}

export function normalizeUserRoleInput(value: unknown): "ADMIN" | "USER" | undefined {
  if (value === 2 || value === "ADMIN") {
    return "ADMIN";
  }
  if (value === 3 || value === "USER") {
    return "USER";
  }
  return undefined;
}

export function isUniqueConstraintError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return message.includes("UNIQUE constraint failed") || message.includes("SQLITE_CONSTRAINT_UNIQUE");
}

export function extractMentionUsernames(content: string): string[] {
  if (!content) {
    return [];
  }

  // Strip fenced code blocks and inline code spans so code examples don't trigger mentions.
  const stripped = content
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`\n]+`/g, " ");

  const usernames = new Set<string>();
  const mentionRegex = /(^|[^A-Za-z0-9_-])@([A-Za-z0-9_-]{1,32})/g;
  let match: RegExpExecArray | null;
  while ((match = mentionRegex.exec(stripped)) !== null) {
    const candidate = match[2];
    if (/[A-Za-z0-9]/.test(candidate)) {
      usernames.add(candidate.toLowerCase());
    }
  }
  return [...usernames];
}
