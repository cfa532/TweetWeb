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
    const now = Date.now(); // Current timestamp in milliseconds
    const diffInMilliseconds = now - t; // Difference in milliseconds

    // Convert milliseconds to various units
    const diffInSeconds = Math.floor(diffInMilliseconds / 1000);
    const diffInMinutes = Math.floor(diffInSeconds / 60);
    const diffInHours = Math.floor(diffInMinutes / 60);
    const diffInDays = Math.floor(diffInHours / 24);
    const diffInWeeks = Math.floor(diffInDays / 7);
    const diffInMonths = Math.floor(diffInDays / 30.44); // Average days in a month
    const diffInYears = Math.floor(diffInDays / 365.25); // Average days in a year accounting for leap years

    // Determine the appropriate unit to display
    if (diffInSeconds < 60) {
        return `${diffInSeconds} seconds ago`;
    } else if (diffInMinutes < 60) {
        return `${diffInMinutes+1} minutes ago`;
    } else if (diffInHours < 24) {
        return `${diffInHours+1} hours ago`;
    } else if (diffInDays < 7) {
        return `${diffInDays+1} days ago`;
    } else if (diffInWeeks < 4) {
        return `${diffInWeeks+1} weeks ago`;
    } else if (diffInMonths < 12) {
        return `${diffInMonths+1} months ago`;
    } else {
        return `${diffInYears+1} years ago`;
    }
}

export { formatTimeDifference }