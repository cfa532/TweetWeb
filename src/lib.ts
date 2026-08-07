import i18n from './i18n'

// Global Constants
export const v4Only = true;

type NavigationPerformance = Pick<Performance, 'getEntriesByType'>

/** True only when this document was created by an explicit browser reload. */
export function isBrowserReload(
    performanceApi: NavigationPerformance | undefined = typeof performance === 'undefined' ? undefined : performance,
    currentHref: string | undefined = typeof location === 'undefined' ? undefined : location.href,
): boolean {
    const navigation = performanceApi?.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined
    if (navigation?.type !== 'reload' || !navigation.name || !currentHref) return false
    try {
        const loadedUrl = new URL(navigation.name, currentHref)
        const currentUrl = new URL(currentHref)
        return loadedUrl.pathname === currentUrl.pathname && loadedUrl.search === currentUrl.search
    } catch {
        return false
    }
}

/** Mirrors iOS: resync only when the current read node is not the root node. */
export function shouldResyncUser(user: Pick<User, 'hostIds'> | undefined | null): boolean {
    const rootHostId = user?.hostIds?.[0]
    if (!rootHostId) return false
    const readHostId = user?.hostIds?.[1] ?? rootHostId
    return readHostId !== rootHostId
}

/**
 * Whether a tweet belongs under its parent rather than in a tweet list.
 *
 * A parent reference alone does not make a row a comment: a quote tweet is
 * published as a standalone tweet and carries both references — originalTweetId
 * for what it quotes, and parentTweetId for the tweet its body was written on.
 * Only a row with a parent and nothing quoted is a plain comment.
 */
export function isCommentTweet(
    tweet: Pick<Tweet, 'parentTweetId' | 'originalTweetId'> | undefined | null,
): boolean {
    if (!tweet) return false
    return !!tweet.parentTweetId && !tweet.originalTweetId
}

// Media Type Constants
export const MEDIA_TYPES = {
    IMAGE: 'image',
    VIDEO: 'video',
    HLS_VIDEO: 'hls_video',
    AUDIO: 'audio',
    UNKNOWN: 'unknown'
} as const;

export type MediaType = typeof MEDIA_TYPES[keyof typeof MEDIA_TYPES];

/**
 * Normalizes media type string to lowercase for consistent comparison
 * @param type The media type string to normalize
 * @returns Normalized lowercase media type
 */
export function normalizeMediaType(type: string | undefined): string {
    if (!type) return MEDIA_TYPES.UNKNOWN;
    return type.toLowerCase().trim();
}

/**
 * Resolves a user's avatar to a displayable URL, falling back to the
 * app's default logo when the avatar is missing/blank.
 */
export function avatarSrc(avatar: string | undefined | null): string {
    return avatar && avatar.trim() !== '' ? avatar : import.meta.env.VITE_APP_LOGO;
}

/** Canonical public URL used by every TweetWeb tweet sharing surface. */
export function tweetShareUrl(
    tweet: Pick<Tweet, 'mid' | 'authorId' | 'author'>,
    origin: string = window.location.origin,
): string {
    const authorId = tweet.author?.mid || tweet.authorId;
    return `${origin}/#tweet/${tweet.mid}${authorId ? '/' + authorId : ''}`;
}

/** Normalize a URL only when its host is a strictly public IPv4 address. */
export function publicIPv4BaseUrl(value: string | undefined | null): string | undefined {
    const raw = String(value ?? '').trim();
    if (!raw) return undefined;

    const normalized = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
    let parsed: URL;
    try {
        parsed = new URL(normalized);
    } catch {
        return undefined;
    }

    const match = parsed.hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (!match) return undefined;
    const [a, b, c] = match.slice(1).map(Number);
    if (match.slice(1).some(part => Number(part) > 255)) return undefined;

    const nonPublic =
        a === 0 || a === 10 || a === 127 || a >= 224 ||
        (a === 100 && b >= 64 && b <= 127) ||             // RFC 6598 / Tailscale
        (a === 169 && b === 254) ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168) ||
        (a === 192 && b === 0 && (c === 0 || c === 2)) ||
        (a === 192 && b === 88 && c === 99) ||
        (a === 198 && b >= 18 && b <= 19) ||
        (a === 198 && b === 51 && c === 100) ||
        (a === 203 && b === 0 && c === 113);
    if (nonPublic) return undefined;

    const port = parsed.port ? `:${parsed.port}` : '';
    return `${parsed.protocol}//${parsed.hostname}${port}`;
}

