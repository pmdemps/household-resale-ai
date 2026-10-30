// eBay Marketplace Account Deletion / Closure notifications.
// Reference: https://developer.ebay.com/marketplace-account-deletion
//
// Challenge (GET ?challenge_code=...): challengeResponse = hex(SHA-256(challengeCode + verificationToken + endpointURL)),
// in that order. Reply 200 JSON {"challengeResponse": "<hex>"} built with JSON.stringify (never hand-written, to
// avoid a BOM). Verification token: 32–80 chars of [A-Za-z0-9_-].

import { createHash } from "node:crypto";

export function challengeResponse(challengeCode: string, verificationToken: string, endpointUrl: string): string {
  return createHash("sha256").update(challengeCode).update(verificationToken).update(endpointUrl).digest("hex");
}

export function challengeBody(challengeCode: string, verificationToken: string, endpointUrl: string): { challengeResponse: string } {
  return { challengeResponse: challengeResponse(challengeCode, verificationToken, endpointUrl) };
}

export function isValidVerificationToken(token: string | undefined | null): boolean {
  return typeof token === "string" && /^[A-Za-z0-9_-]{32,80}$/.test(token);
}

export type AccountDeletionNotification = {
  metadata: { topic: string; schemaVersion?: string; deprecated?: boolean };
  notification: {
    notificationId?: string;
    eventDate?: string;
    publishDate?: string;
    publishAttemptCount?: number;
    data: { username?: string; userId?: string; eiasToken?: string };
  };
};

export const ACCOUNT_DELETION_TOPIC = "MARKETPLACE_ACCOUNT_DELETION";

/** Shape check for the POST body. Signature verification (X-EBAY-SIGNATURE via Notification API getPublicKey) is a TODO. */
export function parseAccountDeletionNotification(body: unknown): AccountDeletionNotification | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const metadata = b.metadata as Record<string, unknown> | undefined;
  const notification = b.notification as Record<string, unknown> | undefined;
  if (!metadata || !notification || metadata.topic !== ACCOUNT_DELETION_TOPIC) return null;
  const data = notification.data as Record<string, unknown> | undefined;
  if (!data || typeof data !== "object") return null;
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  if (!str(data.username) && !str(data.userId)) return null;
  return {
    metadata: { topic: ACCOUNT_DELETION_TOPIC, schemaVersion: str(metadata.schemaVersion), deprecated: metadata.deprecated === true },
    notification: {
      notificationId: str(notification.notificationId),
      eventDate: str(notification.eventDate),
      publishDate: str(notification.publishDate),
      publishAttemptCount: typeof notification.publishAttemptCount === "number" ? notification.publishAttemptCount : undefined,
      data: { username: str(data.username), userId: str(data.userId), eiasToken: str(data.eiasToken) },
    },
  };
}
