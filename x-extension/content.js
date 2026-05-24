// ============================================================
//  X/Twitter Quick Comment Extension
//  Menu label      : "Good dog"
//  Preset comments : "Wonderful day 1" / "Wonderful day 2"
//  + free-text input
//  Backend         : https://mini.fireshare.uk/comment
// ============================================================

const MENU_LABEL   = "Good dog";
const PRESETS      = ["好狗 没白养", "好好踩缝纫机 早日做人"];
const BACKEND_URL  = "https://mini.fireshare.uk/comment";
const ENCRYPTION_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA2dg//qzFfNzwssAYynRz
fz66WHIcVZwga4dZbgOVsUcTKsJX9G+UC9jcwiMB0EPtFyPNVVzSre5f0upG8wN9
ZNMEgn/rkI9ZZJNwQUiBXQrI3mXCSSYX0twJt+xhrFYUc3DZo7O5eIcdMv2UvHnp
D/JiMkMOMj213rd9Ej+AaNRj8vt0amVfwpT0k8znOGUyeh7wxbF8HsjabTpFhTLP
iafTt8bz06qHq29Sck7Vztezn0Las5SLi/h7itI2TK3Sl8WOCI8yOu5mpMtZZ1pu
OIo58v8/f6IgUYgI63znFgxNOIeUXoPxR9YTlI9MITNJrsVpSY5nn+/3zIMiUwd+
wQIDAQAB
-----END PUBLIC KEY-----`;

// ── Helpers ──────────────────────────────────────────────────

/**
 * Extract the tweet ID from an article element.
 * X embeds it in a link like /username/status/1234567890
 */
function getTweetId(article) {
  const link = article.querySelector('a[href*="/status/"]');
  if (!link) return null;
  const match = link.href.match(/\/status\/(\d+)/);
  return match ? match[1] : null;
}

function base64FromBytes(bytes) {
  let binary = "";
  bytes.forEach(byte => { binary += String.fromCharCode(byte); });
  return btoa(binary);
}

function bytesFromBase64(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function importBackendPublicKey() {
  const pemBody = ENCRYPTION_PUBLIC_KEY_PEM
    .replace("-----BEGIN PUBLIC KEY-----", "")
    .replace("-----END PUBLIC KEY-----", "")
    .replace(/\s/g, "");

  if (!pemBody || pemBody.includes("REPLACE_WITH_BACKEND_RSA_OAEP_PUBLIC_KEY")) {
    throw new Error("Encryption public key is not configured");
  }

  return crypto.subtle.importKey(
    "spki",
    bytesFromBase64(pemBody),
    { name: "RSA-OAEP", hash: "SHA-256" },
    false,
    ["encrypt"]
  );
}

async function encryptCommentPayload(payload) {
  const publicKey = await importBackendPublicKey();
  const aesKey = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt"]
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encodedPayload = new TextEncoder().encode(JSON.stringify(payload));

  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    aesKey,
    encodedPayload
  );
  const rawAesKey = await crypto.subtle.exportKey("raw", aesKey);
  const encryptedKey = await crypto.subtle.encrypt(
    { name: "RSA-OAEP" },
    publicKey,
    rawAesKey
  );

  return {
    version: 1,
    alg: "RSA-OAEP-256+A256GCM",
    key: base64FromBytes(new Uint8Array(encryptedKey)),
    iv: base64FromBytes(iv),
    ciphertext: base64FromBytes(new Uint8Array(ciphertext))
  };
}

// ── Comment Picker Modal ──────────────────────────────────────

function showPicker(tweetArticle) {
  // Remove any existing picker
  document.getElementById("qc-picker")?.remove();

  const overlay = document.createElement("div");
  overlay.id = "qc-picker";
  overlay.style.cssText = `
    position: fixed; inset: 0; z-index: 99999;
    display: flex; align-items: center; justify-content: center;
    background: rgba(0,0,0,0.45);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  `;

  const card = document.createElement("div");
  card.style.cssText = `
    background: #000;
    border: 1px solid #2f3336;
    border-radius: 16px;
    padding: 24px 28px 20px;
    width: 340px;
    box-shadow: 0 8px 40px rgba(0,0,0,0.7);
    display: flex; flex-direction: column; gap: 12px;
  `;

  // Title
  const title = document.createElement("p");
  title.textContent = "💬 Choose a comment";
  title.style.cssText = `
    margin: 0 0 4px; color: #e7e9ea;
    font-size: 17px; font-weight: 700;
  `;
  card.appendChild(title);

  // Preset buttons
  PRESETS.forEach(text => {
    const btn = document.createElement("button");
    btn.textContent = text;
    btn.style.cssText = `
      all: unset; display: block; width: 100%; box-sizing: border-box;
      padding: 11px 16px; border-radius: 9999px;
      background: #1d9bf0; color: #fff;
      font-size: 15px; font-weight: 600; cursor: pointer;
      text-align: center; transition: background 0.15s;
    `;
    btn.onmouseenter = () => { btn.style.background = "#1a8cd8"; };
    btn.onmouseleave = () => { btn.style.background = "#1d9bf0"; };
    btn.addEventListener("click", () => {
      closeOverlay();
      postComment(tweetArticle, text);
    });
    card.appendChild(btn);
  });

  // Divider
  const divider = document.createElement("div");
  divider.style.cssText = `
    display: flex; align-items: center; gap: 10px; color: #555;
    font-size: 13px;
  `;
  const line = () => {
    const l = document.createElement("div");
    l.style.cssText = "flex:1; height:1px; background:#2f3336;";
    return l;
  };
  divider.appendChild(line());
  divider.appendChild(document.createTextNode("or"));
  divider.appendChild(line());
  card.appendChild(divider);

  // Custom text area
  const inputWrap = document.createElement("div");
  inputWrap.style.cssText = `
    display: flex; flex-direction: column; gap: 8px;
  `;

  const textarea = document.createElement("textarea");
  textarea.placeholder = "Type a custom comment…";
  textarea.rows = 3;
  textarea.style.cssText = `
    all: unset; display: block; width: 100%; box-sizing: border-box;
    padding: 11px 14px; border-radius: 12px;
    border: 1px solid #2f3336; background: #16181c; color: #e7e9ea;
    font-size: 15px; resize: none; line-height: 1.5;
    transition: border-color 0.15s;
  `;
  textarea.onfocus = () => { textarea.style.borderColor = "#1d9bf0"; };
  textarea.onblur  = () => { textarea.style.borderColor = "#2f3336"; };

  const sendBtn = document.createElement("button");
  sendBtn.textContent = "Send";
  sendBtn.style.cssText = `
    all: unset; display: block; width: 100%; box-sizing: border-box;
    padding: 10px; border-radius: 9999px;
    background: #e7e9ea; color: #0f1419;
    font-size: 15px; font-weight: 700; cursor: pointer;
    text-align: center; transition: background 0.15s;
  `;
  sendBtn.onmouseenter = () => { sendBtn.style.background = "#d0d3d4"; };
  sendBtn.onmouseleave = () => { sendBtn.style.background = "#e7e9ea"; };
  sendBtn.addEventListener("click", () => {
    const text = textarea.value.trim();
    if (!text) { textarea.focus(); return; }
    closeOverlay();
    postComment(tweetArticle, text);
  });

  // Also allow Ctrl/Cmd+Enter to send from textarea
  textarea.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      sendBtn.click();
    }
  });

  inputWrap.appendChild(textarea);
  inputWrap.appendChild(sendBtn);
  card.appendChild(inputWrap);

  // Cancel link
  const cancel = document.createElement("button");
  cancel.textContent = "Cancel";
  cancel.style.cssText = `
    all: unset; display: block; text-align: center;
    color: #71767b; font-size: 14px; cursor: pointer;
    padding: 4px; transition: color 0.15s;
  `;
  cancel.onmouseenter = () => { cancel.style.color = "#e7e9ea"; };
  cancel.onmouseleave = () => { cancel.style.color = "#71767b"; };
  cancel.addEventListener("click", closeOverlay);
  card.appendChild(cancel);

  overlay.appendChild(card);
  document.body.appendChild(overlay);

  // Close on backdrop click
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeOverlay();
  });

  // Close on Escape
  const escHandler = (e) => {
    if (e.key === "Escape") { closeOverlay(); document.removeEventListener("keydown", escHandler); }
  };
  document.addEventListener("keydown", escHandler);

  // Auto-focus first preset (keyboard-friendly)
  card.querySelector("button").focus();

  function closeOverlay() {
    overlay.remove();
  }
}

// ── Post the comment via backend ─────────────────────────────

async function postComment(tweetArticle, text) {
  const tweet_id = getTweetId(tweetArticle);
  if (!tweet_id) {
    showToast("❌ Could not find tweet ID", "error");
    console.warn("[QuickComment] Could not extract tweet ID");
    return;
  }

  showToast("⏳ Posting…", "info");

  try {
    const encryptedPayload = await encryptCommentPayload({ tweet_id, text });
    const res = await fetch(BACKEND_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(encryptedPayload)
    });

    if (res.status !== 202 && !res.ok) {
      const err = await res.text();
      throw new Error(`${res.status}: ${err}`);
    }

    showToast("✅ Comment posted!", "success");
    console.log("[QuickComment] Posted encrypted comment to", tweet_id);
  } catch (err) {
    showToast("❌ Failed: " + err.message, "error");
    console.error("[QuickComment] Failed:", err);
  }
}

// ── Toast notification ────────────────────────────────────────

function showToast(message, type = "info") {
  document.getElementById("qc-toast")?.remove();
  const toast = document.createElement("div");
  toast.id = "qc-toast";
  const colors = { info: "#1d9bf0", success: "#00ba7c", error: "#f4212e" };
  toast.style.cssText = `
    position: fixed; bottom: 28px; left: 50%; transform: translateX(-50%);
    z-index: 999999; padding: 12px 22px; border-radius: 9999px;
    background: ${colors[type] ?? colors.info}; color: #fff;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    font-size: 15px; font-weight: 600;
    box-shadow: 0 4px 20px rgba(0,0,0,0.4);
    pointer-events: none;
    animation: qc-fadein 0.2s ease;
  `;
  toast.textContent = message;

  // Inject keyframes once
  if (!document.getElementById("qc-styles")) {
    const style = document.createElement("style");
    style.id = "qc-styles";
    style.textContent = `@keyframes qc-fadein { from { opacity:0; transform:translateX(-50%) translateY(8px); } to { opacity:1; transform:translateX(-50%) translateY(0); } }`;
    document.head.appendChild(style);
  }

  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}

// ── Inject menu item ──────────────────────────────────────────

function injectMenuItem(menu, tweetArticle) {
  if (menu.querySelector("[data-quick-comment]")) return;

  const existingItem = menu.querySelector('[role="menuitem"]');
  if (!existingItem) return;

  const item = existingItem.cloneNode(true);
  item.setAttribute("data-quick-comment", "true");

  // Update label text
  const labelSpans = [...item.querySelectorAll("span")].filter(
    s => s.textContent.trim().length > 0 && !s.children.length
  );
  if (labelSpans.length > 0) {
    labelSpans.forEach(s => { s.textContent = MENU_LABEL; });
  } else {
    item.textContent = MENU_LABEL;
  }

  // Replace icons with emoji
  item.querySelectorAll("svg").forEach(svg => {
    const span = document.createElement("span");
    span.textContent = "💬";
    span.style.cssText = "font-size:18px; margin-right:4px;";
    svg.replaceWith(span);
  });

  item.style.cursor = "pointer";

  item.addEventListener("click", (e) => {
    e.stopPropagation();
    e.preventDefault();

    // Close X's dropdown
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    setTimeout(() => showPicker(tweetArticle), 150);
  });

  menu.appendChild(item);
}

// ── Watch for X's dropdown to open ───────────────────────────

const observer = new MutationObserver((mutations) => {
  for (const mutation of mutations) {
    for (const node of mutation.addedNodes) {
      if (!(node instanceof HTMLElement)) continue;

      const menu = node.matches('[role="menu"]') ? node : node.querySelector('[role="menu"]');
      if (!menu) continue;

      const openCaret = document.querySelector(
        'article[data-testid="tweet"] [data-testid="caret"][aria-expanded="true"], ' +
        'article[data-testid="tweet"] button[aria-haspopup="menu"][aria-expanded="true"]'
      );

      const tweetArticle = openCaret
        ? openCaret.closest('article[data-testid="tweet"]')
        : document.querySelector('article[data-testid="tweet"]:hover');

      if (!tweetArticle) continue;

      setTimeout(() => injectMenuItem(menu, tweetArticle), 80);
    }
  }
});

observer.observe(document.body, { childList: true, subtree: true });
console.log("[QuickComment] Extension active on", location.hostname);
