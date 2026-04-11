/**
 * Comment Route
 *
 * POST /comment — post a reply to an X (Twitter) tweet using the session
 * cookies exported to cookies.json. Authenticates via the ct0 CSRF cookie
 * and dynamically-resolved web auth metadata from X's client bundle.
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const fetch = require('node-fetch');

const router = express.Router();

const COOKIES_PATH = path.join(__dirname, 'cookies.json');
const X_ORIGIN = 'https://x.com';
const CREATE_TWEET_OPERATION = 'CreateTweet';
const AUTH_CACHE_TTL_MS = 15 * 60 * 1000;
// Keep static values only as fallback if dynamic extraction fails.
const FALLBACK_QUERY_ID = 'SoVnbfCycZ7fERGCwpZkYA';
const FALLBACK_BEARER =
  'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I7wHoADfhpM%3DEzbCOPGEfMmFe5bAHunb0Q2Z1kfYAHVGdAnfenNeVw';

const webAuthCache = {
  expiresAt: 0,
  bearer: null,
  queryId: null,
};

/**
 * Load the browser-exported cookie array from cookies.json and return
 * { cookieHeader, ct0 }. Throws if the file is missing, malformed, or
 * does not contain a ct0 entry.
 */
function loadCookies() {
  const raw = fs.readFileSync(COOKIES_PATH, 'utf8');
  const arr = JSON.parse(raw);
  if (!Array.isArray(arr)) {
    throw new Error('cookies.json must be a JSON array');
  }

  // cookies.json is a full browser export covering many unrelated sites.
  // Keep only cookies whose domain is x.com / twitter.com or a subdomain —
  // sending the full jar triggers Cloudflare's 400 "Cookie Too Large".
  const isXDomain = (domain) => {
    if (typeof domain !== 'string') return false;
    const d = domain.replace(/^\./, '').toLowerCase();
    return (
      d === 'x.com' ||
      d.endsWith('.x.com') ||
      d === 'twitter.com' ||
      d.endsWith('.twitter.com')
    );
  };

  // Exclude auth_multi: when more than one account has been signed in,
  // X uses auth_multi alongside auth_token to pick the active user and the
  // two can conflict, producing spurious "Could not authenticate you".
  const EXCLUDED_COOKIE_NAMES = new Set(['auth_multi']);

  const xCookies = arr.filter(
    (c) =>
      c &&
      typeof c.name === 'string' &&
      typeof c.value === 'string' &&
      isXDomain(c.domain) &&
      !EXCLUDED_COOKIE_NAMES.has(c.name)
  );

  // Dedupe by name — later entries win, matching browser behavior where a
  // more-specific cookie masks a less-specific one.
  const byName = new Map();
  for (const c of xCookies) byName.set(c.name, c.value);

  const cookieHeader = [...byName.entries()]
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');

  const ct0 = byName.get('ct0');
  if (!ct0) {
    throw new Error('ct0 cookie not found for x.com/twitter.com in cookies.json');
  }
  if (!byName.get('auth_token')) {
    throw new Error('auth_token cookie not found for x.com/twitter.com in cookies.json');
  }

  return { cookieHeader, ct0 };
}

async function resolveCreateTweetAuth() {
  const now = Date.now();
  if (
    webAuthCache.bearer &&
    webAuthCache.queryId &&
    webAuthCache.expiresAt > now
  ) {
    return { bearer: webAuthCache.bearer, queryId: webAuthCache.queryId };
  }

  try {
    const homeRes = await fetch(X_ORIGIN, {
      headers: { 'user-agent': 'Mozilla/5.0' },
    });
    const homeHtml = await homeRes.text();

    const mainScriptMatch = homeHtml.match(
      /<script[^>]+src="([^"]*\/responsive-web\/client-web\/main\.[^"]+\.js)"/
    );
    if (!mainScriptMatch) {
      throw new Error('main script URL not found');
    }

    const mainScriptUrl = mainScriptMatch[1].startsWith('http')
      ? mainScriptMatch[1]
      : `${X_ORIGIN}${mainScriptMatch[1]}`;

    const mainRes = await fetch(mainScriptUrl, {
      headers: { 'user-agent': 'Mozilla/5.0' },
    });
    const mainJs = await mainRes.text();

    const bearerMatch = mainJs.match(
      /AAAAAAAAAAAAAAAAAAAAA[A-Za-z0-9%]{80,180}/
    );
    const queryIdMatch = mainJs.match(
      /queryId:"([A-Za-z0-9_-]+)",operationName:"CreateTweet"/
    );
    if (!bearerMatch || !queryIdMatch) {
      throw new Error('CreateTweet auth metadata not found in client bundle');
    }

    webAuthCache.bearer = bearerMatch[0];
    webAuthCache.queryId = queryIdMatch[1];
    webAuthCache.expiresAt = now + AUTH_CACHE_TTL_MS;
    return { bearer: webAuthCache.bearer, queryId: webAuthCache.queryId };
  } catch (err) {
    console.warn(
      `[COMMENT] Falling back to static auth metadata: ${err.message}`
    );
    return { bearer: FALLBACK_BEARER, queryId: FALLBACK_QUERY_ID };
  }
}

