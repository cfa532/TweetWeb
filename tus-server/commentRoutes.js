/**
 * Comment Route
 *
 * POST /comment — post a reply to an X (Twitter) tweet using Playwright
 * with session cookies from cookies.json. Navigates to the tweet page
 * and submits the comment through the browser UI.
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { chromium } = require('playwright');

const router = express.Router();

const COOKIES_PATH = path.join(__dirname, 'cookies.json');

/**
 * Load cookies from cookies.json and convert them to Playwright's format.
 * Filters to only x.com / twitter.com cookies.
 */
function loadCookies() {
  const raw = fs.readFileSync(COOKIES_PATH, 'utf8');
  const arr = JSON.parse(raw);
  if (!Array.isArray(arr)) {
    throw new Error('cookies.json must be a JSON array');
  }

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

  const sameSiteMap = {
    no_restriction: 'None',
    lax: 'Lax',
    strict: 'Strict',
    unspecified: 'Lax',
  };

  return arr
    .filter(
      (c) =>
        c &&
        typeof c.name === 'string' &&
        typeof c.value === 'string' &&
        isXDomain(c.domain)
    )
    .map((c) => {
      const cookie = {
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path || '/',
        secure: c.secure !== false,
        httpOnly: c.httpOnly === true,
        sameSite: sameSiteMap[(c.sameSite || '').toLowerCase()] || 'Lax',
      };
      if (c.expirationDate && c.expirationDate > 0) {
        cookie.expires = c.expirationDate;
      }
      return cookie;
    });
}

/**
 * Use Playwright to navigate to the tweet and post a reply.
 */
async function postCommentWithPlaywright({ tweet_id, text }) {
  let cookies;
  try {
    cookies = loadCookies();
  } catch (err) {
    console.error('[COMMENT] Failed to load cookies:', err.message);
    return {
      ok: false,
      httpStatus: 500,
      error: { kind: 'cookies', message: err.message },
    };
  }

  const tweetUrl = `https://x.com/i/status/${tweet_id}`;
  console.log(`[COMMENT] Navigating to ${tweetUrl}`);

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 900 },
    });

    await context.addCookies(cookies);
    const page = await context.newPage();

    // Navigate to the tweet — use 'domcontentloaded' instead of 'networkidle'
    // because X keeps streaming requests and never truly goes idle.
    await page.goto(tweetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

    // Wait for the reply box to appear — it's the div[role="textbox"] inside the reply area
    // On a tweet detail page, the first textbox is the reply composer
    const replyBox = page.locator('[data-testid="tweetTextarea_0"]');
    await replyBox.waitFor({ state: 'visible', timeout: 30000 });

    // Click to focus the reply box
    await replyBox.click();

    // Type the comment text
    await page.keyboard.type(text, { delay: 30 });

    // Small pause to let X process the input
    await page.waitForTimeout(500);

    // Click the Reply button — data-testid="tweetButtonInline" for inline reply
    const replyButton = page.locator('[data-testid="tweetButtonInline"]');
    await replyButton.waitFor({ state: 'visible', timeout: 5000 });
    await replyButton.click();

    // Wait for the reply to be posted — look for the reply appearing or navigation
    // Give it some time for the network request to complete
    await page.waitForTimeout(3000);

    console.log(`[COMMENT] Reply posted successfully to tweet ${tweet_id}`);

    await browser.close();
    return {
      ok: true,
      httpStatus: 200,
      tweet: {
        in_reply_to_status_id: tweet_id,
        text,
        url: tweetUrl,
      },
    };
  } catch (err) {
    console.error('[COMMENT] Playwright error:', err.message);
    if (browser) {
      try {
        await browser.close();
      } catch {
        /* ignore cleanup errors */
      }
    }
    return {
      ok: false,
      httpStatus: 502,
      error: { kind: 'playwright', message: err.message },
    };
  }
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

router.post('/comment', (req, res) => {
  const { tweet_id, text } = req.body || {};
  if (
    typeof text !== 'string' ||
    !text.trim() ||
    typeof tweet_id !== 'string' ||
    !tweet_id.trim()
  ) {
    return res.status(400).json({
      error:
        'Request body must be {"tweet_id": string, "text": string}',
    });
  }

  const reqId = crypto.randomBytes(4).toString('hex');
  console.log(
    `[COMMENT] ${reqId} accepted (tweet_id=${tweet_id})`
  );

  // Fire-and-forget
  postCommentWithPlaywright({ tweet_id, text })
    .then((result) => {
      if (result.ok) {
        console.log(
          `[COMMENT] ${reqId} completed: replied to ${tweet_id}`
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
