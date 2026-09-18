import { randomBytes, createHash } from 'node:crypto';
import { config } from './config.js';
import { oauthHeader, botOauth1Configured } from './oauth1.js';

const API = 'https://api.x.com/2';
const AUTHORIZE = 'https://x.com/i/oauth2/authorize';
const TOKEN = 'https://api.x.com/2/oauth2/token';

/**
 * Read-only scopes. We deliberately do not request tweet.write for the user:
 * the app never posts through anyone's account, which keeps us clear of X's
 * consent requirements for automated actions on a user's behalf.
 */
const SCOPES = ['tweet.read', 'users.read'];

function b64url(b: Buffer): string {
  return b.toString('base64url');
}

export function beginOAuth(): { url: string; state: string; codeVerifier: string } {
  const state = b64url(randomBytes(24));
  const codeVerifier = b64url(randomBytes(48));
  const challenge = b64url(createHash('sha256').update(codeVerifier).digest());
  const url =
    `${AUTHORIZE}?response_type=code` +
    `&client_id=${encodeURIComponent(config.x.clientId)}` +
    `&redirect_uri=${encodeURIComponent(config.baseUrl + '/auth/callback')}` +
    `&scope=${encodeURIComponent(SCOPES.join(' '))}` +
    `&state=${state}&code_challenge=${challenge}&code_challenge_method=S256`;
  return { url, state, codeVerifier };
}

export async function exchangeCode(code: string, codeVerifier: string): Promise<string> {
  const basic = Buffer.from(`${config.x.clientId}:${config.x.clientSecret}`).toString('base64');
  const res = await fetch(TOKEN, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${basic}`,
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: config.baseUrl + '/auth/callback',
      code_verifier: codeVerifier,
    }),
  });
  if (!res.ok) throw new Error(`Token exchange failed: ${res.status}`);
  const json = (await res.json()) as { access_token: string };
  return json.access_token;
}

export class RateLimited extends Error {
  constructor(public resetEpochSeconds: number) {
    super('X API rate limited');
  }
}

async function get<T>(path: string, token: string): Promise<T> {
  const res = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 429) throw new RateLimited(Number(res.headers.get('x-rate-limit-reset') ?? 0));
  if (!res.ok) throw new Error(`X GET ${path} -> ${res.status}`);
  return (await res.json()) as T;
}

/**
 * GET signed with OAuth 1.0a User Context. Required for endpoints that act as
 * the bot user rather than as the app — the mentions timeline is one of these,
 * and it rejects App-Only Bearer tokens with 401. Query params must be included
 * in the signature base, so they are split out and signed, then reattached.
 */
async function getUserContext<T>(pathWithQuery: string): Promise<T> {
  const [path, query = ''] = pathWithQuery.split('?');
  const url = `${API}${path}`;
  const queryParams: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(query)) queryParams[k] = v;

  const res = await fetch(`${url}${query ? '?' + query : ''}`, {
    headers: { Authorization: oauthHeader('GET', url, queryParams) },
  });
  if (res.status === 429) throw new RateLimited(Number(res.headers.get('x-rate-limit-reset') ?? 0));
  if (!res.ok) throw new Error(`X GET ${path} -> ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

export async function me(token: string): Promise<{ id: string; username: string }> {
  const json = await get<{ data: { id: string; username: string } }>('/users/me', token);
  return json.data;
}

export interface Mention {
  id: string;
  text: string;
  authorId: string;
  authorHandle: string | null;
  repliedToAuthorId: string | null;
  repliedToAuthorHandle: string | null;
}

export async function fetchMentions(
  sinceId?: string,
): Promise<{ mentions: Mention[]; newestId?: string }> {
  const params = new URLSearchParams({
    max_results: '100',
    'tweet.fields': 'author_id,referenced_tweets,created_at',
    expansions: 'author_id,referenced_tweets.id,referenced_tweets.id.author_id',
    'user.fields': 'username',
  });
  if (sinceId) params.set('since_id', sinceId);

  const json = await getUserContext<{
    data?: Array<{
      id: string;
      text: string;
      author_id: string;
      referenced_tweets?: Array<{ type: string; id: string }>;
    }>;
    includes?: {
      users?: Array<{ id: string; username: string }>;
      tweets?: Array<{ id: string; author_id: string }>;
    };
    meta?: { newest_id?: string };
  }>(`/users/${config.x.botUserId}/mentions?${params}`);

  const users = new Map((json.includes?.users ?? []).map((u) => [u.id, u.username]));
  const tweets = new Map((json.includes?.tweets ?? []).map((t) => [t.id, t.author_id]));

  const mentions = (json.data ?? []).map((t) => {
    const parentId = t.referenced_tweets?.find((r) => r.type === 'replied_to')?.id ?? null;
    const parentAuthor = parentId ? tweets.get(parentId) ?? null : null;
    return {
      id: t.id,
      text: t.text,
      authorId: t.author_id,
      authorHandle: users.get(t.author_id) ?? null,
      repliedToAuthorId: parentAuthor,
      repliedToAuthorHandle: parentAuthor ? users.get(parentAuthor) ?? null : null,
    };
  });

  return { mentions, newestId: json.meta?.newest_id };
}

export async function lookupHandle(
  handle: string,
): Promise<{ id: string; username: string } | null> {
  if (!/^\w{1,15}$/.test(handle)) return null;
  try {
    const json = await getUserContext<{ data?: { id: string; username: string } }>(
      `/users/by/username/${handle}?user.fields=username`,
    );
    return json.data ?? null;
  } catch {
    return null;
  }
}

/**
 * Reply from the bot's own automated account.
 *
 * Posting is an action taken as the bot account, so it uses OAuth 1.0a User
 * Context (not the App-Only Bearer token, which can only read). The JSON body
 * is not part of the OAuth signature base for v2, so we sign the bare URL.
 */
export async function reply(inReplyToTweetId: string, text: string): Promise<void> {
  if (!botOauth1Configured()) {
    console.error('reply skipped: X_API_KEY/SECRET and X_ACCESS_TOKEN/SECRET are not set');
    return;
  }
  const url = `${API}/tweets`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: oauthHeader('POST', url),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ text, reply: { in_reply_to_tweet_id: inReplyToTweetId } }),
  });
  if (!res.ok) console.error(`reply failed: ${res.status} ${await res.text()}`);
}
