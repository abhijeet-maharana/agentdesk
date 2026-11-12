import { jwtVerify } from 'jose';
import { z } from 'zod';

/** The audience a staff token must carry, so a customer's identity token can never pass as one. */
export const STAFF_AUDIENCE = 'agentdesk-inbox';

const staffSchema = z.object({
  sub: z.string().min(1),
  name: z.string().optional(),
  /** `viewer`: read only. `agent` (default): also reply, pause, star, mark read. */
  role: z.enum(['agent', 'viewer']).default('agent'),
});

export type Staff = z.infer<typeof staffSchema>;

/**
 * Someone from your team, as your app vouches for them: a short-lived JWT signed with
 * IDENTITY_SECRET (HS256) with `aud: "agentdesk-inbox"`. Lets the inbox you embed in your own
 * admin call the admin API from the browser, where ADMIN_TOKEN must never go. Null if invalid.
 */
export async function verifyStaff(token: string, secret: string | undefined): Promise<Staff | null> {
  if (!secret || !token) return null;
  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(secret), {
      algorithms: ['HS256'],
      audience: STAFF_AUDIENCE,
      requiredClaims: ['exp'],
    });
    return staffSchema.parse(payload);
  } catch {
    return null;
  }
}
