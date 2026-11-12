import { jwtVerify } from 'jose';
import { z } from 'zod';

/**
 * A logged-in visitor, as your site vouches for them: a JWT signed with IDENTITY_SECRET
 * (HS256), sent by the widget as `Authorization: Bearer <token>`.
 */
const claimsSchema = z.object({
  /** Your user id. */
  sub: z.string().min(1),
  name: z.string().optional(),
  phone: z.string().optional(),
  email: z.string().optional(),
  /** One more line for the agent about this visitor, e.g. what they can't do. */
  note: z.string().optional(),
  /** Values for `mcp.hiddenArgs`, e.g. a token your tools accept for this user. */
  toolArgs: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
});

export type Identity = z.infer<typeof claimsSchema>;

export class IdentityError extends Error {}

/** The visitor behind a request: null for a guest. Throws IdentityError for a bad or expired token. */
export async function verifyIdentity(
  authorization: string | undefined,
  secret: string | undefined,
): Promise<Identity | null> {
  const token = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) return null;
  if (!secret) throw new IdentityError('Logged-in chats are not set up on this server (IDENTITY_SECRET).');
  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(secret), {
      algorithms: ['HS256'],
      requiredClaims: ['exp'],
    });
    if (payload.aud === 'agentdesk-inbox') throw new Error('A staff token is not a visitor identity');
    return claimsSchema.parse(payload);
  } catch {
    throw new IdentityError('Your login has expired. Please refresh the page.');
  }
}

/** One line the agent reads with the visitor's latest message (not stored). */
export function identityNote(identity: Identity | null): string {
  if (!identity) return '[Website chat: the customer is a guest (not logged in).]';
  const details = [
    identity.name,
    identity.phone && `phone ${identity.phone}`,
    identity.email && `email ${identity.email}`,
  ].filter(Boolean);
  const who = details.length ? ` as ${details.join(', ')}` : '';
  return `[Website chat: the customer is logged in${who}.${identity.note ? ` ${identity.note}` : ''}]`;
}
