import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config.js';
import { IdentityError, identityNote, verifyIdentity } from '../src/identity.js';

const SECRET = 'test-secret-that-is-long-enough-123';

const sign = (claims: Record<string, unknown>, expires = '1h', secret = SECRET) =>
  new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject('u1')
    .setExpirationTime(expires)
    .sign(new TextEncoder().encode(secret));

describe('verifyIdentity', () => {
  it('is a guest without a token', async () => {
    expect(await verifyIdentity(undefined, SECRET)).toBeNull();
  });

  it('reads a valid token', async () => {
    const token = await sign({ name: 'Asha', phone: '+911234', toolArgs: { user_token: 't' } });
    expect(await verifyIdentity(`Bearer ${token}`, SECRET)).toMatchObject({
      sub: 'u1',
      name: 'Asha',
      toolArgs: { user_token: 't' },
    });
  });

  it('rejects expired, wrongly signed and unexpected tokens', async () => {
    await expect(verifyIdentity(`Bearer ${await sign({}, '-1m')}`, SECRET)).rejects.toThrow(IdentityError);
    await expect(
      verifyIdentity(`Bearer ${await sign({}, '1h', 'other-secret-xxxxxxxxxxxxxxxx')}`, SECRET),
    ).rejects.toThrow(IdentityError);
    await expect(verifyIdentity('Bearer abc', undefined)).rejects.toThrow(IdentityError);
  });
});

describe('identityNote', () => {
  it('describes guests and logged-in visitors', () => {
    expect(identityNote(null)).toContain('guest');
    expect(identityNote({ sub: 'u1', name: 'Asha', phone: '+911234', note: 'VIP.' })).toBe(
      '[Website chat: the customer is logged in as Asha, phone +911234. VIP.]',
    );
  });
});

describe('parseConfig', () => {
  it('fills defaults from an empty file', () => {
    const config = parseConfig(null);
    expect(config.agent.model).toBe('claude-sonnet-5-5');
    expect(config.web.widget.title).toBe('Support');
    expect(config.limits.messagesPerIp).toEqual({ max: 60, perMinutes: 10 });
    expect(config.voice).toBeUndefined();
  });

  it('expands ${ENV} values', () => {
    process.env.TEST_MCP_TOKEN = 'abc';
    const config = parseConfig({
      mcp: { url: 'http://localhost/mcp', headers: { Authorization: 'Bearer ${TEST_MCP_TOKEN}' } },
    });
    expect(config.mcp?.headers.Authorization).toBe('Bearer abc');
  });

  it('explains invalid values', () => {
    expect(() => parseConfig({ mcp: { url: 'not a url' } })).toThrow(/mcp.url/);
  });
});