// ---------------------------------------------------------------------------
// X CreateTweet worker
// ---------------------------------------------------------------------------

const CREATE_TWEET_FEATURES = {
  tweetypie_unmention_optimization_enabled: true,
  responsive_web_edit_tweet_api_enabled: true,
  graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
  view_counts_everywhere_api_enabled: true,
  longform_notetweets_consumption_enabled: true,
  responsive_web_twitter_article_tweet_consumption_enabled: false,
  tweet_awards_web_tipping_enabled: false,
  longform_notetweets_rich_text_read_enabled: true,
  longform_notetweets_inline_media_enabled: true,
  responsive_web_graphql_exclude_directive_enabled: true,
  verified_phone_label_enabled: false,
  freedom_of_speech_not_reach_enabled: true,
  standardized_nudges_misinfo: true,
  tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  responsive_web_graphql_timeline_navigation_enabled: true,
  responsive_web_enhance_cards_enabled: false,
};

const MAX_RETRIES = 2;
const RETRY_DELAYS_MS = [20000, 40000];

const hasAntiAutomationError = (parsed) =>
  !!parsed &&
  Array.isArray(parsed.errors) &&
  parsed.errors.some((e) => e && e.code === 226);

/**
 * Extract only the fields a caller actually cares about from X's deeply
 * nested CreateTweet response payload.
 */
function summarizeTweet(parsed) {
  try {
    const result =
      parsed &&
      parsed.data &&
      parsed.data.create_tweet &&
      parsed.data.create_tweet.tweet_results &&
      parsed.data.create_tweet.tweet_results.result;
    if (!result || !result.rest_id) return null;
    const legacy = result.legacy || {};
    const userCore =
      (result.core &&
        result.core.user_results &&
        result.core.user_results.result &&
        result.core.user_results.result.core) ||
      {};
    const screenName = userCore.screen_name || 'i';
    return {
      id: result.rest_id,
      url: `https://x.com/${screenName}/status/${result.rest_id}`,
      text: legacy.full_text,
      created_at: legacy.created_at,
      in_reply_to_status_id: legacy.in_reply_to_status_id_str || null,
      in_reply_to_screen_name: legacy.in_reply_to_screen_name || null,
    };
  } catch {
    return null;
  }
}

/**
 * Post a tweet (optionally as a reply) to X, transparently retrying X's
 * code-226 anti-automation blocks. Returns a tagged result object — never
 * throws for X-side errors, only for unexpected local failures.
 */
