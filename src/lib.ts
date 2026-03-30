import i18n from './i18n'

// Global Constants
export const v4Only = true;

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