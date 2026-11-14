import { describe, it, expect } from 'vitest';
import {
  generateCancelToken,
  hashCancelToken,
  verifyCancelToken,
  checkHoneypot,
  checkFormTimestamp,
  generateClaimToken,
  hashClaimToken,
  verifyClaimToken,
  isWellFormedToken,
} from '../src/domain/security';


describe('Security & Cancellation Token Engine', () => {
  const secretKey = 'a'.repeat(64);

  it('generates deterministic HMAC tokens from attendee metadata and validates storage hash', async () => {
    const attendeeId = 'att_12345';
    const createdAt = '2026-11-15T10:00:00Z';
    const eventId = 'event_999';

    const token1 = await generateCancelToken(secretKey, attendeeId, createdAt, eventId);
    const token2 = await generateCancelToken(secretKey, attendeeId, createdAt, eventId);

    // Must be deterministic
    expect(token1).toBe(token2);
    expect(token1).toHaveLength(64); // 256-bit hex

    // Storage hash must be SHA-256 of the token
    const storedHash = await hashCancelToken(token1);
    expect(storedHash).not.toBe(token1);
    expect(storedHash).toHaveLength(64);

    // Verification must succeed with token against stored hash
    expect(await verifyCancelToken(token1, storedHash)).toBe(true);

    // Tampered token must fail
    expect(await verifyCancelToken('tampered_token_abc', storedHash)).toBe(false);
  });

  it('refuses short or missing secrets so public data can never be the HMAC key', async () => {
    await expect(generateCancelToken('https://example.test', 'att_1', 'now', 'evt')).rejects.toThrow();
    await expect(generateCancelToken('', 'att_1', 'now', 'evt')).rejects.toThrow();
  });

  it('separates cancel and claim tokens by purpose and validates their shape', async () => {
    const cancel = await generateCancelToken(secretKey, 'x', 'y', 'z');
    const claim = await generateClaimToken(secretKey, 'x', 'z', 'y');
    expect(cancel).not.toBe(claim);
    expect(isWellFormedToken(cancel)).toBe(true);
    expect(isWellFormedToken('not-a-token')).toBe(false);
    expect(isWellFormedToken(undefined)).toBe(false);
    expect(await verifyClaimToken(claim, await hashClaimToken(claim))).toBe(true);
    expect(await verifyClaimToken('tampered', await hashClaimToken(claim))).toBe(false);
  });

  it('rejects honeypot submissions when field is populated by bots', () => {
    expect(checkHoneypot('')).toBe(true);
    expect(checkHoneypot(undefined)).toBe(true);
    expect(checkHoneypot('   ')).toBe(true);

    expect(checkHoneypot('spam-bot-value')).toBe(false);
  });

  it('detects inhuman submission speed and stale submissions', () => {
    const now = 100_000_000;

    // Submitted in 500ms (too fast, likely bot)
    expect(checkFormTimestamp(now - 500, now)).toBe(false);

    // Submitted in 5 seconds (normal human)
    expect(checkFormTimestamp(now - 5000, now)).toBe(true);

    // Submitted 3 hours ago (stale)
    expect(checkFormTimestamp(now - 12_000_000, now)).toBe(false);
  });
});
