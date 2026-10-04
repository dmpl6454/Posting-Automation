interface RateLimitEntry {
  count: number;
  windowStart: number;
}

interface RateLimitResult {
  success: boolean;
  remaining: number;
  resetAt: Date;
}

interface RateLimiterOptions {
  windowMs: number;
  max: number;
}

export function createRateLimiter(options: RateLimiterOptions) {
  const { windowMs, max } = options;
  const store = new Map<string, RateLimitEntry>();

  // Clean up expired entries every 60 seconds
  const cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of store.entries()) {
      if (now - entry.windowStart >= windowMs) {
        store.delete(key);
      }
    }
  }, 60_000);

  // Allow garbage collection if the process is shutting down
  if (cleanupInterval.unref) {
    cleanupInterval.unref();
  }

  return function checkRateLimit(key: string): RateLimitResult {
    const now = Date.now();
    const entry = store.get(key);

    // If no entry or the window has expired, start a new window
    if (!entry || now - entry.windowStart >= windowMs) {
      store.set(key, { count: 1, windowStart: now });
      return {
        success: true,
        remaining: max - 1,
        resetAt: new Date(now + windowMs),
      };
    }

    // Sliding window: increment the count within the current window
    entry.count += 1;

    const resetAt = new Date(entry.windowStart + windowMs);
    const remaining = Math.max(0, max - entry.count);

    if (entry.count > max) {
      return {
        success: false,
        remaining: 0,
        resetAt,
      };
    }

    return {
      success: true,
      remaining,
      resetAt,
    };
  };
}

// Preset rate limiters
/** 100 requests per minute */
export const apiRateLimiter = createRateLimiter({ windowMs: 60_000, max: 100 });

/** 10 requests per minute */
export const authRateLimiter = createRateLimiter({ windowMs: 60_000, max: 10 });

/** 20 requests per minute */
export const aiRateLimiter = createRateLimiter({ windowMs: 60_000, max: 20 });

/**
 * 30 per minute — repurpose.classifyStyleReference only. It fires automatically
 * from the Repurpose UI (upload, paste, on-blur), so it must not draw from the
 * shared aiRateLimiter budget the user's real generations need.
 */
export const classifyStyleRefRateLimiter = createRateLimiter({ windowMs: 60_000, max: 30 });

/**
 * 5 per 10 minutes, per user — post.generateCarousel only (security review
 * 2026-10-01). One call makes up to 10 AI images over several minutes, and its
 * quota check counts Media rows written only at the END, so parallel calls all
 * pass it. A carousel is a deliberate, slow action; 5 in 10 minutes is far
 * above real use and keeps the race to a few images.
 */
export const carouselRateLimiter = createRateLimiter({ windowMs: 10 * 60_000, max: 5 });

/**
 * 3 phone-OTP SMS sends per hour, per caller (security audit 2026-09-28).
 * user.addPhone sends a real SMS to WHATEVER number is supplied; unlimited it
 * is an SMS-toll-fraud primitive (drive up carrier cost by targeting
 * premium-rate/international numbers) and a way to spam a stranger's phone.
 * 3/hour comfortably covers a real user verifying their own number.
 */
export const addPhoneOtpRateLimiter = createRateLimiter({ windowMs: 60 * 60_000, max: 3 });

/**
 * Per-PHONE OTP issuance caps, keyed via phoneRateLimitKey (security review
 * 2026-10-01). Every send mints a fresh code with attempts = 0, so without a
 * cap send -> 5 guesses -> send reset the attempt limit forever. Keyed on the
 * number rather than the session: sendPhoneOtp is public, so every anonymous
 * caller would share one session bucket. Login and Settings codes have
 * separate buckets so an anonymous caller exhausting a number's login sends
 * can't also block its owner's Settings flow.
 */
export const loginOtpPerPhoneLimiter = createRateLimiter({ windowMs: 60 * 60_000, max: 5 });
export const addPhoneOtpPerPhoneLimiter = createRateLimiter({ windowMs: 60 * 60_000, max: 5 });

/** Digits only, so formatting variants of one number share a bucket. */
export function phoneRateLimitKey(phone: string): string {
  return phone.replace(/\D/g, "") || phone.trim();
}

/**
 * 5 per hour — emailed analytics reports go to an ARBITRARY recipient address,
 * so keep the relay-abuse surface tightly bounded (also audit-logged).
 */
export const emailReportRateLimiter = createRateLimiter({ windowMs: 60 * 60_000, max: 5 });

/**
 * 30 per minute — comment replies are PUBLIC posts made as the org's Facebook
 * Page / Instagram account. A burst of identical replies is exactly what trips
 * Meta's spam classifier (error #368, "temporarily blocked") on the Page AND
 * counts against the shared app's standing, so keep a human-paced ceiling.
 */
export const commentReplyRateLimiter = createRateLimiter({ windowMs: 60_000, max: 30 });

/**
 * 60 per minute per user — every comment.list is a LIVE Graph read against the
 * Page's own rate budget (Meta's Business-Use-Case quota is per Page, per app),
 * the same budget the publish worker spends on that Page.
 */
export const commentReadRateLimiter = createRateLimiter({ windowMs: 60_000, max: 60 });
/** Compose Article mode: category/tag listing of a user's own WordPress site. */
export const wordpressTaxonomyRateLimiter = createRateLimiter({ windowMs: 60_000, max: 30 });

/**
 * Per-PAGE ceilings, keyed on `${platform}:${platformId}` across ALL users and
 * orgs. The same Page can be connected in several workspaces (measured: up to
 * 6), so per-user limits alone would let N users multiply the Page's budget.
 * Human-paced numbers — the inbox makes one read per post opened.
 */
export const commentPageReadLimiter = createRateLimiter({ windowMs: 60_000, max: 120 });
export const commentPageReplyLimiter = createRateLimiter({ windowMs: 60_000, max: 30 });

/** Hide / unhide / delete / like / edit — per user, and per Page across everyone. */
export const commentModerateRateLimiter = createRateLimiter({ windowMs: 60_000, max: 60 });
export const commentPageModerateLimiter = createRateLimiter({ windowMs: 60_000, max: 60 });

/**
 * Instagram LIKES, per Instagram account across everyone (2026-09-23). Meta's
 * User Likes reference: "more than 50 requests in 5 seconds results in a 1-hour
 * lockout for the Instagram User". The per-minute budgets above allow such a
 * burst, and a lockout of a live publishing account is not worth the risk, so
 * likes get their own tight window: 10 per 10s — even a burst straddling two
 * fixed windows stays near 20, far under Meta's 50-in-5s.
 */
export const commentIgLikeBurstLimiter = createRateLimiter({ windowMs: 10_000, max: 10 });
