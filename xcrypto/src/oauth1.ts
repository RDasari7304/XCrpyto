import { createHmac, randomBytes } from 'node:crypto';
import { config } from './config.js';

/**
 * OAuth 1.0a request signing (HMAC-SHA1), for calls made as the bot's own X
 * account — specifically POST /2/tweets.
 *
 * Posting a reply is an action on the bot account, so it needs User Context
 * auth, not the App-Only Bearer token. X's v2 write endpoints accept OAuth 1.0a
 * User Context, which is what the app's four "OAuth 1.0 Keys" credentials are
 * for (Consumer Key/Secret + Access Token/Secret).
 */

function rfc3986(v: string): string {
  return encodeURIComponent(v).replace(
    /[!'()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}

/**
 * Build the `Authorization: OAuth ...` header for one request.
 * `params` must include every query-string AND body parameter that is
 * form-encoded. For a JSON body (as v2 uses), the body is NOT part of the
 * signature base, so only query params go in here.
 */
export function oauthHeader(
  method: string,
  url: string,
  queryParams: Record<string, string> = {},
): string {
  const oauth: Record<string, string> = {
    oauth_consumer_key: config.x.consumerKey,
    oauth_nonce: randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: config.x.accessToken,
    oauth_version: '1.0',
  };

  // Signature base string: sorted, encoded, joined params from both oauth_* and
  // the query string.
  const all = { ...queryParams, ...oauth };
  const paramString = Object.keys(all)
    .sort()
    .map((k) => `${rfc3986(k)}=${rfc3986(all[k])}`)
    .join('&');

  const base = [method.toUpperCase(), rfc3986(url), rfc3986(paramString)].join('&');
  const signingKey = `${rfc3986(config.x.consumerSecret)}&${rfc3986(config.x.accessSecret)}`;
  const signature = createHmac('sha1', signingKey).update(base).digest('base64');

  const headerParams = { ...oauth, oauth_signature: signature };
  return (
    'OAuth ' +
    Object.keys(headerParams)
      .sort()
      .map((k) => `${rfc3986(k)}="${rfc3986(headerParams[k])}"`)
      .join(', ')
  );
}

export function botOauth1Configured(): boolean {
  return Boolean(
    config.x.consumerKey &&
      config.x.consumerSecret &&
      config.x.accessToken &&
      config.x.accessSecret,
  );
}
