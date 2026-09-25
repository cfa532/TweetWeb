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

// Free-text triggers that attach an image file instead of posting the literal
// text. Files live alongside this script and must be uploaded there manually.
const MEDIA_TRIGGERS = {
  pic1: 'pic1.png',
};

/**
 * If the comment text matches a media trigger and the backing file exists
 * next to this script, return its absolute path. Otherwise null.
 */
function resolveMediaAttachment(text) {
  const filename = MEDIA_TRIGGERS[text.toLowerCase()];
  if (!filename) return null;
  const filePath = path.join(__dirname, filename);
  return fs.existsSync(filePath) ? filePath : null;
}

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
async function postCommentWithPlaywright({ tweet_id, text, mediaPath }) {
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
    // Chromium's HTTP/2 connections to x.com / abs.twimg.com stall on the
    // minipc, so the app's JS bundles never finish loading and the page hangs
    // on the splash screen. Falling back to HTTP/1.1 loads it in ~5s.
    browser = await chromium.launch({
      headless: true,
      args: ['--disable-http2'],
    });
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
    // Over HTTP/1.1 (see --disable-http2 above) the tweet takes 12-26s to render.
    try {
      await page.locator('article[data-testid="tweet"]').first().waitFor({ state: 'visible', timeout: 45000 });
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
    // The inline composer renders a variable time after the tweet article, so
    // wait for it rather than sampling once: a single isVisible() check that
    // misses it falls into the reply-icon branch below, which opens a modal
    // whose full-screen mask then blocks the click on the textarea.
    let replyBox = page.locator('[data-testid="tweetTextarea_0"]');
    const isVisible = await replyBox
      .first()
      .waitFor({ state: 'visible', timeout: 15000 })
      .then(() => true)
      .catch(() => false);

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

    if (mediaPath) {
      // Media trigger: attach the image instead of typing the trigger text.
      const fileInput = page.locator('input[data-testid="fileInput"]');
      await fileInput.setInputFiles(mediaPath);
      // Wait for X to finish processing the upload (remove-media control
      // appears once the attachment preview is ready).
      await page
        .locator('[aria-label="Remove media"], [data-testid="removeMedia"]')
        .first()
        .waitFor({ state: 'visible', timeout: 30000 });
    } else {
      // Type the comment text
      await page.keyboard.type(text, { delay: 30 });
    }

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
  const mediaPath = resolveMediaAttachment(text);
  const reqId = crypto.randomBytes(4).toString('hex');
  console.log(
    `[COMMENT] ${reqId} accepted (tweet_id=${tweet_id}${mediaPath ? ', media=' + path.basename(mediaPath) : ''})`
  );

  // Fire-and-forget
  postCommentWithPlaywright({ tweet_id, text, mediaPath })
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
