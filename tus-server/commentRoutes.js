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
const COMMENT_PRIVATE_KEY_PATH =
  process.env.COMMENT_PRIVATE_KEY_PATH ||
  path.join(__dirname, 'comment_private_key.pem');
const ENCRYPTED_COMMENT_ALG = 'RSA-OAEP-256+A256GCM';

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

function readCommentPrivateKey() {
  return fs.readFileSync(COMMENT_PRIVATE_KEY_PATH, 'utf8');
}

function decryptCommentPayload(body) {
  if (!body || typeof body !== 'object') {
    throw new Error('Request body must be an encrypted JSON object');
  }

  const { version, alg, key, iv, ciphertext } = body;
  if (
    version !== 1 ||
    alg !== ENCRYPTED_COMMENT_ALG ||
    typeof key !== 'string' ||
    typeof iv !== 'string' ||
    typeof ciphertext !== 'string'
  ) {
    throw new Error(
      `Request body must be encrypted with ${ENCRYPTED_COMMENT_ALG}`
    );
  }

  const privateKey = readCommentPrivateKey();
  const aesKey = crypto.privateDecrypt(
    {
      key: privateKey,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256',
    },
    Buffer.from(key, 'base64')
  );
  const encryptedBytes = Buffer.from(ciphertext, 'base64');
  const ivBytes = Buffer.from(iv, 'base64');

  if (ivBytes.length !== 12) {
    throw new Error('Encrypted payload has an invalid IV');
  }
  if (encryptedBytes.length <= 16) {
    throw new Error('Encrypted payload is too short');
  }

  const authTag = encryptedBytes.subarray(encryptedBytes.length - 16);
  const encryptedBody = encryptedBytes.subarray(0, encryptedBytes.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey, ivBytes);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([
    decipher.update(encryptedBody),
    decipher.final(),
  ]);
  return JSON.parse(decrypted.toString('utf8'));
}

function validateCommentRequest(payload) {
  const { tweet_id, text } = payload || {};
  if (
    typeof text !== 'string' ||
    !text.trim() ||
    typeof tweet_id !== 'string' ||
    !tweet_id.trim()
  ) {
    return null;
  }

  return {
    tweet_id: tweet_id.trim(),
    text: text.trim(),
  };
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

    // Wait for the tweet article to confirm the page rendered (not a login wall)
    try {
      await page.locator('article[data-testid="tweet"]').first().waitFor({ state: 'visible', timeout: 20000 });
    } catch (articleErr) {
      // Capture a screenshot to help diagnose what rendered instead
      const screenshotPath = `/tmp/comment-fail-${tweet_id}.png`;
      await page.screenshot({ path: screenshotPath, fullPage: false }).catch(() => {});
      console.error(`[COMMENT] Tweet article not found; screenshot saved to ${screenshotPath}`);
      throw new Error('Tweet article did not load — possible login wall or deleted tweet');
    }

    // Give React a moment to attach event handlers after the article is visible
    await page.waitForTimeout(2000);

    // The reply composer may not be visible until the user clicks the reply action.
    // Try scrolling to the textarea first; if it's still not visible, click the
    // reply button on the tweet to activate the inline composer.
    let replyBox = page.locator('[data-testid="tweetTextarea_0"]');
    const isVisible = await replyBox.isVisible().catch(() => false);

    if (!isVisible) {
      // Try clicking the reply icon on the tweet to open the composer
      const replyAction = page.locator('[data-testid="reply"]').first();
      await replyAction.waitFor({ state: 'visible', timeout: 20000 });
      await replyAction.click();
      // Re-acquire the locator after the click
      replyBox = page.locator('[data-testid="tweetTextarea_0"]');
      await replyBox.waitFor({ state: 'visible', timeout: 15000 });
    } else {
      // Scroll into view in case it is off-screen
      await replyBox.scrollIntoViewIfNeeded();
    }

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
  let comment;
  try {
    comment = validateCommentRequest(decryptCommentPayload(req.body));
  } catch (err) {
    console.warn('[COMMENT] Failed to decrypt request:', err.message);
    return res.status(400).json({
      error: 'Request body must be an encrypted comment payload',
    });
  }

  if (!comment) {
    return res.status(400).json({
      error:
        'Encrypted payload must contain {"tweet_id": string, "text": string}',
    });
  }

  const { tweet_id, text } = comment;
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
