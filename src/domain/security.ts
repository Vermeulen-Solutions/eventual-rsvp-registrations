/**
 * Attendance's token kinds on top of the shared library's signing primitives.
 * Payloads: `cancel:<attendeeId>:<createdAt>:<eventId>` and `claim:<entryId>:<eventId>:<offerExpiresAt>`.
 */
import { hashToken, signToken, verifyToken } from "@vermeulen.solutions/eventual-capacity";

export {
  checkFormTimestamp,
  checkHoneypot,
  hashToken,
  isWellFormedToken,
} from "@vermeulen.solutions/eventual-capacity";

export function generateCancelToken(secret: string, attendeeId: string, createdAt: string, eventId: string): Promise<string> {
  return signToken(secret, "cancel", [attendeeId, createdAt, eventId]);
}

export function generateClaimToken(secret: string, entryId: string, eventId: string, offerExpiresAt: string): Promise<string> {
  return signToken(secret, "claim", [entryId, eventId, offerExpiresAt]);
}

export const hashCancelToken = hashToken;
export const hashClaimToken = hashToken;
export const verifyCancelToken = verifyToken;
export const verifyClaimToken = verifyToken;
