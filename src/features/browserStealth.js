// browserStealth.js — the two things that make an automated browser look like
// a browser, and stop a page from being unusable once it loads.
//
// WHY
//
// Two failure modes account for most "the browser doesn't work" reports, and
// neither shows up as an error:
//
//   1. BOT DETECTION. Chrome in automation mode reports navigator.webdriver =
//      true. That single property is the most widely used bot signal on the
//      web. Sites respond by serving a captcha, an "Access Denied" page, or a
//      stripped-down version with the content removed. Nothing throws — you
//      just get the wrong page. The --disable-blink-features=AutomationControlled
//      launch flag helps but does NOT clear navigator.webdriver on its own.
//
//   2. CONSENT WALLS. A large share of sites open with a full-screen cookie or
//      consent dialog. It covers the page, so every subsequent click lands on
//      the overlay instead of the thing you aimed at, and extraction returns
//      the dialog's text rather than the content. The page loaded fine, which
//      is why this looks like a mystery.
//
// Both are fixed here, once, for every page.

/**
 * Runs before any page script, in every frame.
 *
 * Kept deliberately small. Over-patching is itself detectable — a page can
 * check that navigator has the right shape, and an inconsistent profile is
 * more suspicious than a plain one.
 */
const STEALTH_SCRIPT = `
(() => {
  try {
    // 1. The big one. Automation sets this true; nothing else does.
    Object.defineProperty(navigator, 'webdriver', { get: () => false, configurable: true });
  } catch (e) {}

  try {
    // 2. A headless browser has no plugins. Real Chrome has several.
    const fake = [
      { name: 'PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
      { name: 'Chrome PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
      { name: 'Chromium PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
    ];
    Object.defineProperty(navigator, 'plugins', { get: () => fake, configurable: true });
    Object.defineProperty(navigator, 'mimeTypes', { get: () => [{ type: 'application/pdf' }], configurable: true });
  } catch (e) {}

  try {
    // 3. Headless defaults to a single bare locale.
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'], configurable: true });
  } catch (e) {}

  try {
    // 4. window.chrome is absent in headless and present in real Chrome.
    if (!window.chrome) {
      window.chrome = { runtime: {}, loadTimes: () => {}, csi: () => {}, app: { isInstalled: false } };
    }
  } catch (e) {}

  try {
    // 5. Headless reports a notification permission of "denied" while also
    //    claiming to be a normal browser. Make the two agree.
    const orig = window.navigator.permissions && window.navigator.permissions.query;
    if (orig) {
      window.navigator.permissions.query = (params) =>
        params && params.name === 'notifications'
          ? Promise.resolve({ state: Notification.permission })
          : orig.call(window.navigator.permissions, params);
    }
  } catch (e) {}

  try {
    // 6. Headless lacks a real GPU, so the renderer string gives it away.
    const gl = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
      const ctx = gl.call(this, type, ...rest);
      if (ctx && (type === 'webgl' || type === 'experimental-webgl')) {
        const dbg = ctx.getExtension && ctx.getExtension('WEBGL_debug_renderer_info');
        if (dbg) {
          const patch = (fn) => function (p) {
            if (p === dbg.UNMASKED_VENDOR_WEBGL) return 'Intel Inc.';
            if (p === dbg.UNMASKED_RENDERER_WEBGL) return 'Intel Iris OpenGL Engine';
            return fn.call(this, p);
          };
          ctx.getParameter = patch(ctx.getParameter);
        }
      }
      return ctx;
    };
  } catch (e) {}
})();
`;

/**
 * Install the stealth script on a page, whichever engine it is.
 * Must run BEFORE the first navigation to take effect.
 */
async function applyStealth(page) {
  try {
    // Puppeteer
    if (typeof page.evaluateOnNewDocument === 'function') {
      await page.evaluateOnNewDocument(STEALTH_SCRIPT);
      return true;
    }
    // Playwright
    if (typeof page.addInitScript === 'function') {
      await page.addInitScript(STEALTH_SCRIPT);
      return true;
    }
  } catch {
    // Never let this break a browse. Worst case the page looks automated.
  }
  return false;
}

/** Playwright: set it once on the context so every page gets it. */
async function applyStealthToContext(context) {
  try {
    if (typeof context.addInitScript === 'function') {
      await context.addInitScript(STEALTH_SCRIPT);
      return true;
    }
  } catch {}
  return false;
}

// Consent / cookie dialogs, most common first. Matched on visible text and on
// the id/class patterns the big consent platforms actually ship.
const CONSENT_SELECTORS = [
  '#onetrust-accept-btn-handler',
  '#onetrust-banner-sdk button#onetrust-accept-btn-handler',
  'button[aria-label*="accept" i]',
  'button[data-testid*="accept" i]',
  '[id*="cookie" i] button[class*="accept" i]',
  '[class*="cookie" i] button[class*="accept" i]',
  '[class*="consent" i] button[class*="accept" i]',
  '.cc-btn.cc-allow',
  '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',
  '#CybotCookiebotDialogBodyButtonAccept',
  'button#truste-consent-button',
  'button[aria-label="Agree" i]',
  'button[aria-label="Accept all" i]',
];

const CONSENT_TEXT = [
  'Accept all cookies',
  'Accept all',
  'Allow all',
  'Accept cookies',
  'I agree',
  'Agree and continue',
  'Got it',
  'OK, got it',
  'Allow cookies',
  'Accept',
];

/**
 * Clear a consent wall if one is covering the page.
 *
 * Best-effort by design: a miss is harmless, and this must never throw into a
 * caller that is mid-navigation.
 *
 * Returns the label it clicked, or null.
 */
async function dismissConsent(page, opts = {}) {
  const timeout = opts.timeout ?? 2500;

  // 1. Known ids/classes.
  for (const sel of CONSENT_SELECTORS) {
    try {
      const el = await page.$(sel);
      if (el) {
        const visible = await el.isIntersectingViewport?.().catch(() => true);
        if (visible !== false) {
          await el.click().catch(() => {});
          return sel;
        }
      }
    } catch {}
  }

  // 2. Visible text, via an in-page search so it also reaches shadow roots and
  //    iframes that a selector cannot.
  try {
    const clicked = await page.evaluate((labels) => {
      const clickable = Array.from(document.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"]'));
      for (const label of labels) {
        const target = label.toLowerCase();
        for (const el of clickable) {
          const text = (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().toLowerCase();
          if (text === target) {
            const r = el.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) {
              el.click();
              return el.innerText || label;
            }
          }
        }
      }
      return null;
    }, CONSENT_TEXT);

    if (clicked) {
      // Give the overlay a moment to animate away before the caller interacts.
      await page.waitForTimeout?.(300).catch(() => {});
      return clicked;
    }
  } catch {}

  return null;
}

/**
 * Is the page basically empty?
 *
 * A JS-heavy site returns from domcontentloaded before it renders, so the
 * extraction comes back as a near-empty string and looks like a scraping bug.
 * Detecting it lets the caller escalate the wait instead of reporting nothing.
 */
async function isContentThin(page, minChars = 250) {
  try {
    const text = await page.evaluate(() => {
      const body = document.body;
      if (!body) return '';
      return (body.innerText || '').trim();
    });
    return String(text || '').length < minChars;
  } catch {
    return false;
  }
}

module.exports = {
  STEALTH_SCRIPT,
  applyStealth,
  applyStealthToContext,
  dismissConsent,
  isContentThin,
  CONSENT_SELECTORS,
  CONSENT_TEXT,
};