async function runCreateTweet({ tweet_id, text }) {
  let cookieHeader;
  let ct0;
  try {
    ({ cookieHeader, ct0 } = loadCookies());
  } catch (err) {
    console.error('[COMMENT] Failed to load cookies:', err.message);
    return {
      ok: false,
      httpStatus: 500,
      error: { kind: 'cookies', message: err.message },
    };
  }

  const variables = { tweet_text: text };
  if (tweet_id) {
    variables.reply = {
      in_reply_to_tweet_id: tweet_id,
      exclude_reply_user_ids: [],
    };
  }

  const { bearer, queryId } = await resolveCreateTweetAuth();
  const createTweetUrl = `${X_ORIGIN}/i/api/graphql/${queryId}/${CREATE_TWEET_OPERATION}`;
  const body = { variables, features: CREATE_TWEET_FEATURES, queryId };

  const callX = async () => {
    const xRes = await fetch(createTweetUrl, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${bearer}`,
        'x-csrf-token': ct0,
        'content-type': 'application/json',
        'x-twitter-auth-type': 'OAuth2Session',
        'x-twitter-active-user': 'yes',
        'x-twitter-client-language': 'en',
        cookie: cookieHeader,
        origin: X_ORIGIN,
        referer: `${X_ORIGIN}/`,
        accept: '*/*',
        'accept-language': 'en-US,en;q=0.9',
        'user-agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      },
      body: JSON.stringify(body),
    });
    const responseText = await xRes.text();
    console.log(
      `[COMMENT] X status=${xRes.status} x-rate-limit-remaining=${xRes.headers.get('x-rate-limit-remaining')}`
    );
    console.log(`[COMMENT] X response body:\n${responseText}`);
    let parsed = null;
    try {
      parsed = JSON.parse(responseText);
    } catch {
      /* non-JSON body — keep parsed=null */
    }
    return { status: xRes.status, responseText, parsed };
  };

  let attempt = 0;
  let result;
  try {
    result = await callX();
    while (hasAntiAutomationError(result.parsed) && attempt < MAX_RETRIES) {
      const delay = RETRY_DELAYS_MS[attempt];
      console.warn(
        `[COMMENT] X code 226 anti-automation; retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})`
      );
      await new Promise((r) => setTimeout(r, delay));
      attempt++;
      result = await callX();
    }
  } catch (err) {
    console.error('[COMMENT] Request to X failed:', err);
    return {
      ok: false,
      httpStatus: 502,
      error: { kind: 'network', message: err.message },
    };
  }

  // Still blocked after retries — surface as 429.
  if (hasAntiAutomationError(result.parsed)) {
    console.error(
      `[COMMENT] X still blocking with code 226 after ${MAX_RETRIES} retries`
    );
    return {
      ok: false,
      httpStatus: 429,
      error: {
        kind: 'rate_limited',
        code: 226,
        message:
          'X anti-automation check blocked the request after retries. Try again later.',
      },
    };
  }

  // Any other top-level GraphQL errors — forward as a failure.
  if (
    result.parsed &&
    Array.isArray(result.parsed.errors) &&
    result.parsed.errors.length > 0
  ) {
    console.error(
      `[COMMENT] X returned GraphQL errors:`,
      JSON.stringify(result.parsed.errors).slice(0, 500)
    );
    return {
      ok: false,
      httpStatus: result.status >= 400 ? result.status : 502,
      error: { kind: 'graphql', errors: result.parsed.errors },
    };
  }

  // HTTP-level error from X (non-2xx) or unparseable body.
  if (!result.parsed || result.status < 200 || result.status >= 300) {
    console.error(
      `[COMMENT] X returned ${result.status}:`,
      result.responseText.slice(0, 500)
    );
    return {
      ok: false,
      httpStatus: result.status >= 400 ? result.status : 502,
      error: {
        kind: 'http',
        status: result.status,
        body: result.responseText.slice(0, 2000),
      },
    };
  }

  // Success — summarize the tweet.
  const tweet = summarizeTweet(result.parsed);
  if (!tweet) {
    // Response parsed OK but didn't match the expected shape.
    return {
      ok: false,
      httpStatus: 502,
      error: { kind: 'unexpected_shape', raw: result.parsed },
    };
  }
  return { ok: true, httpStatus: 200, tweet };
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------
// POST /comment is fire-and-forget. The handler validates the request,
// spawns runCreateTweet() without awaiting, and returns 202 immediately.
// Success and failure (including retries and final outcome) are visible
// only in the server log — the caller gets no further updates.

router.post('/comment', (req, res) => {
  const { tweet_id, text } = req.body || {};
  if (
    typeof text !== 'string' ||
    !text.trim() ||
    (tweet_id != null && typeof tweet_id !== 'string')
  ) {
    return res.status(400).json({
      error:
        'Request body must be {"text": string} or {"tweet_id": string, "text": string}',
    });
  }

  // Short request id purely for correlating log lines with this submission.
  const reqId = crypto.randomBytes(4).toString('hex');
  console.log(
    `[COMMENT] ${reqId} accepted (tweet_id=${tweet_id || '(none)'})`
  );

  // Fire-and-forget. Never await; never .catch() synchronously into the
  // response. Log the final outcome instead.
  runCreateTweet({ tweet_id, text })
    .then((result) => {
      if (result.ok) {
        console.log(
          `[COMMENT] ${reqId} completed: ${result.tweet.url}`
        );
      } else {
        console.error(
          `[COMMENT] ${reqId} failed: ${JSON.stringify(result.error).slice(0, 300)}`
        );
      }
    })
    .catch((err) => {
      console.error(`[COMMENT] ${reqId} threw:`, err);
    });

  return res.status(202).json({ status: 'accepted' });
});

module.exports = router;
