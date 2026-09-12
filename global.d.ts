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
    hostIds?: MimeiId[];  // hostIds[0] is the writable root; hostIds[1] is the ordinary access node
    storageFormat?: string;
    providerIp?: string;  // Current server used for ordinary reads
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
    bookmarkedTweets?: MimeiId[];
    favoriteTweets?: MimeiId[];
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
    storageFormat?: string;
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
