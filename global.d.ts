type MimeiId = string;

interface Gtag {
    (...args: any[]): void;
}

interface Window {
    mmInfo: any       // add to window obj for testing convenience
    getParam: any
    hprose: any
    lapi: any         // Leither api handler
    dataLayer: any[];
    gtag: Gtag;
};

interface User {
    mid: MimeiId;
    avatar?: string;
    username: string;
    name?: string;
    profile?: string;
    agentPublicKey?: string;
    hostIds?: MimeiId[];  // Array of host IDs, where hostIds[0] may be read host and hostIds[1] may be write host
    providerIp?: string;  // Provider's IP that has write permission
    baseUrl?: string;
    writableUrl?: string;
    writableHostIp?: string | null;  // Cached writable host IP, fetched lazily when needed
    client?: any;       // Hprose client handler
    timestamp: string | number;
    followingCount?: number;
    followersCount?: number;
    tweetCount?: number;
    bookmarksCount?: number;
    favoritesCount?: number;
    commentsCount?: number;
    lastLogin?: number;
    cloudDrivePort?: number;  // Port for backend service (undefined/null/0 means no service)
    domainToShare?: string;
    hostUrl?: string;
};

interface Tweet {
    mid: MimeiId;
    authorId: MimeiId;
    author: User;
    content?: string;
    title?: string;
    attachments?: MimeiFileType[];
    timestamp: string | number;
    originalTweetId?: MimeiId;
    originalTweet?: Tweet | null;
    originalAuthorId?: MimeiId;
    /** Immediate parent tweet/comment for comments and replies. */
    parentTweetId?: MimeiId;
    /** Saved-list-only embedded parent; never persisted as retweet state. */
    savedParentTweet?: Tweet | null;
    /** Parent author whose root stores this comment; runtime-only. */
    interactionHostAuthor?: User | null;
    favoriteOverride?: boolean;
    bookmarkOverride?: boolean;
    comments?: Tweet[];

    likeCount?: number;
    /** Per-appUser flags returned by the server for this tweet:
     *  [0] = favorited, [1] = bookmarked, [2] = retweeted.
     *  Populated server-side based on the appuserid query param;
     *  flipped optimistically by toggleFavorite / toggleBookmark. */
    favorites?: boolean[];
    bookmarkCount?: number;
    retweetCount?: number;
    commentCount?: number;

    provider?: string;       // Hprose client handler
    downloadable?: boolean;
    isPrivate?: boolean;
};

interface ScorePair {
    score: number
    member: string
};

interface FVPair {
    field: string
    value: any
};

// Type of passing attachments as Mimei
interface MimeiFileType {
    mid: string
    type: string
    size?: number
    fileName?: string
    timestamp: string | number
    aspectRatio?: number    // for video files
    playlist?: string       // Cached resolved HLS playlist filename (e.g. master.m3u8)

    // not saved in Mimei DB, for display only. The value is assigned from Tweet's downloadable
    // upload render the attachment.
    downloadable?: boolean
};

// File type returned by network drive
type FileSystemItem = {
    userId: MimeiId;    // user who shared the file
    name: string;
    path: string;
    isDirectory: boolean;
    size: number;
    modified: string; // ISO 8601 date string
    url: string;
};