/**
 * Public-provider IPv4 entry URL. No share surface selects it today — both the
 * feed and the detail corner menu use `tweetShareUrl` — but it is kept for a link
 * that works without DNS.
 *
 * Composition:
 * ```
 * http://{public IPv4[:port]}/entry?aid={appId}&ver=last#/tweet/{mid}/{authorId}
 * ```
 * - host — first candidate among `providerOverride`, `author.baseUrl`,
 *   `tweet.provider`, `author.providerIp` that survives `publicIPv4BaseUrl()`,
 *   which rejects anything that is not a strictly public IPv4: private ranges,
 *   RFC 6598 / Tailscale CGNAT, link-local, multicast, IPv6, and hostnames. The
 *   function returns undefined when no candidate qualifies.
 * - `/entry` — Leither's SPA entry point; it needs `aid` + `ver` as *query* params
 *   to load the app bundle, which is why they sit before the `#`.
 * - the route lives in the hash so the node serves `/entry` and the SPA router
 *   resolves `#/tweet/...` client-side.
 */
export function tweetProviderShareUrl(
    tweet: Pick<Tweet, 'mid' | 'authorId' | 'author' | 'provider'>,
    appId: string,
    providerOverride?: string,
): string | undefined {
    const baseUrl = [providerOverride, tweet.author?.baseUrl, tweet.provider, tweet.author?.providerIp]
        .map(publicIPv4BaseUrl)
        .find((candidate): candidate is string => candidate !== undefined);
    if (!baseUrl) return undefined;
    return `${baseUrl}/entry?aid=${encodeURIComponent(appId)}&ver=last#/tweet/${tweet.mid}/${tweet.authorId}`;
}

/** Copy text in both secure Clipboard API contexts and legacy HTTP hosts. */
export async function copyTextToClipboard(text: string): Promise<void> {
    if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return;
    }

    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    document.body.removeChild(textarea);
}

/**
 * Checks if a media type is a video (includes both regular and HLS video)
 * @param type The media type to check
 * @returns True if the type is any kind of video
 */
export function isVideoType(type: string | undefined): boolean {
    const normalized = normalizeMediaType(type);
    return normalized === MEDIA_TYPES.VIDEO || normalized === MEDIA_TYPES.HLS_VIDEO;
}

/**
 * Checks if a media type is an image
 * @param type The media type to check
 * @returns True if the type is an image
 */
export function isImageType(type: string | undefined): boolean {
    return normalizeMediaType(type) === MEDIA_TYPES.IMAGE;
}

/**
 * Checks if a media type is audio
 * @param type The media type to check
 * @returns True if the type is audio
 */
export function isAudioType(type: string | undefined): boolean {
    return normalizeMediaType(type) === MEDIA_TYPES.AUDIO;
}

function formatTimeDifference(t: number) {
    const tr = i18n.global.t

    const now = Date.now();
    const diffInMilliseconds = now - t;

    const diffInSeconds = Math.floor(diffInMilliseconds / 1000);
    const diffInMinutes = Math.floor(diffInSeconds / 60);
    const diffInHours = Math.floor(diffInMinutes / 60);
    const diffInDays = Math.floor(diffInHours / 24);
    const diffInWeeks = Math.floor(diffInDays / 7);
    const diffInMonths = Math.floor(diffInDays / 30.44);
    const diffInYears = Math.floor(diffInDays / 365.25);

    if (diffInSeconds < 60) {
        return tr('time.secondsAgo', { n: diffInSeconds });
    } else if (diffInMinutes < 60) {
        return tr('time.minutesAgo', { n: diffInMinutes + 1 });
    } else if (diffInHours < 24) {
        return tr('time.hoursAgo', { n: diffInHours + 1 });
    } else if (diffInDays < 7) {
        return tr('time.daysAgo', { n: diffInDays + 1 });
    } else if (diffInWeeks < 4) {
        return tr('time.weeksAgo', { n: diffInWeeks + 1 });
    } else if (diffInMonths < 12) {
        return tr('time.monthsAgo', { n: diffInMonths + 1 });
    } else {
        return tr('time.yearsAgo', { n: diffInYears + 1 });
    }
}

/**
 * Checks if the user is using WeChat browser
 * @returns True if the user agent indicates WeChat browser
 */
export function isWeChatBrowser(): boolean {
    return /MicroMessenger/i.test(navigator.userAgent);
}

export { formatTimeDifference }
