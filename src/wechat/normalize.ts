export interface InboundMessage {
  accountId: string;
  messageId: string;
  groupId: string;
  senderId: string;
  text: string;
  mentions: string[];
  isSelf: boolean;
}

export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

// Never coerce unsafe JSON numbers: precision may already have been lost.
function id(value: unknown): string | undefined {
  if (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    !/\s/.test(value)
  )
    return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0)
    return String(value);
  return undefined;
}
export function isUserId(value: string): boolean {
  return /^(?:wxid_[A-Za-z0-9_-]+|[A-Za-z0-9_-]+@openim)$/.test(value);
}
export function isGroupId(value: string): boolean {
  return /^[A-Za-z0-9_-]+@chatroom$/.test(value);
}

/** Only call with events from the authenticated, pinned bridge. */
export function normalizeInbound(
  raw: unknown,
  expectedAccountId: string,
): InboundMessage | null {
  const event = record(raw);
  if (event.post_type !== "message" || event.message_type !== "group")
    return null;
  const accountId = id(event.self_id);
  const groupId = id(event.group_id);
  const senderId = id(record(event.sender).user_id) ?? id(event.user_id);
  const messageId = id(event.message_id);
  if (
    !accountId ||
    accountId !== expectedAccountId ||
    !isUserId(accountId) ||
    !groupId ||
    !isGroupId(groupId) ||
    !senderId ||
    !isUserId(senderId) ||
    !messageId ||
    event.is_self === true ||
    senderId === accountId
  )
    return null;
  if (event.sender_wxid && event.sender_wxid !== senderId) return null;
  const mentions = new Set<string>();
  let text = "";
  if (Array.isArray(event.message)) {
    for (const item of event.message) {
      const segment = record(item),
        data = record(segment.data);
      if (segment.type === "text" && typeof data.text === "string")
        text += data.text;
      if (
        segment.type === "at" &&
        typeof data.qq === "string" &&
        isUserId(data.qq)
      )
        mentions.add(data.qq);
    }
  } else if (typeof event.message === "string") text = event.message;
  // This is structured metadata from the Hook, never extracted from visible text.
  if (Array.isArray(event.mentions))
    for (const target of event.mentions) {
      if (typeof target === "string" && isUserId(target)) mentions.add(target);
    }
  if (!text.trim() || text.length > 64_000) return null;
  return {
    accountId,
    messageId,
    groupId,
    senderId,
    text,
    mentions: [...mentions],
    isSelf: false,
  };
}
