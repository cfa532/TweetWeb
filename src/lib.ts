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
