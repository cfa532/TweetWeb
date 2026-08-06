import { defineStore } from 'pinia';
import { reactive } from 'vue';
import { useLeitherStore } from './leitherStore';
import { useAlertStore } from './alert.store';
import { createPooledClient } from '@/utils/clientProxy';
import { nodePool } from '@/utils/nodePool';
import { normalizeMediaType, publicIPv4BaseUrl, v4Only } from '@/lib';
import { browserUsableProviderRoutes } from '@/utils/browserNetwork';
import i18n from '@/i18n';
import { ed25519 } from '@noble/curves/ed25519.js';

const GUEST_ID = "000000000000000000000000000"
const LOCAL_TWEET_CACHE_TTL = 72 * 60 * 60 * 1000
const LOCAL_USER_CACHE_TTL = 72 * 60 * 60 * 1000
const HEALTH_CHECK_CACHE_TTL = 30 * 60 * 1000
const HEALTH_CHECK_FAILURE_TTL = 60 * 1000      // unhealthy verdicts expire fast; see getFreshHealthStatus
const USER_FETCH_COOLDOWN_BASE_MS = 30 * 1000   // 30s base; doubles each consecutive failure
const USER_FETCH_COOLDOWN_MAX_MS  = 10 * 60 * 1000  // cap at 10 min
const LOGIN_USER_STORAGE_KEY = "user"
const TOGGLE_MUTATION_TIMEOUT_MS = 60_000
const UPDATE_FOLLOWING_TWEETS_TIMEOUT_MS = 30_000
const UPDATE_TWEET_TIMEOUT_MS = 30_000

type ExpiringLocalCache<T> = {
    cachedAt: number
    value: T
}

type SavedListType = 'bookmark_list' | 'favorite_list'

function savedListCacheKey(userId: string, type: SavedListType): string {
    return `saved_tweets_${type}_${userId}`
}

function unwrapNestedV2Map(response: any): Record<string, any> | null {
    let current = response
    for (let depth = 0; depth < 3; depth++) {
        if (!current || typeof current !== 'object' || Array.isArray(current)) return null
        if (current.success === false) return null
        if (current.success === true && current.data && typeof current.data === 'object') {
            current = current.data
            continue
        }
        return current
    }
    return current && typeof current === 'object' ? current : null
}

/**
 * Comma-separated ids from `VITE_DEFAULT_FOLLOWINGS`: same role as iOS `AppConfig.alphaId` /
 * `Gadget.getAlphaIds()` — guest following seed and post-register auto-follow targets.
 */
function defaultFollowingIdsFromEnv(): string[] {
    const raw = import.meta.env.VITE_DEFAULT_FOLLOWINGS as string | undefined
    if (!raw || !String(raw).trim()) return []
    return String(raw)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
}

/** v2 register response body: { success, data?: { user } } or { success, user } */
function registerResponseBody(ret: any): any {
    if (!ret) return undefined
    const body = ret.data != null && typeof ret.data === 'object' ? ret.data : ret
    return body
}

/** v2 get_tweets_by_user: same as iOS unwrap — body is `data` when present, else top-level. */
function tweetsByUserResponseBody(ret: any): any {
    if (!ret || ret.success !== true) return ret
    if (ret.data != null && typeof ret.data === 'object' && !Array.isArray(ret.data)) {
        return ret.data
    }
    return ret
}

/** Quoted tweets inlined on list rows (originalTweets array often empty). */
function collectNestedOriginalTweetsFromRows(tweetsData: any[] | undefined): any[] {
    const out: any[] = []
    if (!tweetsData) return out
    for (const row of tweetsData) {
        if (row == null) continue
        const nested = row.originalTweet ?? row.original_tweet
        if (nested != null && typeof nested === 'object' && nested.mid) {
            out.push(nested)
        }
    }
    return out
}

function tweetHasOwnBody(tweet: Pick<Tweet, 'title' | 'content' | 'attachments'> | undefined | null): boolean {
    if (!tweet) return false
    if (typeof tweet.title === 'string' && tweet.title.trim()) return true
    if (typeof tweet.content === 'string' && tweet.content.trim()) return true
    return Array.isArray(tweet.attachments) && tweet.attachments.length > 0
}

/** Remove a deleted tweet and any unusable pure-retweet wrappers from a cached list. */
function withoutDeletedTweet(
    tweets: Tweet[],
    deletedTweetId: MimeiId,
): { tweets: Tweet[]; removedIds: Set<MimeiId> } {
    const removedIds = new Set<MimeiId>()
    const remaining: Tweet[] = []

    for (const tweet of tweets) {
        if (tweet.mid === deletedTweetId) {
            removedIds.add(tweet.mid)
            continue
        }

        const referencesDeletedTweet = tweet.originalTweetId === deletedTweetId
            || tweet.originalTweet?.mid === deletedTweetId
        if (referencesDeletedTweet && !tweetHasOwnBody(tweet)) {
            // A pure retweet has no content without its deleted original.
            removedIds.add(tweet.mid)
            continue
        }

        let sanitized = tweet
        if (referencesDeletedTweet) {
            // `undefined` means a quote can still render its own body without
            // the original; `null` is reserved for an unresolved pure retweet.
            sanitized = { ...sanitized, originalTweet: undefined }
        }
        if (sanitized.savedParentTweet?.mid === deletedTweetId) {
            sanitized = { ...sanitized, savedParentTweet: null }
        }
        remaining.push(sanitized)
    }

    return { tweets: remaining, removedIds }
}

/**
 * v2 toggle_followed payload: unwrap nested { success, data } (delegation used to double-wrap).
 * @throws on { success: false } or non-boolean isFollowing
 */
function parseToggleFollowedV2Result(ret: unknown): boolean {
    let cursor: unknown = ret
    for (let depth = 0; depth < 3 && cursor && typeof cursor === "object"; depth++) {
        const o = cursor as { success?: boolean; data?: unknown; message?: string }
        if (o.success === false) {
            throw new Error(typeof o.message === "string" ? o.message : "toggle_followed failed")
        }
        if (o.success === true && "data" in o && o.data !== undefined) {
            cursor = o.data
            continue
        }
        break
    }
    const response = cursor
    if (typeof (response as { isFollowing?: unknown })?.isFollowing === "boolean") {
        return (response as { isFollowing: boolean }).isFollowing
    }
    if (typeof response === "boolean") return response
    throw new Error("Invalid response from toggle_followed")
}

/** host:port (or [v6]:port) for connection pool / WebSocket `ws://…/ws/`. */
type RegisterSuccessUser = {
    mid?: string
    user?: any
}

type AgentToken = {
    version: number
    mimeiId: string
    privateKey: string
    publicKey: string
    createdAt: number
    scope: string[]
}

function bytesToBase64(bytes: Uint8Array): string {
    let binary = ""
    for (const byte of bytes) {
        binary += String.fromCharCode(byte)
    }
    return btoa(binary)
}

function utf8ToBase64(value: string): string {
    return bytesToBase64(new TextEncoder().encode(value))
}

function base64UrlToBase64(value: string): string {
    const base64 = value.replace(/-/g, "+").replace(/_/g, "/")
    return base64.padEnd(Math.ceil(base64.length / 4) * 4, "=")
}

async function createAgentTokenForUser(mimeiId: string, scope: string[] = ["post", "comment"]): Promise<{ tokenString: string, publicKey: string }> {
    let privateKeyBytes: Uint8Array
    let publicKeyBytes: Uint8Array

    if (globalThis.crypto?.subtle) {
        const keyPair = await globalThis.crypto.subtle.generateKey(
            { name: "Ed25519" },
            true,
            ["sign", "verify"]
        )
        if (!("privateKey" in keyPair) || !("publicKey" in keyPair)) {
            throw new Error("Failed to generate agent token keypair")
        }

        const [privateJwk, publicJwk] = await Promise.all([
            globalThis.crypto.subtle.exportKey("jwk", keyPair.privateKey),
            globalThis.crypto.subtle.exportKey("jwk", keyPair.publicKey),
        ])

        if (typeof privateJwk.d !== "string" || typeof publicJwk.x !== "string") {
            throw new Error("Failed to export agent token keypair")
        }

        privateKeyBytes = Uint8Array.from(atob(base64UrlToBase64(privateJwk.d)), c => c.charCodeAt(0))
        publicKeyBytes = Uint8Array.from(atob(base64UrlToBase64(publicJwk.x)), c => c.charCodeAt(0))
    } else {
        // Fallback for non-secure contexts (HTTP): use pure-JS Ed25519 implementation
        privateKeyBytes = ed25519.utils.randomSecretKey()
        publicKeyBytes = ed25519.getPublicKey(privateKeyBytes)
    }

    const token: AgentToken = {
        version: 1,
        mimeiId,
        privateKey: bytesToBase64(privateKeyBytes),
        publicKey: bytesToBase64(publicKeyBytes),
        createdAt: Date.now(),
        scope,
    }

    return {
        tokenString: utf8ToBase64(JSON.stringify(token)),
        publicKey: token.publicKey,
    }
}

function parseRegisterSuccessUser(ret: any): RegisterSuccessUser {
    if (!ret) return {}
    const success = ret.success === true || ret.success === 1
    if (!success) return {}
    const body = registerResponseBody(ret)
    let u = body?.user
    if (typeof u === 'string') {
        try { u = JSON.parse(u) } catch { return {} }
    }
    if (!u || typeof u !== 'object' || typeof u.mid !== 'string' || !u.mid.length) {
        console.debug('[parseRegisterSuccessUser] mid missing, ret=', JSON.stringify(ret))
        return {}
    }
    return { mid: u.mid, user: u }
}

function parseRegisteredUserMid(ret: any): string | undefined {
    return parseRegisterSuccessUser(ret).mid
}

function firstNodePoolIp(mid: unknown): string | undefined {
    if (typeof mid !== 'string' || !mid) return undefined
    return nodePool.getIPForNode(mid) ?? undefined
}

function firstUserRouteFromNodePool(user: any): string | undefined {
    const accessNodeId = user?.hostIds?.[1] ?? user?.hostIds?.[0]
    return firstNodePoolIp(accessNodeId)
}

function userForSessionStorage(user: any): any {
    if (!user || typeof user !== 'object') return user
    const cached = { ...user }
    delete cached.client
    delete cached.providerIp
    delete cached.baseUrl
    delete cached.writableUrl
    delete cached.writableHostIp
    return cached
}

function tweetForSessionStorage(tweet: any): any {
    if (!tweet || typeof tweet !== 'object') return tweet
    const cached = { ...tweet }
    delete cached.provider
    if (cached.author) {
        cached.author = userForSessionStorage(cached.author)
    }
    if (cached.originalTweet && typeof cached.originalTweet === 'object') {
        cached.originalTweet = { ...cached.originalTweet }
        delete cached.originalTweet.provider
        if (cached.originalTweet.author) {
            cached.originalTweet.author = userForSessionStorage(cached.originalTweet.author)
        }
    }
    return cached
}

function setLocalCache<T>(key: string, value: T) {
    const payload: ExpiringLocalCache<T> = {
        cachedAt: Date.now(),
        value,
    }
    localStorage.setItem(key, JSON.stringify(payload))
}

function getLocalCache<T>(key: string, ttl: number = LOCAL_TWEET_CACHE_TTL): T | null {
    const raw = localStorage.getItem(key)
    if (!raw) return null

    try {
        const parsed = JSON.parse(raw) as Partial<ExpiringLocalCache<T>>
        if (
            !parsed ||
            typeof parsed !== 'object' ||
            typeof parsed.cachedAt !== 'number' ||
            !('value' in parsed)
        ) {
            localStorage.removeItem(key)
            return null
        }

        if (Date.now() - parsed.cachedAt > ttl) {
            localStorage.removeItem(key)
            return null
        }

        return parsed.value as T
    } catch {
        localStorage.removeItem(key)
        return null
    }
}

function getStoredLoginUser(): any | null {
    localStorage.removeItem(LOGIN_USER_STORAGE_KEY)
    const raw = sessionStorage.getItem(LOGIN_USER_STORAGE_KEY)
    if (!raw) return null

    try {
        const user = JSON.parse(raw)
        if (user && typeof user === 'object') {
            return user
        }
    } catch {
        sessionStorage.removeItem(LOGIN_USER_STORAGE_KEY)
    }
    return null
}

function setStoredLoginUser(user: any) {
    sessionStorage.setItem(LOGIN_USER_STORAGE_KEY, JSON.stringify(userForSessionStorage(user)))
    localStorage.removeItem(LOGIN_USER_STORAGE_KEY)
}

function clearStoredLoginUser() {
    sessionStorage.removeItem(LOGIN_USER_STORAGE_KEY)
    localStorage.removeItem(LOGIN_USER_STORAGE_KEY)
}

function setStoredUser(userId: string, user: any) {
    setLocalCache(userId, userForSessionStorage(user))
}

function getStoredUser(userId: string): any | null {
    return getLocalCache<any>(userId, LOCAL_USER_CACHE_TTL)
}

function clearStoredUser(userId: string) {
    localStorage.removeItem(userId)
    sessionStorage.removeItem(userId)
}

function attachNodePoolRoute(user: any, connectionPool: any): boolean {
    const providerIp = firstUserRouteFromNodePool(user)
    if (!providerIp) return false
    user.providerIp = providerIp
    user.client = createPooledClient(providerIp, connectionPool)
    if (user.writableHostIp === undefined) {
        user.writableHostIp = null
    }
    return true
}
const TWEET_COUNT = 5

export const useTweetStore = defineStore('tweetStore', {
    state: () => ({
        tweets: [] as Tweet[],      // tweets
        tweetIndex: new Map<string, Tweet>(),  // O(1) lookup by mid
        interactionOverrides: new Map<string, { favorite?: boolean; bookmark?: boolean }>(),
        optimisticSavedListStates: new Map<string, { favorite?: boolean; bookmark?: boolean }>(),
        savedListTweets: {} as Record<string, Tweet[]>,
        // Mids that belong to the main following feed (loaded by getTweetFeed /
        // updateFollowingTweets). `tweets` is a shared cache that profile and pinned
        // loaders also push into, so the feed banner must count only these — otherwise
        // tweets seen on a profile leak into the main-feed "new tweets" count.
        feedTweetIds: new Set<string>(),
        // Latest page-0 banner-check candidates. The visible banner count is derived
        // from this set, not every cached feed tweet, to match the mobile algorithm.
        feedPendingCandidateIds: new Set<string>(),
        originalTweets: [] as Tweet[],
        originalTweetIndex: new Map<string, Tweet>(),  // O(1) lookup by mid
        users: new Map<MimeiId, User>(),
        _followings: [] as MimeiId[],
        lapi: useLeitherStore(),
        appId: import.meta.env.VITE_MIMEI_APPID,
        installApk: import.meta.env.VITE_APP_PKG,
        _user: null as User | null,      // login user data
        healthCheckCache: new Map<string, {isHealthy: boolean, timestamp: number}>(),
        healthCheckInProgress: new Map<string, Promise<boolean>>(),
        _writableHostCache: new Map<string, {ip: string, expiresAt: number}>(), // keyed by hostId
        _pendingUserFetches: new Map<string, Promise<User | undefined>>(), // Deduplicate concurrent getUser calls
        _resourceFetchFailures: new Map<string, { count: number, cooldownUntil: number }>(), // Per-resource (user/node/media) fetch failure cooldown
        _deletedTweetIds: new Set<string>() // Prevent re-insertion after optimistic delete
    }),
    getters: {
        /**
         * Gets the currently logged in user from state or session storage
         * @returns The logged in user object or null if not logged in
         */
        loginUser: (state): User | null => {
            if (state._user) {
                return state._user
            }
            const storedUser = getStoredLoginUser()
            if (storedUser) {
                let usr = storedUser
                attachNodePoolRoute(usr, state.lapi.connectionPool)
                // Don't trust persisted writableHostIp — re-resolve fresh each session.
                // Matches iOS which explicitly does not encode writableUrl across sessions.
                usr.writableHostIp = null
                state._user = usr
                return usr
            }
            return null
        },

        /**
         * Gets the list of users that the current user is following
         * @returns Array of user IDs that the current user follows
         */
        followings: (state)=> {
            if (state._followings.length > 0)
                return state._followings
            if (sessionStorage.getItem("followings")) {
                state._followings = JSON.parse(sessionStorage.getItem("followings")!)
            } else {
                state._followings = defaultFollowingIdsFromEnv()
                sessionStorage.setItem("followings", JSON.stringify(state._followings))
            }
            return state._followings
        }
    },
    actions: {
        resolvedInteractionFlags(tweet: Tweet): boolean[] {
            const flags = Array.isArray(tweet.favorites)
                ? [...tweet.favorites]
                : [false, false, false]
            while (flags.length < 3) flags.push(false)

            const override = this.interactionOverrides.get(tweet.mid)
            if (override?.favorite !== undefined) flags[0] = override.favorite
            if (override?.bookmark !== undefined) flags[1] = override.bookmark
            return flags
        },

        setInteractionOverride(
            tweetId: string,
            kind: 'favorite' | 'bookmark',
            value: boolean,
        ) {
            const override = this.interactionOverrides.get(tweetId) ?? {}
            this.interactionOverrides.set(tweetId, { ...override, [kind]: value })
        },

        persistLoginUser(user?: User | null) {
            const userToPersist = user ?? this._user
            if (userToPersist) setStoredLoginUser(userToPersist)
        },
        _mergeUserIntoCachedRefs(userId: MimeiId, updates: Partial<User>) {
            const visitedTweets = new WeakSet<Tweet>()
            const mergeUser = (target: User | null | undefined) => {
                if (target?.mid === userId) Object.assign(target, updates)
            }
            const mergeTweetAuthor = (tweet: Tweet | null | undefined) => {
                if (!tweet) return
                if (visitedTweets.has(tweet)) return
                visitedTweets.add(tweet)
                if (tweet.authorId === userId || tweet.author?.mid === userId) {
                    mergeUser(tweet.author)
                }
                for (const comment of tweet.comments ?? []) {
                    mergeTweetAuthor(comment)
                }
                mergeTweetAuthor(tweet.originalTweet)
            }

            mergeUser(this._user)
            const cachedUser = this.users.get(userId)
            if (cachedUser) {
                mergeUser(cachedUser)
            } else if (this._user?.mid === userId) {
                this.users.set(userId, this._user)
            }

            for (const tweet of this.tweets) mergeTweetAuthor(tweet)
            for (const tweet of this.originalTweetIndex.values()) mergeTweetAuthor(tweet)

            const userToStore = this._user?.mid === userId ? this._user : this.users.get(userId)
            if (userToStore) {
                setStoredUser(userId, userToStore)
                if (this._user?.mid === userId) setStoredLoginUser(this._user)
            }
        },
        /**
         * Add a user ID to the following list if not already present
         * @param uid The user ID to add to followings
         */
        addFollowing(uid: string) {
            if (this.followings.indexOf(uid) == -1) {
                this._followings.push(uid)
                sessionStorage.setItem("followings", JSON.stringify(this._followings))
            }
        },
        /**
         * If an userId is given, load tweets of the given user.
         * Otherwise load tweets of login user's followings' tweets.
         * @param authorId 
         * @param pageNumber page number to load (0-based)
         * @param pageSize number of tweets per page
         * @returns the number of tweets received from backend (including null ones)
         */
        async loadTweets(
            authorId: string | undefined = undefined,
            pageNumber: number = 0,
            pageSize: number = TWEET_COUNT
        ): Promise<number | null> {
            if (authorId) {
                return await this.loadTweetsByUser(authorId, pageNumber, pageSize)
            } else {
                // Guest users are redirected to a user profile page, so this is only called for logged-in users.
                return await this.getTweetFeed(this.loginUser!, pageNumber, pageSize)
            }
        },

        /**
         * Clear user/provider caches so next user fetch resolves a fresh provider IP.
         */
        _invalidateUserProviderCache(userId: MimeiId) {
            this.users.delete(userId)
            this._nullifyCachedIp(userId)
        },

        /**
         * Resolve a user for a retry attempt, optionally forcing refresh on first attempt.
         */
        async _getUserForProviderRetryAttempt(
            userId: MimeiId,
            attempt: number,
            refreshOnFirstAttempt: boolean = false
        ): Promise<User | undefined> {
            const shouldRefreshProvider = attempt > 1 || refreshOnFirstAttempt
            if (shouldRefreshProvider) {
                this._invalidateUserProviderCache(userId)
            }
            return this.getUser(userId, shouldRefreshProvider)
        },

        /**
         * Load follower/following IDs with one retry that refreshes provider IP.
         */
        async _loadSortedUserList(
            userId: MimeiId,
            rpcName: "get_followers_sorted" | "get_followings_sorted"
        ): Promise<MimeiId[]> {
            for (let attempt = 1; attempt <= 2; attempt++) {
                const user = await this._getUserForProviderRetryAttempt(userId, attempt)
                if (!user) return []

                try {
                    const list = await user.client.RunMApp(rpcName, {
                        aid: this.appId,
                        ver: "last",
                        userid: userId
                    })
                    return list
                        .sort((a: any, b: any) => b["value"] - a["value"])
                        .slice(0, 200)
                        .map((e: any) => e["field"])
                } catch (error) {
                    console.error(`[${rpcName}] Failed for ${userId} attempt ${attempt}/2:`, error)
                    if (attempt === 1) continue
                }
            }
            return []
        },
        /**
         * Processes and enriches tweet data with author information and media URLs
         * @param tweets Array of tweets to process and add to the store
         */
        async addTweetToStore(tweet: Tweet, isFeedTweet: boolean = false) {
            try {
                if (this._deletedTweetIds.has(tweet.mid)) return
                if (tweet.favoriteOverride !== undefined || tweet.bookmarkOverride !== undefined) {
                    this.interactionOverrides.set(tweet.mid, {
                        favorite: tweet.favoriteOverride,
                        bookmark: tweet.bookmarkOverride,
                    })
                }
                const existing = this.tweetIndex.get(tweet.mid)
                if (existing) {
                    // Tweet already cached — refresh mutable fields from fresh data.
                    this.refreshCachedTweet(existing, tweet)
                    if (isFeedTweet) this.feedTweetIds.add(tweet.mid)
                    return
                }

                // Use pre-resolved author if caller already set it, otherwise fetch
                let author = tweet.author || await this.getUser(tweet.authorId)
                if (!author) {
                    console.warn("Author not found for tweet:", tweet.mid, "authorId:", tweet.authorId)
                    return
                }

                // Always point tweet.author at the same object that lives in
                // this.users so that Object.assign() in _fetchUser (triggered by
                // handleAvatarError) propagates directly here without needing
                // _rewriteUserMediaHosts to find the tweet by iteration.
                const mapRef = this.users.get(tweet.authorId)
                if (mapRef) {
                    author = mapRef
                } else {
                    // Register so future getUser() calls share the same reference.
                    this.users.set(tweet.authorId, author)
                }

                tweet.comments = []     // load comments only on detail page
                tweet.author = author
                tweet.provider = author.providerIp
                // Map server field name to web field name
                if (tweet.likeCount === undefined && (tweet as any).favoriteCount !== undefined) {
                    tweet.likeCount = (tweet as any).favoriteCount
                }
                
                if (tweet.attachments) {
                    tweet.attachments = tweet.attachments.map(e => {
                        // Ensure type has a default value to prevent undefined errors
                        let mediaType = e.type || '';
                        // Try to infer type from fileName if type is missing
                        if (!mediaType && e.fileName) {
                            const ext = e.fileName.toLowerCase().split('.').pop();
                            if (ext) {
                                if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg'].includes(ext)) {
                                    mediaType = 'image/' + ext;
                                } else if (['mp4', 'webm', 'ogg'].includes(ext)) {
                                    mediaType = 'video/' + ext;
                                } else if (ext === 'pdf') {
                                    mediaType = 'application/pdf';
                                }
                            }
                        }
                        
                        // Normalize media type to lowercase for consistent comparison
                        mediaType = normalizeMediaType(mediaType);
                        
                        return {
                            mid: this.getMediaUrl(e.mid, "http://" + author.providerIp),
                            type: mediaType,
                            timestamp: e.timestamp,
                            fileName: e.fileName,
                            downloadable: tweet.downloadable,
                            size: e.size,
                            aspectRatio: e.aspectRatio
                        }
                    })
                }

                if (tweet.originalTweetId) {
                    try {
                        const originalTweet = this.originalTweetIndex.get(tweet.originalTweetId)
                        if (originalTweet) {
                            tweet.originalTweet = originalTweet
                        } else {
                            // Try fetching with authorId first
                            console.log(`[addTweetToStore] ⚠️ Original tweet not in cache, attempting to fetch: ${tweet.originalTweetId} (authorId: ${tweet.originalAuthorId})`)
                            tweet.originalTweet = await this.fetchTweet(tweet.originalTweetId, tweet.originalAuthorId)
                            
                            // If that fails, retry without authorId (like getTweet does)
                            if (!tweet.originalTweet) {
                                console.log(`[addTweetToStore] First fetch attempt failed, retrying without authorId for ${tweet.originalTweetId}`)
                                tweet.originalTweet = await this.fetchTweet(tweet.originalTweetId, undefined)
                            }
                        }
                        
                        // Pure retweets cannot render without their original, but quote
                        // tweets still have their own content/media and should remain visible.
                        if (!tweet.originalTweet) {
                            if (tweetHasOwnBody(tweet)) {
                                tweet.originalTweet = undefined
                                console.warn(`[addTweetToStore] Original quote target unavailable; rendering quote wrapper only:
  Quote Tweet ID: ${tweet.mid}
  Original Tweet ID: ${tweet.originalTweetId}`)
                            } else {
                                console.warn(`[addTweetToStore] ❌ SKIPPING RETWEET - Original tweet unavailable:
  Retweet ID: ${tweet.mid}
  Original Tweet ID: ${tweet.originalTweetId}`)
                                return
                            }
                        }
                    } catch (error) {
                        console.error(`[addTweetToStore] ❌ ERROR fetching original tweet:
  Retweet ID: ${tweet.mid}
  Original Tweet ID: ${tweet.originalTweetId}
  Error:`, error)
                        if (tweetHasOwnBody(tweet)) {
                            tweet.originalTweet = undefined
                            console.warn(`[addTweetToStore] Original quote target errored; rendering quote wrapper only:
  Quote Tweet ID: ${tweet.mid}
  Original Tweet ID: ${tweet.originalTweetId}`)
                        } else {
                            console.warn(`[addTweetToStore] ❌ SKIPPING RETWEET due to fetch error`)
                            return
                        }
                    }
                }
                
                try {
                    sessionStorage.setItem(tweet.mid, JSON.stringify(tweetForSessionStorage(tweet)))
                } catch (error) {
                    console.error("Error saving tweet to sessionStorage:", error)
                    // Continue even if sessionStorage fails
                }
                
                this.tweets.push(tweet);
                this.tweetIndex.set(tweet.mid, tweet);
                if (isFeedTweet) this.feedTweetIds.add(tweet.mid);
            } catch (error) {
                console.error("Error in getTweetReady for tweet:", tweet.mid, error)
                throw error; // Re-throw to let caller handle it
            }
        },

        /**
         * Merge mutable scalar fields from a fresh server tweet into the cached
         * copy, preserving object refs (author, attachments) so Vue keeps running
         * video players and avatars in place.
         */
        refreshCachedTweet(cached: Tweet, fresh: Tweet) {
            const freshLikeCount = fresh.likeCount ?? (fresh as any).favoriteCount
            // Never decrease counts from a background refresh — explicit user actions
            // (toggleFavorite, updateRetweetCount) write the authoritative value via
            // _applyServerTweet; background feed data may lag behind.
            if (freshLikeCount !== undefined && freshLikeCount >= (cached.likeCount ?? 0)) cached.likeCount = freshLikeCount
            if (fresh.commentCount !== undefined && fresh.commentCount >= (cached.commentCount ?? 0)) cached.commentCount = fresh.commentCount
            if (fresh.retweetCount !== undefined && fresh.retweetCount >= (cached.retweetCount ?? 0)) cached.retweetCount = fresh.retweetCount
            if (fresh.bookmarkCount !== undefined && fresh.bookmarkCount >= (cached.bookmarkCount ?? 0)) cached.bookmarkCount = fresh.bookmarkCount
            if (fresh.content !== undefined) cached.content = fresh.content
            if (fresh.isPrivate !== undefined) cached.isPrivate = fresh.isPrivate
            if (fresh.downloadable !== undefined) cached.downloadable = fresh.downloadable
            if (fresh.timestamp !== undefined) cached.timestamp = fresh.timestamp
            if (fresh.favorites !== undefined) cached.favorites = fresh.favorites
        },

        /**
         * Loads tweets for a specific user by rank/popularity
         * @param userId The user ID whose tweets to load
         * @param pageNumber 0-based page index (same as iOS fetchUserTweets — `pn` is passed through as the page index).
         * @param pageSize number of tweets per page
         * @returns the number of tweets loaded (raw array length from the server, including null slots).
         */
        async loadTweetsByUser(
            userId: string,
            pageNumber: number = 0,
            pageSize: number = 10,
            options: { candidateIds?: Set<string> } = {}
        ): Promise<number | null> {
            const params = {
                aid: this.appId,
                ver: "last",
                version: "v2",
                userid: userId,
                pn: pageNumber,
                ps: pageSize,
                appuserid: this.loginUser?.mid ? this.loginUser?.mid : GUEST_ID,
            }

            let lastError: unknown = null
            for (let attempt = 1; attempt <= 2; attempt++) {
                // The first retry should not reuse stale session/provider caches.
                const user = await this._getUserForProviderRetryAttempt(userId, attempt)

                if (!user) {
                    console.warn(`[loadTweetsByUser] No user resolved for ${userId}, attempt ${attempt}/2`)
                    return null
                }

                params.userid = user.mid

                try {
                    const readIp = await this.getUserReadIp(user, attempt > 1)
                    if (!readIp) {
                        throw new Error(`Tweets by user unavailable: could not resolve a read host for ${user.mid}`)
                    }
                    const profileClient = createPooledClient(readIp, this.lapi.connectionPool)
                    const response = await profileClient.RunMApp("get_tweets_by_user", params)

                    // Check success status first
                    const success = response?.success
                    if (success !== true) {
                        const errorMessage = response?.message || "Unknown error occurred"
                        console.error("Tweets loading failed for user", user.mid, ":", errorMessage)
                        console.error("Response:", response)

                        if (attempt === 1) {
                            console.warn(`[loadTweetsByUser] Initial attempt failed for ${user.mid}; retrying with refreshed provider IP`)
                            continue
                        }
                        return null
                    }

                    // Match iOS fetchUserTweets: v2 may nest payload under `data`
                    const payload = tweetsByUserResponseBody(response)
                    const tweetsData = payload.tweets
                    const originalTweetsData = payload.originalTweets

                    // Check for potential backend issue: retweets without original tweets
                    if (tweetsData && tweetsData.length > 0) {
                        const retweetCount = tweetsData.filter((t: any) => t?.originalTweetId).length
                        const originalTweetsCount = originalTweetsData?.length || 0
                        if (retweetCount > 0 && originalTweetsCount === 0) {
                            console.warn(`[loadTweetsByUser] ⚠️ BACKEND ISSUE DETECTED:
  Backend returned ${retweetCount} retweet(s) but 0 original tweets
  This will cause retweets to be skipped if originals cannot be fetched individually
  User: ${user.mid}, Page: ${pageNumber}`)
                        } else if (retweetCount > originalTweetsCount) {
                            console.warn(`[loadTweetsByUser] ⚠️ Potential backend issue:
  Backend returned ${retweetCount} retweet(s) but only ${originalTweetsCount} original tweet(s)
  Some retweets may be skipped if their originals are missing`)
                        }
                    }

                    // Cache original tweets first (same as getTweetFeed)
                    if (originalTweetsData) {
                        await this.updateOriginalTweets(originalTweetsData)
                    }

                    const nestedOrig = collectNestedOriginalTweetsFromRows(tweetsData)
                    if (nestedOrig.length > 0) {
                        await this.updateOriginalTweets(nestedOrig)
                    }

                    if (tweetsData) {
                        for (const tweetJson of tweetsData) {
                            if (tweetJson == null) continue
                            const tweet = tweetJson as Tweet
                            if (tweet.authorId === user.mid) {
                                tweet.author = user
                            }
                            const cachedTweet = this.tweetIndex.get(tweet.mid)
                            if (cachedTweet) {
                                this.refreshCachedTweet(cachedTweet, tweet)
                            } else {
                                try {
                                    await this.addTweetToStore(tweet)
                                } catch (error) {
                                    console.error("Error processing tweet:", tweet.mid, error)
                                }
                            }
                            const storedTweet = this.tweetIndex.get(tweet.mid)
                            // A quote tweet whose original is unavailable is stored with
                            // originalTweet === undefined and still renders (quote wrapper
                            // only) — it must count as a candidate, matching the
                            // displayability filter in UserPage, or it lingers as
                            // "pending" and keeps the new-tweets banner up.
                            if (storedTweet && (!storedTweet.originalTweetId || storedTweet.originalTweet !== null)) {
                                options.candidateIds?.add(storedTweet.mid)
                            }
                        }
                    }

                    // Cache this user's tweets to localStorage for instant display on next visit
                    this.cacheUserTweets(userId)

                    // Return 0 for an empty page (end-of-list) so callers can
                    // distinguish it from a real error (null / thrown exception).
                    return tweetsData?.length ?? null
                } catch (e) {
                    lastError = e
                    console.error("Error fetching tweets for user:", user.mid, "attempt:", attempt)
                    console.error("Exception:", e)

                    if (attempt === 1) {
                        console.warn(`[loadTweetsByUser] Initial attempt threw for ${user.mid}; retrying with refreshed provider IP`)
                        continue
                    }
                }
            }

            if (lastError) {
                throw lastError
            }
            return null
        },

        /**
         * Cache a user's tweets to localStorage for instant display on next visit
         */
        cacheUserTweets(userId: string) {
            try {
                const userTweets = this.tweets
                    .filter(t => t.authorId === userId)
                    .map(t => tweetForSessionStorage(t))
                    .sort((a, b) => (b.timestamp as number) - (a.timestamp as number))
                setLocalCache(`tweets_${userId}`, userTweets)
            } catch (e) {
                console.warn("Failed to cache user tweets to localStorage:", e)
            }
        },

        cacheUserTweetsByType(
            userId: string,
            type: SavedListType,
            tweets: Tweet[]
        ) {
            try {
                const serializable = tweets.map(tweet => {
                    const cached = tweetForSessionStorage(tweet)
                    cached.comments = []
                    return cached
                })
                setLocalCache(savedListCacheKey(userId, type), serializable)
            } catch (e) {
                console.warn(`Failed to cache ${type} for ${userId}:`, e)
            }
        },

        loadCachedUserTweetsByType(
            userId: string,
            type: SavedListType
        ): Tweet[] {
            const key = savedListCacheKey(userId, type)
            try {
                const cachedTweets = getLocalCache<Tweet[]>(key) ?? []
                const result: Tweet[] = []
                for (const cachedTweet of cachedTweets) {
                    if (this._deletedTweetIds.has(cachedTweet.mid)) continue
                    if (cachedTweet.author) {
                        delete (cachedTweet.author as any).providerIp
                        if (attachNodePoolRoute(cachedTweet.author, this.lapi.connectionPool)) {
                            cachedTweet.provider = cachedTweet.author.providerIp
                        }
                        const sharedAuthor = this.users.get(cachedTweet.authorId)
                        if (sharedAuthor) cachedTweet.author = sharedAuthor
                        else this.users.set(cachedTweet.authorId, cachedTweet.author)
                    }
                    cachedTweet.comments = []

                    const existing = this.tweetIndex.get(cachedTweet.mid)
                    if (existing) {
                        this.refreshCachedTweet(existing, cachedTweet)
                        result.push(existing)
                    } else {
                        this.tweets.push(cachedTweet)
                        this.tweetIndex.set(cachedTweet.mid, cachedTweet)
                        result.push(cachedTweet)
                    }
                    if (
                        cachedTweet.favoriteOverride !== undefined ||
                        cachedTweet.bookmarkOverride !== undefined
                    ) {
                        this.interactionOverrides.set(cachedTweet.mid, {
                            favorite: cachedTweet.favoriteOverride,
                            bookmark: cachedTweet.bookmarkOverride,
                        })
                    }
                }
                this.savedListTweets[key] = result
                return result
            } catch (e) {
                console.warn(`Failed to load cached ${type} for ${userId}:`, e)
                this.savedListTweets[key] = []
                return []
            }
        },

        getLoadedUserTweetsByType(
            userId: string,
            type: SavedListType
        ): Tweet[] {
            return this.savedListTweets[savedListCacheKey(userId, type)] ?? []
        },

        setLoadedUserTweetsByType(
            userId: string,
            type: SavedListType,
            tweets: Tweet[]
        ) {
            const key = savedListCacheKey(userId, type)
            this.savedListTweets[key] = tweets
            this.cacheUserTweetsByType(userId, type, tweets)
        },

        applyOptimisticSavedTweet(
            tweet: Tweet,
            kind: 'favorite' | 'bookmark',
            desiredState: boolean,
            previousState: boolean,
            phase: 'optimistic' | 'rollback' = 'optimistic',
        ): Tweet {
            const index = kind === 'favorite' ? 0 : 1
            const flags = Array.isArray(tweet.favorites)
                ? [...tweet.favorites]
                : [false, false, false]
            while (flags.length < 3) flags.push(false)
            flags[index] = desiredState

            let updated: Tweet = {
                ...tweet,
                favorites: flags,
                favoriteOverride: kind === 'favorite'
                    ? desiredState
                    : tweet.favoriteOverride,
                bookmarkOverride: kind === 'bookmark'
                    ? desiredState
                    : tweet.bookmarkOverride,
            }
            this.setInteractionOverride(tweet.mid, kind, desiredState)
            const pendingState = this.optimisticSavedListStates.get(tweet.mid) ?? {}
            if (phase === 'optimistic') {
                this.optimisticSavedListStates.set(tweet.mid, {
                    ...pendingState,
                    [kind]: desiredState,
                })
            } else {
                const remainingState = { ...pendingState }
                delete remainingState[kind]
                if (
                    remainingState.favorite === undefined &&
                    remainingState.bookmark === undefined
                ) {
                    this.optimisticSavedListStates.delete(tweet.mid)
                } else {
                    this.optimisticSavedListStates.set(tweet.mid, remainingState)
                }
            }

            const storedTweet = this.tweetIndex.get(tweet.mid)
            if (storedTweet) {
                Object.assign(storedTweet, updated)
                updated = storedTweet
            }

            const loginUser = this.loginUser
            if (!loginUser) return updated
            if (desiredState !== previousState) {
                if (kind === 'favorite') {
                    loginUser.favoritesCount = Math.max(
                        0,
                        (loginUser.favoritesCount ?? 0) + (desiredState ? 1 : -1)
                    )
                } else {
                    loginUser.bookmarksCount = Math.max(
                        0,
                        (loginUser.bookmarksCount ?? 0) + (desiredState ? 1 : -1)
                    )
                }
            }

            const idField = kind === 'favorite' ? 'favoriteTweets' : 'bookmarkedTweets'
            const savedIds = loginUser[idField] ?? []
            loginUser[idField] = desiredState
                ? [tweet.mid, ...savedIds.filter(id => id !== tweet.mid)]
                : savedIds.filter(id => id !== tweet.mid)
            setStoredLoginUser(loginUser)

            const type: SavedListType = kind === 'favorite'
                ? 'favorite_list'
                : 'bookmark_list'
            const current = this.getLoadedUserTweetsByType(loginUser.mid, type)
            const next = desiredState
                ? [updated, ...current.filter(item => item.mid !== tweet.mid)]
                : current.filter(item => item.mid !== tweet.mid)
            this.setLoadedUserTweetsByType(loginUser.mid, type, next)
            return updated
        },

        cacheFeedTweets(userId?: string) {
            const cacheUserId = userId ?? this.loginUser?.mid
            if (!cacheUserId) return
            try {
                const feedTweets = this.tweets
                    .filter(t => this.feedTweetIds.has(t.mid))
                    .map(t => tweetForSessionStorage(t))
                    .sort((a, b) => (b.timestamp as number) - (a.timestamp as number))
                setLocalCache(`feed_tweets_${cacheUserId}`, feedTweets)
            } catch (e) {
                console.warn("Failed to cache feed tweets to localStorage:", e)
            }
        },

        getCachedFeedTweets(userId: string): Tweet[] {
            try {
                const tweets = getLocalCache<Tweet[]>(`feed_tweets_${userId}`)
                if (!tweets) return []
                const result: Tweet[] = []
                for (const t of tweets) {
                    if (this._deletedTweetIds.has(t.mid)) continue
                    if (t.author) {
                        delete (t.author as any).providerIp
                        if (attachNodePoolRoute(t.author, this.lapi.connectionPool)) {
                            t.provider = t.author.providerIp
                        }
                        const mapRef = this.users.get(t.authorId)
                        if (mapRef) {
                            t.author = mapRef
                        } else {
                            this.users.set(t.authorId, t.author)
                        }
                    }
                    if (t.originalTweet?.author) {
                        delete (t.originalTweet.author as any).providerIp
                        if (attachNodePoolRoute(t.originalTweet.author, this.lapi.connectionPool)) {
                            t.originalTweet.provider = t.originalTweet.author.providerIp
                        }
                    }
                    t.comments = []

                    const existing = this.tweetIndex.get(t.mid)
                    if (existing) {
                        this.feedTweetIds.add(existing.mid)
                        result.push(existing)
                    } else {
                        this.tweets.push(t)
                        this.tweetIndex.set(t.mid, t)
                        this.feedTweetIds.add(t.mid)
                        result.push(t)
                    }
                }
                return result
            } catch (e) {
                console.warn("Failed to load cached feed tweets:", e)
                return []
            }
        },

        /**
         * Load cached tweets for a user from localStorage
         * Returns tweets with author.client restored
         */
        getCachedUserTweets(userId: string): Tweet[] {
            try {
                const tweets = getLocalCache<Tweet[]>(`tweets_${userId}`)
                if (!tweets) return []
                for (const t of tweets) {
                    if (t.author) {
                        delete (t.author as any).providerIp
                        if (attachNodePoolRoute(t.author, this.lapi.connectionPool)) {
                            t.provider = t.author.providerIp
                        }
                    }
                    if (t.originalTweet?.author) {
                        delete (t.originalTweet.author as any).providerIp
                        if (attachNodePoolRoute(t.originalTweet.author, this.lapi.connectionPool)) {
                            t.originalTweet.provider = t.originalTweet.author.providerIp
                        }
                    }
                    t.comments = []

                    // Align cached tweet.author with the users-Map reference so that
                    // Object.assign() in _fetchUser (triggered by getUserFromRootHost)
                    // propagates the fresh avatar directly into displayedTweets items.
                    if (t.author) {
                        const mapRef = this.users.get(t.authorId)
                        if (mapRef) {
                            t.author = mapRef
                        } else {
                            this.users.set(t.authorId, t.author)
                        }
                    }
                }
                return tweets
            } catch (e) {
                console.warn("Failed to load cached user tweets:", e)
                return []
            }
        },

        /**
         * Cache pinned tweets for a user to localStorage
         */
        cachePinnedTweets(userId: string, tweets: Tweet[]) {
            try {
                const serializable = tweets.map(t => {
                    const cached: any = tweetForSessionStorage(t)
                    cached.comments = []
                    if (cached.originalTweet) cached.originalTweet.comments = []
                    return cached
                })
                setLocalCache(`pinned_${userId}`, serializable)
            } catch (e) {
                console.warn("Failed to cache pinned tweets:", e)
            }
        },

        /**
         * Load cached pinned tweets from localStorage
         */
        getCachedPinnedTweets(userId: string): Tweet[] {
            try {
                const tweets = getLocalCache<Tweet[]>(`pinned_${userId}`)
                if (!tweets) return []
                for (const t of tweets) {
                    if (t.author) {
                        delete (t.author as any).providerIp
                        if (attachNodePoolRoute(t.author, this.lapi.connectionPool)) {
                            t.provider = t.author.providerIp
                        }
                    }
                    if (t.originalTweet?.author) {
                        delete (t.originalTweet.author as any).providerIp
                        if (attachNodePoolRoute(t.originalTweet.author, this.lapi.connectionPool)) {
                            t.originalTweet.provider = t.originalTweet.author.providerIp
                        }
                    }
                    t.comments = []

                    if (t.author) {
                        const mapRef = this.users.get(t.authorId)
                        if (mapRef) {
                            t.author = mapRef
                        } else {
                            this.users.set(t.authorId, t.author)
                        }
                    }
                }
                return tweets
            } catch (e) {
                console.warn("Failed to load cached pinned tweets:", e)
                return []
            }
        },

        async updateOriginalTweets(originalTweetsData: any) {
            // Pre-fetch all unique authors in parallel
            const newOriginals = originalTweetsData.filter(
                (t: any) => t != null && !this.originalTweetIndex.has(t.mid)
            )
            if (newOriginals.length > 0) {
                const uniqueAuthorIds = [...new Set(newOriginals.map((t: any) => t.authorId))] as string[]
                await Promise.all(uniqueAuthorIds.map(id => this.getUser(id).catch(() => undefined)))
            }

            for (const originalTweetJson of originalTweetsData) {
                if (originalTweetJson != null) {
                    try {
                        const originalTweet = originalTweetJson as Tweet
                        if (!this.originalTweetIndex.has(originalTweet.mid)) {
                            const author = await this.getUser(originalTweet.authorId)
                            if (author) {
                                originalTweet.author = author
                                originalTweet.provider = author.providerIp
                                if (originalTweet.attachments) {
                                    originalTweet.attachments.forEach((e: MimeiFileType) => {
                                        e.mid = this.getMediaUrl(e.mid, "http://" + author.providerIp)
                                        e.downloadable = originalTweet.downloadable
                                    })
                                }
                                this.originalTweets.push(originalTweet)
                                this.originalTweetIndex.set(originalTweet.mid, originalTweet)
                                try {
                                    sessionStorage.setItem(originalTweet.mid, JSON.stringify(tweetForSessionStorage(originalTweet)))
                                } catch (e) {
                                    console.warn("Failed to cache original tweet to sessionStorage:", originalTweet.mid, e)
                                }
                            }
                        }
                    } catch (e) {
                        console.error("Error caching original tweet:", e)
                    }
                }
            }
        },

        /**
         * Loads pinned tweets for a specific user
         * @param userId The user ID whose pinned tweets to load
         * @returns Array of pinned tweets
         */
        async loadPinnedTweets(userId: string): Promise<Tweet[]> {
            const params = {
                aid: this.appId,
                ver: "last",
                version: "v2",  // matches iOS — required for tweet.favorites to be populated per appUser
                userid: userId,
                appuserid: this.loginUser?.mid ? this.loginUser?.mid : GUEST_ID
            }

            let pinnedTweets = [] as Tweet[]
            let pinned: any[] = []

            for (let attempt = 1; attempt <= 2; attempt++) {
                // Use the cached user on first attempt; only force a fresh
                // provider lookup on retry. Forcing on attempt 1 used to wipe
                // the user record we just loaded (e.g. in the followers list)
                // and triggered a 15s race — making profile loads slow.
                const user = await this._getUserForProviderRetryAttempt(userId, attempt)

                if (!user) {
                    return []
                }

                try {
                    const readIp = await this.getUserReadIp(user, attempt > 1)
                    if (!readIp) {
                        throw new Error(`Pinned tweets unavailable: could not resolve a read host for ${user.mid}`)
                    }
                    const profileClient = createPooledClient(readIp, this.lapi.connectionPool)
                    const raw = await profileClient.RunMApp("get_pinned_tweets", params)

                    // v2 wraps payloads as { success, data, message }. Unwrap.
                    pinned = (raw && typeof raw === 'object' && 'success' in raw)
                        ? (raw.success ? (raw.data ?? []) : [])
                        : raw

                    // Validate that pinned is an array
                    if (!Array.isArray(pinned)) {
                        console.warn("Pinned tweets response is not an array:", typeof pinned, pinned)
                        if (attempt === 1) {
                            console.warn(`[loadPinnedTweets] Initial attempt failed for ${user.mid}; retrying with refreshed provider IP`)
                            continue
                        }
                        return []
                    }
                    break
                } catch (error) {
                    console.error("Error loading pinned tweets for user:", user.mid, "attempt:", attempt, error)
                    if (attempt === 1) {
                        console.warn(`[loadPinnedTweets] Initial attempt threw for ${user.mid}; retrying with refreshed provider IP`)
                        continue
                    }
                    return []
                }
            }

            if (pinned.length > 0) {
                // Create an array to store tweets with their pin timestamps for sorting
                const tweetsWithPinTime: Array<{tweet: Tweet, pinTimestamp: number}> = []

                for (const e of pinned) {
                    try {
                        const tweetObject = e.tweet
                        const pinTimestamp = e.timestamp ? Number(e.timestamp) : 0

                        // Validate tweet object
                        if (!tweetObject || !tweetObject.mid) {
                            console.warn("Invalid tweet object:", tweetObject)
                            continue
                        }

                        // Check if tweet is already in cache
                        let existingTweet = this.tweetIndex.get(tweetObject.mid)
                        if (existingTweet) {
                            this.refreshCachedTweet(existingTweet, tweetObject)

                            const freshAttachments = Array.isArray(tweetObject.attachments)
                                ? tweetObject.attachments as MimeiFileType[]
                                : []
                            const existingAttachments = Array.isArray(existingTweet.attachments)
                                ? existingTweet.attachments
                                : []
                            const referenceId = (mid: string) => {
                                const value = String(mid || '').trim()
                                const separator = value.lastIndexOf('/')
                                return separator >= 0 ? value.substring(separator + 1) : value
                            }
                            const freshIds = freshAttachments.map(attachment => referenceId(attachment.mid))
                            const existingIds = existingAttachments.map(attachment => referenceId(attachment.mid))
                            const attachmentSetChanged = JSON.stringify(freshIds) !== JSON.stringify(existingIds)
                            const cachedMediaNeedsUrls = existingAttachments.some(attachment =>
                                !/^https?:\/\//i.test(attachment.mid)
                            )

                            // Pinned tweets can come from a persistent cache that predates
                            // an edit. Replace media only when it changed (or is still raw)
                            // so unchanged pinned videos keep their live component state.
                            if (attachmentSetChanged || cachedMediaNeedsUrls) {
                                const mediaHost = existingTweet.provider || existingTweet.author?.providerIp
                                const baseUrl = mediaHost ? `http://${mediaHost}` : window.location.origin
                                existingTweet.attachments = freshAttachments.map(attachment => ({
                                    ...attachment,
                                    mid: this.getMediaUrl(referenceId(attachment.mid), baseUrl),
                                    downloadable: tweetObject.downloadable ?? attachment.downloadable,
                                }))
                            }

                            tweetsWithPinTime.push({tweet: existingTweet, pinTimestamp})
                        } else {
                            // Process through addTweetToStore so media URLs are constructed
                            try {
                                await this.addTweetToStore(tweetObject)
                            } catch (error) {
                                console.error("Error adding pinned tweet to store:", tweetObject.mid, error)
                                continue
                            }
                            // addTweetToStore may skip the tweet (e.g. missing author)
                            const stored = this.tweetIndex.get(tweetObject.mid)
                            if (!stored) {
                                console.warn("Pinned tweet was not added to store:", tweetObject.mid)
                                continue
                            }
                            tweetsWithPinTime.push({tweet: stored, pinTimestamp})
                        }
                    } catch (error) {
                        console.error("Error processing pinned tweet:", e, error)
                        continue
                    }
                }
                
                // Sort by pin timestamp in descending order (most recently pinned first)
                tweetsWithPinTime.sort((a, b) => b.pinTimestamp - a.pinTimestamp)
                
                // Extract just the tweets in the sorted order
                pinnedTweets = tweetsWithPinTime.map(item => item.tweet)
                
                console.log(`Successfully loaded ${pinnedTweets.length} pinned tweets, sorted by pin time`)
            } else {
                console.log("No pinned tweets found")
            }
            return pinnedTweets
        },

        /**
         * Load a user's bookmark / favorite tweet list (matches iOS
         * `getUserTweetsByType` via the get_user_meta RPC). The server
         * returns tweets with the per-appUser `favorites` array populated.
         *
         * @param userId profile being viewed
         * @param type   'bookmark_list' or 'favorite_list'
         */
        async loadUserTweetsByType(
            userId: string,
            type: SavedListType,
            pageNumber: number = 0,
            pageSize: number = 20
        ): Promise<Tweet[]> {
            const user = await this.getUser(userId)
            if (!user) throw new Error(`User not available for ${type}: ${userId}`)

            const params = {
                aid: this.appId,
                ver: "last",
                version: "v2",
                userid: userId,
                type,
                pn: pageNumber,
                ps: pageSize,
                appuserid: this.loginUser?.mid ? this.loginUser?.mid : GUEST_ID,
            }

            let raw: any
            try {
                const readIp = await this.getUserReadIp(user)
                if (!readIp) {
                    throw new Error(`User meta unavailable: could not resolve a read host for ${user.mid}`)
                }
                const profileClient = createPooledClient(readIp, this.lapi.connectionPool)
                raw = await profileClient.RunMApp("get_user_meta", params)
            } catch (e) {
                console.warn(`[loadUserTweetsByType] ${type} RPC failed for ${userId}:`, e)
                throw e
            }

            const data = (raw && typeof raw === 'object' && 'success' in raw)
                ? (raw.success ? (raw.data ?? []) : [])
                : raw

            if (!Array.isArray(data)) {
                throw new Error(`[loadUserTweetsByType] ${type} response not an array for ${userId}`)
            }

            const previousList = this.getLoadedUserTweetsByType(userId, type)
            const result: Tweet[] = []
            for (const t of data) {
                if (!t || !t.mid) continue
                const pendingState = this.optimisticSavedListStates.get(t.mid)
                const optimisticState = type === 'bookmark_list'
                    ? pendingState?.bookmark
                    : pendingState?.favorite
                if (optimisticState === false) continue

                const flags = Array.isArray(t.favorites) ? [...t.favorites] : [false, false, false]
                while (flags.length < 3) flags.push(false)
                flags[type === 'bookmark_list' ? 1 : 0] = optimisticState ?? true
                t.favorites = flags
                if (type === 'bookmark_list') t.bookmarkOverride = optimisticState ?? true
                else t.favoriteOverride = optimisticState ?? true
                const savedOverride = this.interactionOverrides.get(t.mid) ?? {}
                if (type === 'bookmark_list') savedOverride.bookmark = optimisticState ?? true
                else savedOverride.favorite = optimisticState ?? true
                this.interactionOverrides.set(t.mid, savedOverride)
                try {
                    await this.addTweetToStore(t)
                } catch (e) {
                    console.error(`[loadUserTweetsByType] addTweetToStore failed for`, t.mid, e)
                    continue
                }
                const stored = this.tweetIndex.get(t.mid)
                if (stored) {
                    let displayTweet = stored
                    // Saved comments reuse the existing quote presentation, with
                    // their immediate parent embedded. A missing parent leaves the
                    // comment as a normal row rather than dropping it.
                    if (stored.parentTweetId) {
                        const parent = await this.fetchTweet(stored.parentTweetId, undefined)
                        if (parent) {
                            displayTweet = { ...stored, savedParentTweet: parent }
                        }
                    }
                    result.push(displayTweet)
                }
            }

            const resultIds = new Set(result.map(tweet => tweet.mid))
            const optimisticAdditions = pageNumber === 0
                ? previousList.filter(tweet => {
                    const state = this.optimisticSavedListStates.get(tweet.mid)
                    const isSaved = type === 'bookmark_list'
                        ? state?.bookmark
                        : state?.favorite
                    return isSaved === true && !resultIds.has(tweet.mid)
                })
                : []
            const finalResult = [...optimisticAdditions, ...result]
                .filter((tweet, index, tweets) =>
                    tweets.findIndex(candidate => candidate.mid === tweet.mid) === index
                )
            if (pageNumber === 0) {
                this.setLoadedUserTweetsByType(userId, type, finalResult)
            }
            return finalResult
        },

        /**
         * Load tweets of appUser and its followings from network.
         * Keep null elements in the response list and preserves their positions.
         * @param user is login user.
         * @param pageNumber page number to load (0-based)
         * @param pageSize number of tweets per page
         * @returns tweets of app user's followings' tweets
         */
        async getTweetFeed(
            user: User,
            pageNumber: number,
            pageSize: number,
            options: { candidateIds?: Set<string> } = {}
        ): Promise<number | null> {
            let lastError: unknown = null
            for (let attempt = 1; attempt <= 2; attempt++) {
                try {
                const readIp = await this.getUserReadIp(user, attempt > 1)
                if (!readIp) {
                    throw new Error(`Tweet feed unavailable: could not resolve a read host for ${user.mid}`)
                }
                const feedClient = createPooledClient(readIp, this.lapi.connectionPool)
                const params = {
                    aid: this.appId,
                    ver: "last",
                    pn: pageNumber,
                    ps: pageSize,
                    userid: user.mid,
                    appuserid: this.loginUser?.mid ? this.loginUser?.mid : GUEST_ID,
                }
                const response = await feedClient.RunMApp("get_tweet_feed", params)

                // Check success status first
                const success = response?.success
                if (success !== true) {
                    const errorMessage = response?.message || "Unknown error occurred"
                    console.error("Tweet feed loading failed:", errorMessage)
                    console.error("Response:", response)
                    return null
                }

                // Extract tweets from the new response format
                const tweetsData = response.tweets
                const originalTweetsData = response.originalTweets

                // Check for potential backend issue: retweets without original tweets
                if (tweetsData && tweetsData.length > 0) {
                    const retweetCount = tweetsData.filter((t: any) => t?.originalTweetId).length
                    const originalTweetsCount = originalTweetsData?.length || 0
                    if (retweetCount > 0 && originalTweetsCount === 0) {
                        console.warn(`[getTweetFeed] ⚠️ BACKEND ISSUE DETECTED:
  Backend returned ${retweetCount} retweet(s) but 0 original tweets
  This will cause retweets to be skipped if originals cannot be fetched individually
  Page: ${pageNumber}`)
                    } else if (retweetCount > originalTweetsCount) {
                        console.warn(`[getTweetFeed] ⚠️ Potential backend issue:
  Backend returned ${retweetCount} retweet(s) but only ${originalTweetsCount} original tweet(s)
  Some retweets may be skipped if their originals are missing`)
                    }
                }

                // Cache original tweets first
                if (response.originalTweets) {
                    await this.updateOriginalTweets(response.originalTweets)
                }

                const feedNestedOrig = collectNestedOriginalTweetsFromRows(tweetsData)
                if (feedNestedOrig.length > 0) {
                    await this.updateOriginalTweets(feedNestedOrig)
                }

                const candidateIds = await this.processFeedTweetRows(tweetsData, "getTweetFeed")
                if (options.candidateIds) {
                    candidateIds.forEach(id => options.candidateIds!.add(id))
                }
                this.cacheFeedTweets(user.mid)

                return tweetsData?.length || null
                } catch (e) {
                    lastError = e
                    console.error(`Error fetching tweet feed (attempt ${attempt}/2):`, e)
                    if (attempt === 1) continue
                }
            }
            if (lastError) {
                console.error("Error fetching tweet feed:", lastError)
            }
            return null
        },

        /**
         * Updates following tweets by calling the update_following_tweets endpoint.
         * This function can only be called after user has logged in.
         * Processes tweets exactly like getTweetFeed() and updates state.tweets directly.
         */
        async updateFollowingTweets(options: { candidateIds?: Set<string>; showLoginError?: boolean; pageNumber?: number; pageSize?: number } = {}): Promise<string[]> {
            // Check if user is logged in
            if (!this.loginUser) {
                console.error("updateFollowingTweets: User must be logged in to call this function")
                if (options.showLoginError !== false) {
                    useAlertStore().error("You must be logged in to update following tweets")
                }
                return []
            }
            const loginUser = this.loginUser
            const homeHostId = loginUser.hostIds?.[0]
            const accessHostId = loginUser.hostIds?.[1]

            try {
                const params = {
                    aid: this.appId,
                    ver: "last",
                    pn: options.pageNumber ?? 0,
                    ps: options.pageSize ?? TWEET_COUNT,
                    appuserid: loginUser.mid,
                    hostid: homeHostId
                }

                const writableIp = await this.resolveWritableHostIp(loginUser)
                const updateClient = createPooledClient(writableIp, this.lapi.connectionPool)
                updateClient.timeout = UPDATE_FOLLOWING_TWEETS_TIMEOUT_MS
                const response = await updateClient.RunMApp("update_following_tweets", params)

                // Check success status first
                const success = response?.success
                if (success !== true) {
                    const errorMessage = response?.message || "Unknown error occurred"
                    console.error("Update following tweets failed:", errorMessage)
                    console.error("Response:", response)
                    return []
                }

                // Extract tweets from the response format (same as getTweetFeed)
                const tweetsData = response.tweets
                if (this.loginUser?.mid !== loginUser.mid) return []
                await this.syncFollowingTweetsToAccessHostIfNeeded(tweetsData, params, homeHostId, accessHostId)
                if (this.loginUser?.mid !== loginUser.mid) return []

                // Cache original tweets first (same as getTweetFeed)
                if (response.originalTweets) {
                    await this.updateOriginalTweets(response.originalTweets)
                }

                const candidateIds = await this.processFeedTweetRows(tweetsData, "updateFollowingTweets")
                if (options.candidateIds) {
                    candidateIds.forEach(id => options.candidateIds!.add(id))
                }
                this.cacheFeedTweets(loginUser.mid)

                console.log(`Successfully updated following tweets: ${tweetsData?.length || 0} tweets processed`)
                return candidateIds
            } catch (e) {
                console.error("Error calling update_following_tweets:", e)
                return []
            }
        },

        async syncFollowingTweetsToAccessHostIfNeeded(
            tweetsData: any[] | undefined,
            params: Record<string, any>,
            homeHostId: string | undefined,
            accessHostId: string | undefined,
        ): Promise<void> {
            const newTweetCount = Array.isArray(tweetsData)
                ? tweetsData.filter(tweet => tweet != null).length
                : 0
            if (newTweetCount === 0) return

            if (!homeHostId || !accessHostId || accessHostId === homeHostId) return

            try {
                // This is an intentional write to the configured access node,
                // so resolve that exact node ID fresh instead of trusting a
                // persisted provider mapping.
                const accessHostIp = await this.getNodeIpByHostId(accessHostId, true)
                if (!accessHostIp) {
                    console.warn(`Could not resolve access host ${accessHostId}; skipping following-tweets sync`)
                    return
                }

                const accessClient = createPooledClient(accessHostIp, this.lapi.connectionPool)
                accessClient.timeout = UPDATE_FOLLOWING_TWEETS_TIMEOUT_MS
                const response = await accessClient.RunMApp("update_following_tweets", {
                    ...params,
                    homeupdated: true,
                })
                if (response?.success !== true) {
                    console.warn("Access-host following-tweets sync failed:", response?.message || response)
                }
            } catch (error) {
                // The home host already completed successfully, so access-host sync is best-effort.
                console.warn("Error syncing following tweets to access host:", error)
            }
        },

        async processFeedTweetRows(tweetsData: any[] | undefined, context: string): Promise<string[]> {
            const candidateIds: string[] = []
            if (!tweetsData) return candidateIds

            const uniqueAuthorIds = [...new Set(
                tweetsData.filter((t: any) => t != null).map((t: any) => t.authorId)
            )] as string[]
            await Promise.all(uniqueAuthorIds.map(id => this.getUser(id).catch(() => undefined)))

            for (const tweetJson of tweetsData) {
                if (tweetJson == null) continue
                try {
                    const tweet = tweetJson as Tweet
                    const author = await this.getUser(tweet.authorId)
                    if (!author) continue
                    tweet.author = author

                    if (tweet.isPrivate) continue

                    const cachedTweet = this.tweetIndex.get(tweet.mid)
                    if (cachedTweet) {
                        this.refreshCachedTweet(cachedTweet, tweet)
                        this.feedTweetIds.add(tweet.mid)
                    } else {
                        await this.addTweetToStore(tweet, true)
                    }

                    const storedTweet = this.tweetIndex.get(tweet.mid)
                    if (storedTweet && (!storedTweet.originalTweetId || storedTweet.originalTweet)) {
                        candidateIds.push(storedTweet.mid)
                    }
                } catch (error) {
                    console.error(`Error processing tweet in ${context}:`, error)
                    continue
                }
            }

            return candidateIds
        },

        async refreshFeedCandidates(pageSize: number = 10): Promise<{ feedCandidateIds: string[]; followingCandidateIds: string[] }> {
            const user = this.loginUser
            if (!user) {
                this.clearFeedPendingCandidates()
                return { feedCandidateIds: [], followingCandidateIds: [] }
            }
            const userId = user.mid

            const candidateIds = new Set<string>()
            await this.getTweetFeed(user, 0, pageSize, {
                candidateIds
            })
            if (this.loginUser?.mid !== userId) {
                return { feedCandidateIds: [], followingCandidateIds: [] }
            }
            const feedCandidateCount = candidateIds.size
            const followingCandidateIds = await this.updateFollowingTweets({
                showLoginError: false,
                pageNumber: 0,
                pageSize
            })
            if (this.loginUser?.mid !== userId) {
                return { feedCandidateIds: [], followingCandidateIds: [] }
            }

            const sortCandidateIds = (ids: Set<string>) => this.tweets
                .filter(tweet => ids.has(tweet.mid))
                .sort((a, b) => (b.timestamp as number) - (a.timestamp as number))
                .map(tweet => tweet.mid)

            const sortedFeedCandidateIds = sortCandidateIds(candidateIds)
            const sortedFollowingCandidateIds = sortCandidateIds(new Set(followingCandidateIds))
            console.log(`[feedPending] Banner check candidates: get_tweet_feed=${feedCandidateCount}, update_following_tweets=${followingCandidateIds.length}`)
            return {
                feedCandidateIds: sortedFeedCandidateIds,
                followingCandidateIds: sortedFollowingCandidateIds
            }
        },

        async refreshFeedPendingCandidates(pageSize: number = 10): Promise<void> {
            const { feedCandidateIds, followingCandidateIds } = await this.refreshFeedCandidates(pageSize)
            this.replaceFeedPendingCandidates([...feedCandidateIds, ...followingCandidateIds])
        },

        addFeedPendingCandidates(candidateIds: Iterable<string>) {
            for (const id of candidateIds) {
                this.feedPendingCandidateIds.add(id)
            }
        },

        replaceFeedPendingCandidates(candidateIds: Iterable<string>) {
            this.feedPendingCandidateIds.clear()
            this.addFeedPendingCandidates(candidateIds)
        },

        clearFeedPendingCandidates() {
            this.feedPendingCandidateIds.clear()
        },

        /**
         * Given only tweet ID, find it full data. Do NOT load comments yet.
         * Wait until user opens detail tweet page.
         * @param tweetId The ID of the tweet to retrieve
         * @param authorId must be used to find the right node for the tweet.
         * @returns a Tweet object short of comments.
         */
        async getTweet(
            tweetId: MimeiId,
            authorId: MimeiId | undefined = undefined,
            useRacing: boolean = false,
            forceRefresh: boolean = false,
            fromDetailView: boolean = false
        ): Promise<Tweet | null> {
            let tweet = await this.fetchTweet(tweetId, authorId, useRacing, forceRefresh, fromDetailView)
            if (!tweet ) {
                // Author node has not data, try to load the tweet by id alone from some other provider.
                tweet = await this.fetchTweet(tweetId, undefined, useRacing, forceRefresh, fromDetailView)
                if (!tweet) return null
            }

            // Note: originalTweet is now handled within fetchTweet for v3 API responses
            return tweet
        },

        /**
         * Given tweet ID, get its content. There are 2 steps. First, find provider of
         * this tweet with its ID. 2nd, retrieve the tweet from the provider. Assume
         * author data is also available on the provider. Get author data too.
         * @param tweetId The ID of the tweet to fetch
         * @param authorId Optional author ID to help locate the tweet
         * @param useRacing If true, race multiple provider IPs for faster loading (TweetDetail page only)
         * @param loadMissingOriginalTweet If false, return the outer tweet without separately fetching a missing embedded tweet
         * @param refreshProviderRoute If true, refresh provider discovery without synchronizing tweet data
         * @returns The tweet object or undefined if not found
         */
        async fetchTweet(
            tweetId: MimeiId,
            authorId: MimeiId | undefined = undefined,
            useRacing: boolean = false,
            forceRefresh: boolean = false,
            fromDetailView: boolean = false,
            loadMissingOriginalTweet: boolean = true,
            refreshProviderRoute: boolean = false
        ): Promise<Tweet | null> {
            if (this._deletedTweetIds.has(tweetId)) return null

            // check if the tweet has been retrieved
            let cachedTweet = this.tweetIndex.get(tweetId) ?? this.originalTweetIndex.get(tweetId)
            if (!forceRefresh && cachedTweet) {
                console.log(`[fetchTweet] ✅ Cache HIT (in-memory): ${tweetId} - No fetch needed!`)
                return cachedTweet
            }

            if (!forceRefresh && sessionStorage.getItem(tweetId)) {
                console.log(`[fetchTweet] ✅ Cache HIT (sessionStorage): ${tweetId} - No fetch needed!`)
                let t = JSON.parse(sessionStorage.getItem(tweetId)!)
                const cachedAuthorId = t.author?.mid ?? t.authorId
                if (t.author && cachedAuthorId) {
                    // getProviderIp can throw (not just return null) when every
                    // resolved candidate IP fails its health check — e.g. after a
                    // page reload wipes the in-memory NodePool and a fresh RPC
                    // resolve returns only unreachable/private addresses. That must
                    // not discard an already-valid cached tweet; fall back to
                    // showing the cached content without a live route rather than
                    // failing the whole detail view.
                    let authorIp: string | null = null
                    try {
                        authorIp = await this.getProviderIp(cachedAuthorId, v4Only, false)
                    } catch (error) {
                        console.warn(`[fetchTweet] getProviderIp threw for cached tweet ${tweetId} author ${cachedAuthorId}; showing cached content without a live route`, error)
                    }
                    if (authorIp) {
                        t.author.providerIp = authorIp
                        t.provider = authorIp
                        t.author.client = createPooledClient(authorIp, this.lapi.connectionPool)
                        if (t.author.avatar) {
                            t.author.avatar = this.normalizeAvatarUrl(t.author.avatar, `http://${authorIp}`)
                        }

                        const originalAuthorId = t.originalTweet?.author?.mid ?? t.originalTweet?.authorId
                        if (t.originalTweet?.author && originalAuthorId) {
                            let originalAuthorIp: string | null = null
                            try {
                                originalAuthorIp = await this.getProviderIp(originalAuthorId, v4Only, false)
                            } catch (error) {
                                console.warn(`[fetchTweet] getProviderIp threw for cached original tweet author ${originalAuthorId}; keeping cached content without a live route`, error)
                            }
                            if (originalAuthorIp) {
                                t.originalTweet.author.providerIp = originalAuthorIp
                                t.originalTweet.provider = originalAuthorIp
                                t.originalTweet.author.client = createPooledClient(originalAuthorIp, this.lapi.connectionPool)
                                if (t.originalTweet.author.avatar) {
                                    t.originalTweet.author.avatar = this.normalizeAvatarUrl(t.originalTweet.author.avatar, `http://${originalAuthorIp}`)
                                }
                            }
                        }
                    } else {
                        console.log(`[fetchTweet] Cached tweet ${tweetId} author route unavailable; showing cached content read-only`)
                    }
                    return t
                } else {
                    console.log(`[fetchTweet] Cached tweet ${tweetId} missing author, fetching fresh data`)
                    // Remove invalid cache
                    sessionStorage.removeItem(tweetId)
                }
            }

            console.log(`[fetchTweet] ⚠️ Cache MISS: ${tweetId} - Will fetch (authorId: ${authorId}, useRacing: ${useRacing})`)
            let author: any, providerClient: any, providerIp: any, tweetInDB: any

            if (authorId && forceRefresh) {
                // Explicit recovery only: resolve the author and synchronize from root.
                author = await this.getUser(authorId)
                if (author && author.providerIp) {
                    providerIp = author.providerIp
                    providerClient = author.client
                    tweetInDB = await providerClient.RunMApp("refresh_tweet", {
                        aid: this.lapi.appId,
                        ver: "last",
                        tweetid: tweetId,
                        appuserid: this.loginUser?.mid ? this.loginUser?.mid : GUEST_ID,
                        userid: authorId,
                        hostid: author?.hostIds?.[0],
                    })
                    if (!tweetInDB) {
                        console.log('[fetchTweet] Author node returned null for tweet:', tweetId)
                    }
                }
            }

            if (!tweetInDB) {
                // Step 2: ordinary read, or author-based recovery failed — resolve by tweet ID.
                // Use get_tweet WITHOUT version:"v3" here, because v3 requires userid and returns null without it.
                // Pre-v3 get_tweet returns a single object; we normalize it to an array below.
                if (useRacing) {
                    const raceGetTweet = (ips: string[]) => this.raceProviderIps(ips, async (ip, client) => {
                        return await client.RunMApp("get_tweet", {
                            aid: this.lapi.appId,
                            ver: "last",
                            tweetid: tweetId,
                            appuserid: this.loginUser?.mid ? this.loginUser?.mid : GUEST_ID,
                            fromdetailview: fromDetailView
                        })
                    }, `tweet ${tweetId}`)

                    // The author's node also serves this tweet by id, and a detail
                    // URL always carries the author. Resolving the tweet's own mid
                    // can come back with nothing the browser can reach — a cold
                    // lookup returning only private/IPv6 routes ends the load before
                    // a single request is made — so keep the author as a second way in.
                    const authorFallbackIps = async (): Promise<string[]> => {
                        if (!authorId) return []
                        const ips = await this.getProviderIps(authorId, v4Only, refreshProviderRoute)
                        if (ips.length === 0) {
                            console.warn(`[fetchTweet] Author ${authorId} has no usable route either`)
                        }
                        return ips
                    }

                    let providerIps = await this.getProviderIps(tweetId, v4Only, refreshProviderRoute)
                    let triedAuthorRoute = false
                    if (providerIps.length === 0) {
                        console.warn(`[fetchTweet] No provider IPs for tweet ${tweetId}; falling back to author ${authorId}`)
                        providerIps = await authorFallbackIps()
                        triedAuthorRoute = true
                    }
                    if (providerIps.length === 0) {
                        console.warn(`[fetchTweet] No provider IPs for tweet ${tweetId} (racing path)`)
                        return null
                    }

                    let raceResult = await raceGetTweet(providerIps)

                    if (!raceResult) {
                        // The route just failed a real RPC — that is the verdict the
                        // health probe only guessed at. Drop it so a retry resolves
                        // afresh instead of racing the same dead route again.
                        nodePool.invalidate(tweetId)

                        if (!triedAuthorRoute) {
                            const authorIps = await authorFallbackIps()
                            if (authorIps.length > 0) {
                                console.warn(`[fetchTweet] Tweet routes failed for ${tweetId}; retrying through author ${authorId}`)
                                raceResult = await raceGetTweet(authorIps)
                            }
                        }
                    }

                    if (!raceResult) {
                        console.error("[fetchTweet] All provider IPs failed for tweet", tweetId)
                        return null
                    }
                    tweetInDB = raceResult.result
                    providerIp = raceResult.ip
                    // Use auto-releasing proxy so the pool slot is freed after each RPC.
                    providerClient = createPooledClient(providerIp, this.lapi.connectionPool)
                } else {
                    providerIp = await this.getProviderIp(tweetId)
                    if (!providerIp) {
                        console.warn(`[fetchTweet] No provider IP for tweet ${tweetId}`)
                        return null
                    }
                    providerClient = createPooledClient(providerIp, this.lapi.connectionPool)
                    tweetInDB = await providerClient.RunMApp("get_tweet", {
                        aid: this.lapi.appId,
                        ver: "last",
                        tweetid: tweetId,
                        appuserid: this.loginUser?.mid ? this.loginUser?.mid : GUEST_ID,
                        fromdetailview: fromDetailView
                    })
                }
            }
            if (!tweetInDB) {
                console.warn(`[fetchTweet] Provider returned no tweet data for ${tweetId}`)
                return null
            }
            // Normalize to array: refresh_tweet (authorId path) returns array; pre-v3 get_tweet returns single object
            if (!Array.isArray(tweetInDB))
                tweetInDB = [tweetInDB]
            if (tweetInDB.length === 0) {
                console.warn(`[fetchTweet] Provider returned empty array for ${tweetId}`)
                return null
            }

            // Extract tweet data from array response (v3 format)
            const tweetData = tweetInDB[0]
            let originalTweetData = null

            // If tweet has originalTweetId, check for second element in array
            if (tweetData.originalTweetId) {
                if (tweetInDB.length > 1) {
                    // Use the second element as originalTweet
                    originalTweetData = tweetInDB[1]
                } else if (loadMissingOriginalTweet) {
                    // Fallback: fetch original tweet separately
                    originalTweetData = await this.fetchTweet(tweetData.originalTweetId, tweetData.originalAuthorId, false, false, fromDetailView)
                    if (!originalTweetData) {
                        console.warn('[fetchTweet] Failed to fetch original tweet as fallback')
                    }
                }
            }

            // convert Tweet App's definition to this app's definition (without waiting for author)
            let tweet: any = {
                mid: tweetData.mid,
                authorId: tweetData.authorId,
                timestamp: tweetData.timestamp,
                author: null, // Will be loaded asynchronously
                title: tweetData.title,
                content: tweetData.content,
                attachments: tweetData.attachments?.map((e: MimeiFileType) => {
                    // Use provider IP for media URLs initially, will be updated when author loads
                    e.mid = this.getMediaUrl(e.mid, "http://" + providerIp)
                    e.downloadable = tweetData.downloadable
                    return e
                }),
                comments: [],
                originalTweetId: tweetData.originalTweetId,
                originalAuthorId: tweetData.originalAuthorId,
                parentTweetId: tweetData.parentTweetId,
                provider: providerIp,
                likeCount: tweetData.favoriteCount ?? tweetData.likeCount,
                bookmarkCount: tweetData.bookmarkCount,
                commentCount: tweetData.commentCount,
                retweetCount: tweetData.retweetCount,
                favorites: tweetData.favorites,
            }

            // Build the originalTweet shell WITHOUT touching attachments yet.
            // Recursive fetchTweet may have already prepended a host onto each
            // attachment URL; calling getMediaUrl on top of that produces a
            // double-wrapped, broken URL. Defer URL building until we know
            // the original author's provider.
            if (originalTweetData) {
                tweet.originalTweet = {
                    mid: originalTweetData.mid,
                    authorId: originalTweetData.authorId,
                    timestamp: originalTweetData.timestamp,
                    author: null, // Will be loaded below
                    title: originalTweetData.title,
                    content: originalTweetData.content,
                    attachments: originalTweetData.attachments?.map((e: MimeiFileType) => {
                        // Carry the raw entry through; URL is set after author resolves.
                        e.downloadable = originalTweetData.downloadable
                        return e
                    }),
                    comments: [],
                    originalTweetId: originalTweetData.originalTweetId,
                    originalAuthorId: originalTweetData.originalAuthorId,
                    parentTweetId: originalTweetData.parentTweetId,
                    provider: providerIp,
                    likeCount: originalTweetData.favoriteCount ?? originalTweetData.likeCount,
                    bookmarkCount: originalTweetData.bookmarkCount,
                    commentCount: originalTweetData.commentCount,
                    retweetCount: originalTweetData.retweetCount,
                    favorites: originalTweetData.favorites,
                }
            }

            // Pull just the IPFS hash out of whatever shape the input was in:
            // either a raw hash or a host-prefixed full URL (from recursive
            // fetchTweet). The hash is the segment after the final "/".
            const extractHash = (m: string | undefined): string => {
                if (!m) return ''
                if (m.length <= 27) return m // already a raw hash
                const idx = m.lastIndexOf('/')
                return idx >= 0 ? m.substring(idx + 1) : m
            }

            // Resolve both authors in parallel BEFORE returning. This ensures
            //   1. tweet.author and tweet.originalTweet.author are populated
            //      (no broken header / empty avatar in the detail view).
            //   2. Attachment URLs are rebuilt against each author's actual
            //      provider, not the outer tweet's provider — important for
            //      quote tweets where the original lives on a different node.
            // Mutating attachment URLs after the caller wraps `tweet` in a Vue
            // ref doesn't reliably propagate through the proxy, so do it now.
            const authorPromise = this.getUser(tweetData.authorId).catch(error => {
                if (!error.message?.includes('timeout')) {
                    console.warn('[fetchTweet] Failed to load author:', tweetData.authorId, error)
                }
                return undefined
            })
            const originalAuthorPromise = (originalTweetData && tweet.originalTweet)
                ? this.getUser(originalTweetData.authorId).catch(error => {
                    if (!error.message?.includes('timeout')) {
                        console.warn('[fetchTweet] Failed to load original tweet author:', originalTweetData.authorId, error)
                    }
                    return undefined
                })
                : Promise.resolve(undefined)

            const [resolvedAuthor, resolvedOriginalAuthor] = await Promise.all([authorPromise, originalAuthorPromise])

            // Rebuild outer-tweet attachments now that we know the author host.
            // Fall back to the discovery providerIp if the author resolution
            // didn't yield a usable host.
            const outerHost = resolvedAuthor?.providerIp || providerIp
            if (resolvedAuthor) tweet.author = resolvedAuthor
            if (tweet.attachments) {
                tweet.attachments.forEach((e: MimeiFileType) => {
                    e.mid = this.getMediaUrl(extractHash(e.mid), "http://" + outerHost)
                })
            }

            // Rebuild original-tweet attachments using the original author's
            // host. If we couldn't resolve the original author, fall back to
            // the recursive fetch's `provider` field (which fetchTweet itself
            // resolved), then to the outer host as a last resort.
            if (tweet.originalTweet) {
                const originalHost =
                    resolvedOriginalAuthor?.providerIp ||
                    (originalTweetData?.provider as string | undefined) ||
                    outerHost
                if (resolvedOriginalAuthor) {
                    tweet.originalTweet.author = resolvedOriginalAuthor
                }
                tweet.originalTweet.provider = originalHost
                if (tweet.originalTweet.attachments) {
                    tweet.originalTweet.attachments.forEach((e: MimeiFileType) => {
                        e.mid = this.getMediaUrl(extractHash(e.mid), "http://" + originalHost)
                    })
                }
            }

            sessionStorage.setItem(tweetData.mid, JSON.stringify(tweetForSessionStorage(tweet)))
            return tweet
        },

        /**
         * Retrieves user data by user ID, caching the result
         * Implements retry mechanism: if first attempt fails, retry once with refreshed providerIP
         * @param userId The user ID to retrieve data for
         * @param forceRefresh If true, bypass cache and fetch fresh data from server (used during login)
         * @returns The user object or undefined if not found
         */
        async getUser(userId: MimeiId, forceRefresh: boolean = false): Promise<User | undefined> {
            // check if the user has been cached (unless forcing refresh)
            if (!forceRefresh && this.loginUser && this.loginUser.mid == userId)
                return await this._ensureUserRootHost(this.loginUser)
            if (!forceRefresh && this.users.get(userId))
                return await this._ensureUserRootHost(this.users.get(userId) as User)

            // Deduplicate concurrent fetches for the same user.
            // Use separate keys for forced vs normal fetches so a cached (fast)
            // non-refresh promise never satisfies a caller that needs fresh data.
            const pendingKey = forceRefresh ? `${userId}:force` : userId
            const pending = this._pendingUserFetches.get(pendingKey)
            if (pending) return pending

            const fetchPromise = (async () => {
                const fetched = await this._fetchUser(userId, forceRefresh)
                if (!fetched) return undefined
                return await this._ensureUserRootHost(fetched as User)
            })()
            this._pendingUserFetches.set(pendingKey, fetchPromise)
            try {
                return await fetchPromise
            } finally {
                this._pendingUserFetches.delete(pendingKey)
            }
        },

        /**
         * Ensures a user object's providerIp/client point at the read/access node.
         * Mirrors iOS: baseUrl/providerIp is for reads; writableHostIp is resolved
         * separately from hostIds[0] only for mutations.
         */
        async _ensureUserRootHost(user: User): Promise<User> {
            if (!user.hostIds?.length) return user
            if (user.providerIp && this.getFreshHealthStatus(user.providerIp) === true) {
                if (!user.client) {
                    user.client = createPooledClient(user.providerIp, this.lapi.connectionPool)
                }
                return user
            }
            try {
                const readIp = await this.getUserReadIp(user, false)
                if (!readIp) return user
                if (user.providerIp !== readIp) {
                    user.providerIp = readIp
                }
                user.client = createPooledClient(readIp, this.lapi.connectionPool)
                if (user.avatar) {
                    user.avatar = this.normalizeAvatarUrl(user.avatar, `http://${readIp}`)
                }
                if (user.writableHostIp === undefined) {
                    user.writableHostIp = null
                }

                this.users.set(user.mid, user)
                this._rewriteUserMediaHosts(user.mid, readIp)
                setStoredUser(user.mid, user)
                if (this._user?.mid === user.mid) {
                    setStoredLoginUser(user)
                }
                return user
            } catch (error) {
                console.warn(`[ensureUserReadHost] Failed for ${user.mid}:`, error)
                return user
            }
        },

        /**
         * Fetch user core data from the user's root host (hostIds[0]).
         * This is used by profile surfaces that must read from source-of-truth.
         */
        async getUserFromRootHost(userId: MimeiId, forceRefresh: boolean = false): Promise<User | undefined> {
            return await this.getUser(userId, forceRefresh)
        },

        /**
         * Explicit profile recovery. Mirrors iOS resyncUser: synchronize the User
         * and its directly referenced Tweets, then merge both into live caches.
         */
        async resyncUser(userId: MimeiId): Promise<{ user: User, tweets: Tweet[] }> {
            const currentUser = await this.getUser(userId)
            if (!currentUser?.client) {
                throw new Error(`Route unavailable for resync user ${userId}`)
            }

            const rawResponse = await currentUser.client.RunMApp("resync_user", {
                aid: this.appId,
                ver: "last",
                version: "v3",
                userid: userId,
                appuserid: this.loginUser?.mid ?? GUEST_ID,
            })
            if (!rawResponse) throw new Error(`No response from resync_user for ${userId}`)
            if (rawResponse?.success === false) {
                throw new Error(rawResponse.message || `resync_user failed for ${userId}`)
            }

            const response = rawResponse?.success === true && rawResponse.data != null
                ? rawResponse.data
                : rawResponse
            const userData = response?.user ?? (response?.username ? response : undefined)
            if (!userData || userData.mid !== userId || !userData.username) {
                throw new Error(`Invalid resync_user response for ${userId}`)
            }

            const providerIp = currentUser.providerIp
            const updates = { ...userData } as Partial<User>
            if (providerIp) {
                updates.providerIp = providerIp
                if (updates.avatar) updates.avatar = this.normalizeAvatarUrl(updates.avatar, `http://${providerIp}`)
            }
            updates.client = currentUser.client
            updates.writableHostIp = currentUser.writableHostIp
            this._mergeUserIntoCachedRefs(userId, updates)
            const syncedUser = this.users.get(userId) ?? currentUser

            const tweetRows = Array.isArray(response?.tweets)
                ? response.tweets
                : response?.tweets && typeof response.tweets === 'object'
                    ? [response.tweets]
                    : []
            const syncedTweets: Tweet[] = []
            for (const row of tweetRows) {
                if (!row?.mid || !row?.authorId) continue
                const incoming = { ...row } as Tweet
                if (incoming.authorId === userId) incoming.author = syncedUser
                await this.addTweetToStore(incoming)
                const cached = this.tweetIndex.get(incoming.mid)
                if (cached) syncedTweets.push(cached)
            }

            return { user: syncedUser, tweets: syncedTweets }
        },

        async _fetchUser(userId: MimeiId, forceRefresh: boolean): Promise<User | undefined> {
            if (!forceRefresh) {
                if (this._isFetchCoolingDown(userId)) {
                    const f = this._resourceFetchFailures.get(userId)!
                    console.warn(`[_fetchUser] ${userId} in cooldown (${Math.ceil((f.cooldownUntil - Date.now()) / 1000)}s left, ${f.count} failures), skipping`)
                    return undefined
                }
            }

            // Try the persistent user cache for faster initial display. Route state
            // is restored from NodePool, whose map is session-scoped like iOS.
            if (!forceRefresh) {
                const cachedUser = getStoredUser(userId)
                if (cachedUser) {
                    try {
                        if (cachedUser && cachedUser.mid && cachedUser.hostIds) {
                            const providerIp = await this.getUserReadIp(cachedUser, false)
                            if (!providerIp) {
                                return undefined
                            }
                            cachedUser.providerIp = providerIp
                            cachedUser.client = createPooledClient(providerIp, this.lapi.connectionPool)
                            cachedUser.avatar = this.normalizeAvatarUrl(cachedUser.avatar, `http://${cachedUser.providerIp}`)
                            if (cachedUser.writableHostIp === undefined) {
                                cachedUser.writableHostIp = null
                            }
                            this.users.set(userId, cachedUser)
                            return cachedUser
                        }
                    } catch (e) {
                        console.warn(`[_fetchUser] Failed to parse cached user ${userId}:`, e)
                        this._nullifyCachedIp(userId)
                    }
                }
            }

            // Resolve all provider IPs (up to 2) and race them in parallel.
            // Whichever node responds first with valid user data wins; dead nodes
            // simply lose the race instead of blocking sequentially on a 15s timeout.
            let providerIps: string[]
            try {
                providerIps = await this.getProviderIps(userId, v4Only, forceRefresh)
            } catch (e) {
                console.warn(`[_fetchUser] getProviderIps threw for ${userId}:`, e)
                this._recordFetchFailure(userId, `user:${userId}`)
                return undefined
            }
            if (providerIps.length === 0) {
                console.warn(`[_fetchUser] No provider IPs for user ${userId}`)
                this._recordFetchFailure(userId, `user:${userId}`)
                return undefined
            }

            const raceResult = await this.raceProviderIps(providerIps, async (_ip, client) => {
                const result = await client.RunMApp("get_user", {
                    aid: this.appId,
                    ver: "last",
                    version: "v3",
                    userid: userId,
                })
                // Unwrap v2 response { success, data, message } so a server-side
                // failure throws and the race continues with the other IP.
                if (result && typeof result === 'object' && 'success' in result) {
                    if (result.success === true) return result.data
                    throw new Error(result.message || 'get_user failed')
                }
                return result
            }, `user ${userId}`)

            if (!raceResult) {
                console.error(`[_fetchUser] All provider IPs failed for user ${userId}`)
                this._nullifyCachedIp(userId)
                this._recordFetchFailure(userId, `user:${userId}`)
                return undefined
            }

            let user: any = raceResult.result
            const providerIp = raceResult.ip

            if (!user || typeof user !== 'object' || !user.mid || !user.hostIds) {
                console.error(`[_fetchUser] Invalid user object for ${userId}:`, user)
                this._nullifyCachedIp(userId)
                this._recordFetchFailure(userId, `user:${userId}`)
                return undefined
            }

            // cache the user data
            user.providerIp = providerIp
            // Use server's cloudDrivePort if available
            // IMPORTANT: Use nullish coalescing (??) to allow 0 as a valid value (meaning no service)
            // If cloudDrivePort is not set by server, it remains undefined (no backend service)
            user.cloudDrivePort = user.cloudDrivePort ?? user.clouddriveport
            setStoredUser(userId, user)
            this._clearFetchFailure(userId)
            user.client = createPooledClient(providerIp, this.lapi.connectionPool)
            user.avatar = this.normalizeAvatarUrl(user.avatar, `http://${providerIp}`)
            // Initialize writableHostIp if not already set
            if (user.writableHostIp === undefined) {
                user.writableHostIp = null
            }
            if (this._user?.mid === userId) {
                const previousWritableHostIp = this._user.writableHostIp
                const previousClient = this._user.client
                Object.assign(this._user as any, user as any)
                if (previousWritableHostIp) {
                    this._user.writableHostIp = previousWritableHostIp
                    if (previousClient) this._user.client = previousClient
                }
                this.users.set(userId, this._user)
                setStoredUser(userId, this._user)
                setStoredLoginUser(this._user)
                this._rewriteUserMediaHosts(userId, providerIp)
                return this._user
            }
            const existingUser = this.users.get(userId)
            if (existingUser) {
                // Preserve object identity so existing tweet/header refs receive refreshed fields.
                Object.assign(existingUser as any, user as any)
                this._rewriteUserMediaHosts(userId, providerIp)
                return existingUser
            }
            this.users.set(userId, user)
            this._rewriteUserMediaHosts(userId, providerIp)
            return user
        },

        /**
         * After raceProviderIps elects a fresh winner for a user, rewrite the
         * host portion of any cached attachment URLs that were built against an
         * older (now dead) provider IP. Only the host swaps; the /ipfs/<hash>
         * path is preserved. Also refreshes the `provider` field on each tweet
         * and the cached `author.providerIp` / `author.avatar` so subsequent
         * renders use the live host.
         */
        _rewriteUserMediaHosts(userId: MimeiId, newProviderIp: string) {
            const newBase = `http://${newProviderIp}`
            const swapHost = (url: string | undefined): string | undefined => {
                if (!url) return url
                if (!/^https?:\/\//i.test(url)) return url
                return url.replace(/^https?:\/\/[^/]+/, newBase)
            }
            const fixTweet = (t: Tweet | undefined | null) => {
                if (!t) return
                const isOurs = (t.author && t.author.mid === userId) || t.authorId === userId
                if (!isOurs) return
                t.provider = newProviderIp
                if (t.author) {
                    if (t.author.providerIp !== newProviderIp) t.author.providerIp = newProviderIp
                    t.author.avatar = swapHost(t.author.avatar) ?? t.author.avatar
                }
                if (t.attachments) {
                    for (const a of t.attachments) {
                        const next = swapHost(a.mid as any)
                        if (next) a.mid = next
                    }
                }
            }

            for (const t of this.tweets) {
                fixTweet(t)
                fixTweet(t?.originalTweet as any)
            }
            for (const t of this.originalTweetIndex.values()) fixTweet(t)
        },
        
        /**
         * Remove a user from cache and session storage
         * @param userId The user ID to remove
         */
        removeUser(userId: MimeiId) {
            this._invalidateUserProviderCache(userId)
        },

        /**
         * Given a mimie Id, find IP of its best provider
         * @param mid The Mimei ID to find provider for
         * @returns The IP address of the best provider or null if not found
         */
        /**
         * Check if a server is alive by making a simple HTTP HEAD request
         * Uses caching to avoid redundant checks
         * @param ip The IP address (with optional port) to check
         * @returns True if server responds, false otherwise
         */
        async isServerHealthy(ip: string, timeoutMs: number = 5000, refresh: boolean = false): Promise<boolean> {
            if (!refresh) {
                const cachedStatus = this.getFreshHealthStatus(ip);
                if (cachedStatus !== undefined) return cachedStatus;
            }

            const inProgress = this.healthCheckInProgress.get(ip);
            if (inProgress) return await inProgress;

            const probe = (async () => {
                const controller = new AbortController();
                const tid = setTimeout(() => controller.abort(), timeoutMs);
                let isHealthy = false;
                try {
                    // HEAD probe: no body sent or received — just checks TCP + HTTP reachability.
                    // no-cors is required for cross-origin servers that don't send CORS headers.
                    await fetch(`http://${ip}`, {
                        method: 'HEAD',
                        mode: 'no-cors',
                        cache: 'no-store',
                        signal: controller.signal,
                    });
                    isHealthy = true;
                } catch {
                    isHealthy = false;
                } finally {
                    clearTimeout(tid);
                    this.healthCheckCache.set(ip, { isHealthy, timestamp: Date.now() });
                    this.healthCheckInProgress.delete(ip);
                }
                console.log(`[isServerHealthy] ${ip}: ${isHealthy ? 'healthy' : 'unhealthy'}`);
                return isHealthy;
            })();

            this.healthCheckInProgress.set(ip, probe);
            return probe;
        },

        getFreshHealthStatus(ip: string): boolean | undefined {
            const cached = this.healthCheckCache.get(ip);
            if (!cached) return undefined;
            // A failed probe is far weaker evidence than a successful one: on a
            // cold start the probe budget expires before a sleeping node answers.
            // Remembering that "failure" for the full healthy TTL made the route
            // unusable for half an hour and made the retry button fail instantly.
            const ttl = cached.isHealthy ? HEALTH_CHECK_CACHE_TTL : HEALTH_CHECK_FAILURE_TTL;
            return (Date.now() - cached.timestamp) < ttl ? cached.isHealthy : undefined;
        },

        async isServerHealthyWithTimeout(ip: string, timeout: number = 5000, refresh: boolean = false): Promise<boolean> {
            return this.isServerHealthy(ip, timeout, refresh);
        },

        /**
         * Get provider IP for a user with health checking
         * Calls get_provider_ips API and tests IPs in pairs with 10-second timeout
         * @param mid User's member ID
         * @param v4only If true, filter out IPv6 addresses. Default is v4Only.
         * @returns A healthy provider IP address, or null if none found
         */
        /**
         * Race multiple API calls with different provider IPs, return result from first successful call
         * @param ips Array of IP addresses to try
         * @param apiCall Function that takes an IP and client, returns a promise of the API call
         * @returns Result from the first successful API call, or null if all fail
         */
        async raceProviderIps<T>(
            ips: string[],
            apiCall: (ip: string, client: any) => Promise<T>,
            context?: string
        ): Promise<{ result: T, ip: string } | null> {
            if (ips.length === 0) {
                return null;
            }

            const contextLabel = context ? ` for ${context}` : ''
            console.log(`[raceProviderIps] Racing ${ips.length} IP(s)${contextLabel}:`, ips);

            // Create promises for each IP with individual timeouts.
            //
            // IMPORTANT: use createPooledClient (auto-releasing proxy) instead
            // of lapi.getClient (raw client). lapi.getClient acquires a pool
            // slot but never releases it, leaking one slot per race attempt;
            // after a few batches the pool saturates and subsequent races
            // time out at 15s with "Connection request timeout for ...". The
            // proxy releases the slot after each RPC method call.
            const racePromises = ips.map(async (ip) => {
                try {
                    const client = createPooledClient(ip, this.lapi.connectionPool);

                    // Race the API call with a 15-second timeout (slow nodes / follow path)
                    const raceMs = 15000
                    const result = await Promise.race([
                        apiCall(ip, client),
                        new Promise<never>((_, reject) =>
                            setTimeout(() => reject(new Error(`Timeout after ${raceMs}ms for ${ip}`)), raceMs)
                        )
                    ]);

                    console.log(`[raceProviderIps] ✅ Success with IP: ${ip}${contextLabel}`);
                    return { result, ip };
                } catch (error) {
                    console.warn(`[raceProviderIps] ❌ Failed with IP: ${ip}${contextLabel}`, error);
                    throw error; // Re-throw so Promise.any sees this as a rejection
                }
            });

            try {
                // First fulfilled wins; rejections are ignored unless ALL reject.
                // Using Promise.any (not Promise.race) so a fast rejection from a
                // dead IP doesn't cancel the still-pending healthy IP.
                const winner = await Promise.any(racePromises);
                return winner;
            } catch (error) {
                console.error(`[raceProviderIps] All IPs failed${contextLabel}:`, error);
                return null;
            }
        },

        /**
         * Get a single provider IP for a given mid (returns first available)
         * @param mid The mid to get provider IP for
         * @param v4only Whether to filter out IPv6 addresses (default: v4Only)
         * @returns A single IP address, or null if none found
         */
        async getProviderIp(mid: string, v4only: boolean = v4Only, refresh: boolean = false): Promise<string | null> {
            const ips = await this.getProviderIps(mid, v4only, refresh);
            return ips.length > 0 ? ips[0] : null;
        },

        /** Resolve a fresh, healthy public IPv4 specifically for a shared URL. */
        async getPublicProviderIPv4(mid: string): Promise<string | null> {
            const ips = await this._resolveProviderIps(mid, true, true, true);
            return ips[0] ?? null;
        },

        /**
         * Nullify the providerIp in the per-tab user cache,
         * so the next fetch won't reuse a stale IP while preserving other cached data.
         */
        _nullifyCachedIp(userId: string) {
            nodePool.invalidate(userId)
            const cached = getStoredUser(userId)
            if (cached) {
                try {
                    const cachedUser = cached
                    const accessNodeId = cachedUser.hostIds?.[1] ?? cachedUser.hostIds?.[0]
                    if (accessNodeId) nodePool.invalidate(accessNodeId)
                    setStoredUser(userId, cachedUser)
                } catch (e) {
                    clearStoredUser(userId)
                }
            }
        },

        _isFetchCoolingDown(resourceId: string): boolean {
            const failure = this._resourceFetchFailures.get(resourceId)
            return !!failure && Date.now() < failure.cooldownUntil
        },

        _recordFetchFailure(resourceId: string, label: string = resourceId) {
            const prev = this._resourceFetchFailures.get(resourceId)
            const count = (prev?.count ?? 0) + 1
            if (count >= 2) {
                const backoff = Math.min(USER_FETCH_COOLDOWN_BASE_MS * Math.pow(2, count - 2), USER_FETCH_COOLDOWN_MAX_MS)
                this._resourceFetchFailures.set(resourceId, { count, cooldownUntil: Date.now() + backoff })
                console.warn(`[fetchFailure] ${label} failed ${count}x; cooling down for ${backoff / 1000}s`)
            } else {
                this._resourceFetchFailures.set(resourceId, { count, cooldownUntil: 0 })
            }
        },

        _clearFetchFailure(resourceId: string) {
            this._resourceFetchFailures.delete(resourceId)
        },

        /**
         * Get the first pair of provider IPs for a given mid without testing them
         * @param mid The mid to get provider IPs for
         * @param v4only Whether to filter out IPv6 addresses (default: v4Only)
         * @returns Array of IP addresses (up to 2), or empty array if none found
         */
        async getProviderIps(mid: string, v4only: boolean = v4Only, refresh: boolean = false): Promise<string[]> {
            // A cold-start retry must not join the original in-flight lookup.
            // Refresh provider discovery directly, while keeping tweet retrieval
            // on the ordinary get_tweet path (not the recovery-only refresh_tweet).
            if (refresh) {
                const refreshedIps = await this._resolveProviderIps(mid, v4only, true, false, false)
                if (refreshedIps.length > 0) {
                    nodePool.updateNode(mid, refreshedIps)
                } else {
                    nodePool.invalidate(mid)
                }
                return refreshedIps
            }

            const pooledIp = nodePool.getIPForNode(mid)
            const usablePooledIp = pooledIp
                ? browserUsableProviderRoutes([pooledIp], window.location.hostname)[0]
                : undefined
            if (pooledIp && !usablePooledIp) {
                nodePool.removeIP(mid, pooledIp)
            } else if (usablePooledIp) {
                const cachedStatus = this.getFreshHealthStatus(usablePooledIp)
                if (cachedStatus === true) return [usablePooledIp]

                if (cachedStatus === false) {
                    console.warn(`[getProviderIps] Pooled IP ${usablePooledIp} for ${mid} is unhealthy; removing from NodePool`)
                    nodePool.removeIP(mid, usablePooledIp)
                } else {
                    console.log(`[getProviderIps] Found pooled IP for ${mid}: ${usablePooledIp}, testing health`)
                    const healthy = await this.isServerHealthyWithTimeout(usablePooledIp, 3000)
                    if (healthy) {
                        return [usablePooledIp]
                    }
                    console.warn(`[getProviderIps] Pooled IP ${usablePooledIp} for ${mid} is unhealthy; removing from NodePool`)
                    nodePool.removeIP(mid, usablePooledIp)
                }
            }
            return nodePool.resolveIPs(mid, () => this._resolveProviderIps(mid, v4only, false, false, false), true);
        },

        async getUserReadIp(user: User, refresh: boolean = false): Promise<string | null> {
            const accessNodeId = user.hostIds?.[1] ?? user.hostIds?.[0]
            if (accessNodeId) {
                const nodeIp = await this.getNodeIpByHostId(accessNodeId, refresh)
                if (nodeIp) {
                    return nodeIp
                }
            }
            const providerIp = await this.getProviderIp(user.mid, v4Only, refresh)
            return providerIp
        },

        async getNodeIpByHostId(hostId: string, refresh: boolean = false): Promise<string | null> {
            if (!refresh && this._isFetchCoolingDown(hostId)) {
                const f = this._resourceFetchFailures.get(hostId)!
                console.warn(`[getNodeIp] ${hostId} in cooldown (${Math.ceil((f.cooldownUntil - Date.now()) / 1000)}s left), skipping`)
                return null
            }
            if (!refresh) {
                const pooledIp = nodePool.getIPForNode(hostId)
                const usablePooledIp = pooledIp
                    ? browserUsableProviderRoutes([pooledIp], window.location.hostname)[0]
                    : undefined
                if (pooledIp && !usablePooledIp) {
                    nodePool.removeIP(hostId, pooledIp)
                } else if (usablePooledIp) {
                    const cachedStatus = this.getFreshHealthStatus(usablePooledIp)
                    if (cachedStatus === true) return usablePooledIp

                    if (cachedStatus === false) {
                        console.warn(`[getNodeIp] Pooled IP ${usablePooledIp} for node ${hostId} is unhealthy; removing from NodePool`)
                        nodePool.removeIP(hostId, usablePooledIp)
                    } else {
                        console.log(`[getNodeIp] Found pooled IP for node ${hostId}: ${usablePooledIp}, testing health`)
                        const healthy = await this.isServerHealthyWithTimeout(usablePooledIp, 5000)
                        if (healthy) {
                            return usablePooledIp
                        }
                        console.warn(`[getNodeIp] Pooled IP ${usablePooledIp} for node ${hostId} is unhealthy. Removing from NodePool`)
                        nodePool.removeIP(hostId, usablePooledIp)
                    }
                }
            }

            const ips = await nodePool.resolveIPs(hostId, async () => {
                const resolved = await this._resolveNodeIps(hostId, refresh)
                // This callback runs once for all callers sharing the NodePool
                // request, so one failed probe produces one cooldown increment.
                if (resolved.length > 0) {
                    this._clearFetchFailure(hostId)
                } else {
                    this._recordFetchFailure(hostId, `node:${hostId}`)
                }
                return resolved
            }, true)
            return ips[0] ?? null
        },

        async _resolveNodeIps(hostId: string, refresh: boolean = false): Promise<string[]> {
            try {
                const params: any = {
                    aid: this.lapi.appId, ver: "last", version: "v2",
                    nodeid: hostId,
                };
                if (v4Only) params.v4only = "true";

                const ipResponse = await this.lapi.client.RunMApp("get_node_ips", params);
                if (!ipResponse) {
                    console.error(`[getNodeIp] No response for nodeId ${hostId}`);
                    return [];
                }

                let ipList: string[] = [];
                if (Array.isArray(ipResponse)) ipList = ipResponse;
                else if (typeof ipResponse === 'string') ipList = [ipResponse];
                else if (typeof ipResponse === 'object' && Array.isArray(ipResponse.data)) ipList = ipResponse.data;
                else if (typeof ipResponse === 'object' && typeof ipResponse.data === 'string') ipList = [ipResponse.data];
                else {
                    console.error(`[getNodeIp] Invalid response for nodeId ${hostId}:`, ipResponse);
                    return [];
                }

                const ipAddresses = ipList
                    .map(ip => ip.trim())
                    .filter(ip => {
                        if (!ip) return false;
                        if (v4Only && (ip.includes('[') || (ip.match(/:/g) || []).length > 1)) return false;
                        return true;
                    });

                const candidates = browserUsableProviderRoutes(ipAddresses, window.location.hostname);

                if (candidates.length === 0) {
                    console.error(`[getNodeIp] No valid IPs for nodeId ${hostId}`);
                    return [];
                }

                const winner = await new Promise<string | null>((resolve) => {
                    let settled = 0;
                    for (const ip of candidates) {
                        this.isServerHealthyWithTimeout(ip, 5000, refresh).then(healthy => {
                            if (healthy) { resolve(ip); return; }
                            if (++settled === candidates.length) resolve(null);
                        }).catch(() => {
                            if (++settled === candidates.length) resolve(null);
                        });
                    }
                });

                if (!winner) {
                    // Same reasoning as _resolveProviderIps: an unanswered probe on a
                    // cold node must not cost the caller its route (and a fetch-failure
                    // cooldown on top). The RPC that follows has its own timeout.
                    console.warn(`[getNodeIp] No candidate answered the health probe for nodeId ${hostId}; returning ${candidates.length} unverified route(s)`);
                    return candidates;
                }

                console.log(`[getNodeIp] ✅ First healthy IP for nodeId ${hostId}:`, winner);
                return [winner];
            } catch (error) {
                console.error(`[getNodeIp] Error for nodeId ${hostId}:`, error);
                return [];
            }
        },

        /** Raw RPC call to resolve provider IPs — called via nodePool for caching & dedup */
        async _resolveProviderIps(
            mid: string,
            v4only: boolean,
            refresh: boolean,
            publicIPv4Only: boolean = false,
            requireHealthy: boolean = true,
        ): Promise<string[]> {
            try {
                console.log(`[getProviderIps] RPC call for ${mid} (v4only: ${v4only}, refresh: ${refresh})...`);

                // Call get_provider_ips (plural) to get list of IPs
                const params: any = {
                    aid: this.lapi.appId,
                    ver: "last",
                    version: "v2",
                    mid: mid,
                };

                // Only add v4only parameter if true
                if (v4only) {
                    params.v4only = "true";
                }

                // Force server to bypass its IP cache and return fresh IPs
                if (refresh) {
                    params.refresh = "true";
                }

                const ipResponse = await this.lapi.client.RunMApp("get_provider_ips", params);

                if (!ipResponse) {
                    console.error("[getProviderIps] No response from get_provider_ips for", mid);
                    return [];
                }

                // Handle the response - could be array or wrapped in data property
                let ipList: string[] = [];

                if (Array.isArray(ipResponse)) {
                    ipList = ipResponse;
                } else if (typeof ipResponse === 'object' && Array.isArray(ipResponse.data)) {
                    ipList = ipResponse.data;
                } else if (typeof ipResponse === 'string') {
                    // Single IP as string
                    ipList = [ipResponse];
                } else if (typeof ipResponse === 'object' && typeof ipResponse.data === 'string') {
                    // Single IP wrapped in data
                    ipList = [ipResponse.data];
                } else {
                    console.error("[getProviderIps] Invalid response format from get_provider_ips:", ipResponse);
                    return [];
                }

                // Filter and trim IP addresses, optionally removing IPv6 addresses
                const ipAddresses = ipList
                    .map(ip => ip.trim())
                    .filter(ip => {
                        if (ip.length === 0) return false;

                        // If v4only is true, filter out IPv6 addresses
                        if (ip.includes('[') || ip.includes(']')) return false;
                        // Count colons - IPv6 has multiple colons, IPv4 with port has only one
                        const colonCount = (ip.match(/:/g) || []).length;
                        if (v4only && colonCount > 1) return false;

                        return true;
                    });

                // A public page cannot contact RFC1918/RFC6598 routes even when
                // the device itself belongs to that tailnet: Chrome blocks the
                // request through Private Network Access before it reaches the
                // network. Private-origin deployments retain those routes.
                const candidates = publicIPv4Only
                    ? ipAddresses.filter(ip => publicIPv4BaseUrl(ip) !== undefined)
                    : browserUsableProviderRoutes(ipAddresses, window.location.hostname);

                if (candidates.length === 0) {
                    if (!refresh) {
                        console.warn(`[getProviderIps] Only unusable cached routes returned for ${mid}; retrying with refresh`);
                        return this._resolveProviderIps(mid, v4only, true, publicIPv4Only, requireHealthy);
                    }
                    console.error("[getProviderIps] No valid IPs returned for", mid);
                    return [];
                }

                // Race every browser-usable route. Filtering must happen before
                // limiting candidates, otherwise early Tailscale routes hide a
                // later public route and public deep links cannot load.
                const winner = await new Promise<string | null>((resolve) => {
                    let settled = 0;
                    for (const ip of candidates) {
                        this.isServerHealthyWithTimeout(ip, 3000, refresh).then(healthy => {
                            if (healthy) { resolve(ip); return; }
                            if (++settled === candidates.length) resolve(null);
                        }).catch(() => {
                            if (++settled === candidates.length) resolve(null);
                        });
                    }
                });

                if (!winner) {
                    if (requireHealthy) {
                        throw new Error(`[getProviderIps] All provider health checks failed for ${mid}`);
                    }
                    // The probe picks the fastest route; it is not the authority on
                    // reachability. A cold node (asleep, cold DNS/TCP, mobile radio
                    // waking) routinely needs longer than the probe budget while the
                    // real RPC — which gets 15s of its own — would have succeeded.
                    // Hand the candidates back and let that call be the judge.
                    console.warn(`[getProviderIps] No candidate answered the health probe for ${mid}; racing all ${candidates.length} route(s) unverified`);
                    return candidates;
                }

                console.log(`[getProviderIps] First healthy IP for ${mid}:`, winner);
                return [winner];

            } catch (error) {
                if (error instanceof Error && error.message.startsWith('[getProviderIps] All provider health checks failed')) {
                    throw error;
                }
                console.error("[getProviderIps] Error getting provider IPs for", mid, error);
                return [];
            }
        },
        /**
         * Load comments of a tweet into its comments attribute.
         * Comments are on the same node with the tweet.
         * @param tweet The tweet to load comments for
         */
        async loadComments(tweet: Tweet): Promise<void> {
            if (!tweet || !tweet.provider) {
                console.warn('[loadComments] Skipping: no tweet or provider', tweet?.mid, tweet?.provider)
                return
            }
            console.log('[loadComments] Loading comments for tweet:', tweet.mid, 'provider:', tweet.provider)
            // Use auto-releasing proxy so the pool slot is freed after the RPC.
            let client = createPooledClient(tweet.provider, this.lapi.connectionPool)
            const raw = await client.RunMApp("get_comments", {
                aid: this.lapi.appId,
                ver: "last",
                version: "v2",
                tweetid: tweet.mid,
                appuserid: this.loginUser?.mid ? this.loginUser?.mid : GUEST_ID,
                pn: 0,
                ps: 20
            }) as any

            // Unwrap v2 envelope {success, data} or accept bare array (older server).
            let comments: any[]
            if (Array.isArray(raw)) {
                comments = raw
            } else if (raw && typeof raw === 'object' && 'success' in raw) {
                comments = raw.success ? (raw.data ?? []) : []
            } else {
                comments = []
            }

            console.log('[loadComments] API returned:', comments?.length ?? 0, 'comments', comments)

            // comment type is a different Tweet type from the definition in this app
            if (comments) {
                // Phase 1: build all comment objects synchronously — no author yet.
                // Building first, then assigning to tweet.comments, then kicking off
                // author lookups, ensures every author write goes through the
                // reactive proxy that Vue creates when an object is placed into
                // store state. (Mutating the raw closure reference would not
                // trigger re-render once the proxy exists.)
                const tweetProvider = tweet.provider
                const validComments: any[] = []
                for (const e of comments) {
                    if (!e) continue  // null entry — comment not yet synced to read node, no ID available
                    if (!e.mid) continue
                    if (!e.authorId) continue  // has mid but malformed — skip
                    const locallyKnown = this.tweetIndex.get(e.mid)
                    const override = this.interactionOverrides.get(e.mid)
                    const serverFlags = Array.isArray(e.favorites) ? [...e.favorites] : [false, false, false]
                    while (serverFlags.length < 3) serverFlags.push(false)
                    if (override?.favorite !== undefined) serverFlags[0] = override.favorite
                    if (override?.bookmark !== undefined) serverFlags[1] = override.bookmark
                    const comment: any = {
                        mid: e.mid,
                        authorId: e.authorId,
                        author: null as User | null,
                        content: e.content,
                        timestamp: e.timestamp,
                        provider: tweetProvider,
                        likeCount: e.favoriteCount ?? e.likeCount ?? 0,
                        bookmarkCount: e.bookmarkCount ?? 0,
                        commentCount: e.commentCount ?? 0,
                        favorites: serverFlags,
                        parentTweetId: tweet.mid,
                        interactionHostAuthor: tweet.author,
                        favoriteOverride: override?.favorite ?? locallyKnown?.favoriteOverride,
                        bookmarkOverride: override?.bookmark ?? locallyKnown?.bookmarkOverride,
                        comments: [],
                        attachments: e.attachments?.filter((a: MimeiFileType | null) => a !== null && a !== undefined)
                            .map((a: MimeiFileType) => {
                                // Comments are stored on the same node as the parent tweet.
                                if (a.mid && tweetProvider) {
                                    a.mid = this.getMediaUrl(a.mid, "http://" + tweetProvider)
                                }
                                return a
                            }),
                    }
                    validComments.push(comment)
                }

                // Phase 2: atomically replace tweet.comments with fresh server data.
                // Preserve any locally-created comments not yet returned by the server
                // (e.g. optimistic inserts).
                const freshMids = new Set(validComments.map(c => c.mid))
                const localOnly = (tweet.comments ?? []).filter(c => !freshMids.has(c.mid))
                tweet.comments = [...validComments, ...localOnly]

                // Phase 3: load authors asynchronously and write them onto the
                // proxied entries inside tweet.comments. Looking up by mid each
                // time guarantees we mutate the reactive proxy — which works
                // even if the comments array gets replaced again later.
                const setCommentAuthor = (mid: MimeiId, author: any) => {
                    if (!author || !tweet.comments) return
                    const rc = tweet.comments.find(c => c.mid === mid)
                    if (rc) rc.author = author
                }
                for (const e of comments) {
                    if (!e || !e.mid || !e.authorId) continue
                    const commentMid = e.mid as MimeiId
                    const authorId = e.authorId as MimeiId
                    void (async () => {
                        // 1. Synchronous in-memory cache — no network, instant
                        const inMemory = (this.loginUser?.mid === authorId ? this.loginUser : undefined)
                            ?? this.users.get(authorId)
                        if (inMemory) { setCommentAuthor(commentMid, inMemory); return }

                        // 2. Tweet's own provider — known-reachable, no delay
                        if (tweetProvider) {
                            try {
                                const c = createPooledClient(tweetProvider, this.lapi.connectionPool)
                                const result = await c.RunMApp("get_user", {
                                    aid: this.appId, ver: "last", version: "v3", userid: authorId,
                                })
                                const ud = (result?.success === true) ? result.data : result
                                if (ud?.mid && ud?.hostIds) {
                                    ud.providerIp = tweetProvider
                                    ud.client = createPooledClient(tweetProvider, this.lapi.connectionPool)
                                    ud.avatar = this.normalizeAvatarUrl(ud.avatar, `http://${tweetProvider}`)
                                    if (ud.writableHostIp === undefined) ud.writableHostIp = null
                                    const rooted = await this._ensureUserRootHost(ud as User)
                                    this.users.set(authorId, rooted)
                                    setCommentAuthor(commentMid, rooted)
                                    return
                                }
                            } catch (err) {
                                console.warn("[loadComments] tweet-provider get_user failed for", authorId, err)
                            }
                        }

                        // 3. User's own provider — one fallback attempt. Comment
                        // text can render without repeatedly blocking on author
                        // decoration when a node is slow.
                        try {
                            const author = await this._getUserForProviderRetryAttempt(authorId, 1)
                            if (author) { setCommentAuthor(commentMid, author); return }
                        } catch (error: any) {
                            if (!error?.message?.includes('timeout'))
                                console.warn("Error loading comment author:", authorId, error)
                        }
                    })()
                }
            }
            tweet.comments?.sort((a, b) => (b.timestamp as number) - (a.timestamp as number))
        },

        /**
         * Appends the next page of comments to tweet.comments without replacing existing ones.
         * Mirrors iOS TweetDetailView's paginated commentFetcher (fetchComments page/size).
         * @returns true if there may be more comments (fetched count >= pageSize)
         */
        async loadMoreComments(tweet: Tweet, pageNumber: number, pageSize: number = 20): Promise<boolean> {
            if (!tweet || !tweet.provider) return false

            const tweetProvider = tweet.provider
            const client = createPooledClient(tweetProvider, this.lapi.connectionPool)

            let rawComments: any[]
            try {
                rawComments = await client.RunMApp("get_comments", {
                    aid: this.lapi.appId,
                    ver: "last",
                    tweetid: tweet.mid,
                    appuserid: this.loginUser?.mid ?? GUEST_ID,
                    pn: pageNumber,
                    ps: pageSize,
                }) as any[]
            } catch (e) {
                console.warn('[loadMoreComments] Failed to fetch page', pageNumber, e)
                return false
            }

            if (!rawComments || rawComments.length === 0) return false

            const existingMids = new Set((tweet.comments ?? []).map(c => c.mid))
            const newComments: any[] = []

            for (const e of rawComments) {
                if (!e || !e.mid || !e.authorId || existingMids.has(e.mid)) continue
                const locallyKnown = this.tweetIndex.get(e.mid)
                const override = this.interactionOverrides.get(e.mid)
                const serverFlags = Array.isArray(e.favorites) ? [...e.favorites] : [false, false, false]
                while (serverFlags.length < 3) serverFlags.push(false)
                if (override?.favorite !== undefined) serverFlags[0] = override.favorite
                if (override?.bookmark !== undefined) serverFlags[1] = override.bookmark
                newComments.push({
                    mid: e.mid,
                    authorId: e.authorId,
                    author: null as any,
                    content: e.content,
                    timestamp: e.timestamp,
                    provider: tweetProvider,
                    likeCount: e.favoriteCount ?? e.likeCount ?? 0,
                    bookmarkCount: e.bookmarkCount ?? 0,
                    commentCount: e.commentCount ?? 0,
                    favorites: serverFlags,
                    parentTweetId: tweet.mid,
                    interactionHostAuthor: tweet.author,
                    favoriteOverride: override?.favorite ?? locallyKnown?.favoriteOverride,
                    bookmarkOverride: override?.bookmark ?? locallyKnown?.bookmarkOverride,
                    comments: [],
                    attachments: e.attachments
                        ?.filter((a: any) => a != null)
                        .map((a: any) => {
                            if (a.mid && tweetProvider) {
                                a.mid = this.getMediaUrl(a.mid, 'http://' + tweetProvider)
                            }
                            return a
                        }),
                })
            }

            if (newComments.length > 0) {
                tweet.comments = [...(tweet.comments ?? []), ...newComments]

                // Load authors asynchronously — same pattern as loadComments
                const setCommentAuthor = (mid: MimeiId, author: any) => {
                    if (!author || !tweet.comments) return
                    const rc = tweet.comments.find(c => c.mid === mid)
                    if (rc) rc.author = author
                }
                for (const e of rawComments) {
                    if (!e || !e.mid || !e.authorId) continue
                    const commentMid = e.mid as MimeiId
                    const authorId = e.authorId as MimeiId
                    void (async () => {
                        const inMemory = (this.loginUser?.mid === authorId ? this.loginUser : undefined)
                            ?? this.users.get(authorId)
                        if (inMemory) { setCommentAuthor(commentMid, inMemory); return }

                        if (tweetProvider) {
                            try {
                                const c = createPooledClient(tweetProvider, this.lapi.connectionPool)
                                const result = await c.RunMApp("get_user", {
                                    aid: this.appId, ver: "last", version: "v3", userid: authorId,
                                })
                                const ud = (result?.success === true) ? result.data : result
                                if (ud?.mid && ud?.hostIds) {
                                    ud.providerIp = tweetProvider
                                    ud.client = createPooledClient(tweetProvider, this.lapi.connectionPool)
                                    ud.avatar = this.normalizeAvatarUrl(ud.avatar, `http://${tweetProvider}`)
                                    if (ud.writableHostIp === undefined) ud.writableHostIp = null
                                    const rooted = await this._ensureUserRootHost(ud as User)
                                    this.users.set(authorId, rooted)
                                    setCommentAuthor(commentMid, rooted)
                                    return
                                }
                            } catch (err) {
                                console.warn("[loadMoreComments] get_user failed for", authorId, err)
                            }
                        }

                        try {
                            const author = await this._getUserForProviderRetryAttempt(authorId, 1)
                            if (author) { setCommentAuthor(commentMid, author); return }
                        } catch (error: any) {
                            if (!error?.message?.includes('timeout'))
                                console.warn("[loadMoreComments] Error loading author:", authorId, error)
                        }
                    })()
                }
            }

            return rawComments.length >= pageSize
        },

        /**
         * Constructs the full media URL from a media ID and base URL
         * @param mid The media ID
         * @param baseUrl The base URL for the media server
         * @returns The complete media URL
         */
        getMediaUrl(mid: string | undefined, baseUrl: string): string {
            if (!mid) {
                return import.meta.env.VITE_APP_LOGO
            }
            return mid.length > 27 ? baseUrl + "/ipfs/" + mid : baseUrl + "/mm/" + mid
        },

        /**
         * Normalize user avatar to a concrete URL on the given base URL.
         * - If avatar is already a full URL, keep path and only swap host.
         * - If avatar is a raw mimei hash/id, build URL via getMediaUrl.
         */
        normalizeAvatarUrl(avatar: string | undefined, baseUrl: string): string {
            if (!avatar) return import.meta.env.VITE_APP_LOGO
            if (/^https?:\/\//i.test(avatar)) {
                // Only swap host for node-scoped media URLs.
                // Keep static/default avatar URLs (e.g. app CDN/logo) unchanged.
                if (/^https?:\/\/[^/]+\/(?:ipfs|mm)\//i.test(avatar)) {
                    return avatar.replace(/^https?:\/\/[^/]+/i, baseUrl)
                }
                return avatar
            }
            if (avatar.startsWith('/')) {
                return `${baseUrl}${avatar}`
            }
            return this.getMediaUrl(avatar, baseUrl)
        },

        /**
         * Authenticates a user with username and password. Also assign the hostIP
         * to login user.
         * @param username The username to login with
         * @param password The password for authentication
         * @returns The user object if login successful
         */
        async login(username: string, password: string) {
            const maxRetries = 2;
            let lastError: any = null;

            console.log(`[login] Starting login for username: ${username}`);

            for (let attempt = 0; attempt <= maxRetries; attempt++) {
                try {
                    console.log(`[login] Attempt ${attempt + 1}/${maxRetries + 1}`);
                    
                    // given username, get UserId
                    console.log(`[login] Calling get_userid for username: ${username}`);
                    let userId = await this.lapi.client.RunMApp("get_userid", {
                        aid: this.appId, ver: "last", username: username
                    })
                    console.log(`[login] Got userId: ${userId}`)
                    if (!userId) {
                        console.error(`[login] getUserId returned null for username: ${username}`)
                        throw new Error("User not found. Please check your username.")
                    }
                    
                    console.log(`[login] Calling getUser for userId: ${userId} with forceRefresh=true`);
                    // Force refresh to bypass cache and get fresh IP (like iOS does)
                    // Clear any cached user data before retry to force fresh IP resolution
                    if (attempt > 0) {
                        this._invalidateUserProviderCache(userId)
                    }
                    let user = await this.getUser(userId, true)
                    console.log(`[login] getUser returned:`, user ? `user with providerIp: ${user.providerIp}` : 'null')
                    if (!user) {
                        // Retry on user fetch failure (could be network issue)
                        if (attempt < maxRetries) {
                            console.warn(`Login attempt ${attempt + 1} failed: Could not fetch user data. Retrying...`)
                            lastError = new Error("Could not fetch user data")
                            await this.delay(1000 * (attempt + 1)) // Exponential backoff: 1s, 2s
                            continue
                        }
                        console.error("Login failed: Could not fetch user data", userId)
                        throw new Error("Could not fetch user data. Please try again.")
                    }
                    
                    console.log(`[login] Calling login API for user: ${username} at ${user.providerIp}`);
                    // Login can be slower than routine RPC; allow 30s (default RPC is 15s).
                    const originalTimeout = user.client.timeout
                    user.client.timeout = 30000
                    let ret
                    try {
                        ret = await user.client.RunMApp("login", {
                            aid: this.appId, 
                            ver: "last", 
                            version: "v2",  // Request v2 format response
                            username: username, 
                            password: password
                        })
                    } finally {
                        // Restore original timeout
                        user.client.timeout = originalTimeout
                    }
                    console.log(`[login] Login API returned:`, ret);
                    if (!ret) {
                        // Retry on authentication failure (could be network issue)
                        if (attempt < maxRetries) {
                            console.warn(`Login attempt ${attempt + 1} failed: Authentication failed. Retrying...`)
                            lastError = new Error("Authentication failed")
                            await this.delay(1000 * (attempt + 1)) // Exponential backoff: 1s, 2s
                            continue
                        }
                        console.error("Login failed: Authentication failed", userId)
                        throw new Error("Authentication failed. Please check your credentials.")
                    }
                    
                    // Handle v2 format: check success field first, then status field for backward compatibility
                    let loginSuccess = false
                    let failureReason = ""
                    
                    if (ret["success"] !== undefined) {
                        // v2 format response
                        loginSuccess = ret["success"] === true
                        if (!loginSuccess) {
                            failureReason = ret["message"] || "Login failed"
                        }
                    } else if (ret["status"] !== undefined) {
                        // Legacy format response
                        loginSuccess = ret["status"] === 'success'
                        if (!loginSuccess) {
                            failureReason = ret["reason"] || "Login failed"
                        }
                    } else {
                        // Invalid response format
                        console.error("Invalid login response format", ret)
                        failureReason = "Invalid server response"
                    }
                    
                    if (loginSuccess) {
                        console.log(`[login] Login successful for ${username}`);
                        // Use authentication provider IP for login - writable host will be fetched lazily when needed
                        console.log(`[login] Using authentication provider IP: ${user.providerIp}`)

                        if (!user.providerIp) {
                            console.error("Login failed: No provider IP available for user", user)
                            throw new Error("No server connection available. Please try again later.")
                        }

                        // Store user data and create client with auth provider IP
                        setStoredLoginUser(user)
                        user.client = createPooledClient(user.providerIp, this.lapi.connectionPool)
                        this._user = user
                        this.addFollowing(userId)

                        // Resolve the writable host in the background and fix the avatar URL.
                        // The avatar CID was uploaded to the writable host; the providerIp used
                        // during _fetchUser may be a different replica that hasn't replicated it.
                        // When this resolves, _mergeUserIntoCachedRefs triggers the AppHeader
                        // watcher which resets isAccountAvatarBroken and retries the image load.
                        this.resolveWritableHostIp(user).then(writableIp => {
                            if (!writableIp || this._user?.mid !== user.mid) return
                            const current = this._user?.avatar
                            if (!current) return
                            const fixed = this.normalizeAvatarUrl(current, `http://${writableIp}`)
                            if (fixed !== current) this._mergeUserIntoCachedRefs(user.mid, { avatar: fixed })
                        }).catch(() => {})

                        console.log(`[login] Login flow completed successfully for ${username}`);
                        useAlertStore().success(i18n.global.t("auth.loginSuccessful"))
                        return user
                    } else {
                        // Don't retry on authentication errors with reason (likely invalid credentials)
                        console.error("Login failed:", failureReason)
                        throw new Error(failureReason || "Login failed. Please check your credentials.")
                    }
                } catch (error) {
                    lastError = error
                    // Retry on network errors
                    if (attempt < maxRetries) {
                        console.warn(`Login attempt ${attempt + 1} failed due to network error. Retrying...`, error)
                        await this.delay(1000 * (attempt + 1)) // Exponential backoff: 1s, 2s
                        continue
                    }
                    console.error("Login error:", error)
                    // Re-throw to let UserLogin.vue handle the error display
                    throw error
                }
            }

            // If we exhausted all retries
            if (lastError) {
                console.error("Login failed after all retries:", lastError)
                throw new Error("Login failed after multiple attempts. Please try again later.")
            }
        },

        /**
         * Helper function to add delay between retry attempts
         * @param ms Milliseconds to delay
         */
        delay(ms: number): Promise<void> {
            return new Promise(resolve => setTimeout(resolve, ms))
        },
        /**
         * Logs out the current user and clears session storage
         */
        logout() {
            sessionStorage.clear()
            clearStoredLoginUser()
            this._user = null
            this._followings = []
            this.tweets = []
            this.tweetIndex.clear()
            this.interactionOverrides.clear()
            this.feedTweetIds.clear()
            this.feedPendingCandidateIds.clear()
            this._deletedTweetIds.clear()
            this.originalTweets = []
            this.originalTweetIndex.clear()
            this.users.clear()
            this.lapi.connectionPool?.clearAll()
        },
        /**
         * Gets the list of followers for a specific user
         * @param userId The user ID to get followers for
         * @returns Array of follower user IDs
         */
        async getFollowers(userId: MimeiId) {
            return await this._loadSortedUserList(userId, "get_followers_sorted")
        },
        /**
         * Gets the list of users that a specific user is following
         * @param userId The user ID to get followings for
         * @returns Array of following user IDs
         */
        async getFollowings(userId: MimeiId) {
            return await this._loadSortedUserList(userId, "get_followings_sorted")
        },

        /**
         * Toggles follow/unfollow status for the target user.
         * @param followingId The user to follow or unfollow
         * @returns true if following after toggle, false if unfollowed
         */
        async toggleFollowing(followingId: MimeiId): Promise<boolean> {
            const loginUser = this.loginUser
            if (!loginUser) {
                throw new Error("You must be logged in to toggle following")
            }

            // Route the call directly to loginUser's primary host (hostIds[0])
            // so the backend's `userHostId === nodeId` check fires and the local
            // handler runs. The cross-node delegation path in toggle_following.js
            // drops the response payload (Java-Map-backed bridge object whose
            // keys are not JS-enumerable), turning a clearly successful op into
            // a client-side failure.
            const writableIp = await this.resolveWritableHostIp(loginUser)
            const homeClient = createPooledClient(writableIp, this.lapi.connectionPool)

            // Follow can RPC to the home node and sync many tweets, so use the shared toggle timeout.
            const originalTimeout = homeClient.timeout
            homeClient.timeout = TOGGLE_MUTATION_TIMEOUT_MS
            let ret: unknown
            try {
                const followingUser = this.users.get(followingId)
                    ?? await this.getUser(followingId)
                const followingHostId = followingUser?.hostIds?.[0]
                if (!followingHostId) {
                    throw new Error(`Following user's root host is unavailable: ${followingId}`)
                }
                ret = await homeClient.RunMApp("toggle_following", {
                    aid: this.appId,
                    ver: "last",
                    version: "v2",
                    followingid: followingId,
                    followingid_hostid: followingHostId,
                    userid: loginUser.mid,
                })
            } finally {
                homeClient.timeout = originalTimeout
            }

            const isFollowing = parseToggleFollowedV2Result(ret)

            const hadFollowingsCache = this._followings.length > 0
            const wasFollowing = this._followings.includes(followingId)

            if (hadFollowingsCache) {
                if (isFollowing && !wasFollowing) {
                    this._followings.push(followingId)
                } else if (!isFollowing && wasFollowing) {
                    this._followings = this._followings.filter(id => id !== followingId)
                }
                sessionStorage.setItem("followings", JSON.stringify(this._followings))
            }

            const targetUser = this.users.get(followingId)

            const followDelta = isFollowing ? 1 : -1
            if (this.loginUser) {
                this.loginUser.followingCount = Math.max(0, (this.loginUser.followingCount ?? 0) + followDelta)
                this.users.set(this.loginUser.mid, this.loginUser)
            }
            if (targetUser) {
                targetUser.followersCount = Math.max(0, (targetUser.followersCount ?? 0) + followDelta)
                setStoredUser(followingId, targetUser)
            }

            setStoredLoginUser(this.loginUser)
            return isFollowing
        },

        /**
         * Deletes a tweet from the system
         * @param tweetId The ID of the tweet to delete
         * @param authorId The ID of the tweet author
         */
        async deleteTweet(tweetId: MimeiId, authorId: MimeiId) {
            if (!this.loginUser) {
                throw new Error('Not authorized to delete this tweet')
            }
            if (this.loginUser.username !== 'admin' && this.loginUser.mid !== authorId) {
                throw new Error('Not authorized to delete this tweet')
            }

            console.log('[deleteTweet] Starting delete', {
                tweetId,
                authorId,
                callerId: this.loginUser.mid,
            })

            const tweetIndex = this.tweets.findIndex(e => e.mid === tweetId)
            const removedTweet = tweetIndex >= 0
                ? this.tweets[tweetIndex]
                : this.tweetIndex.get(tweetId)
            const wasFeedTweet = this.feedTweetIds.has(tweetId)
            const wasPendingCandidate = this.feedPendingCandidateIds.has(tweetId)
            this._deletedTweetIds.add(tweetId)
            this.tweetIndex.delete(tweetId)
            this.feedTweetIds.delete(tweetId)
            this.feedPendingCandidateIds.delete(tweetId)
            if (tweetIndex >= 0) {
                this.tweets.splice(tweetIndex, 1)
                console.log('[deleteTweet] Removed tweet from local cache', {
                    tweetId,
                    tweetIndex,
                    cachedTweets: this.tweets.length,
                })
            } else {
                console.log('[deleteTweet] Tweet was not in local cache before server delete', { tweetId })
            }

            try {
                const targetAuthor = authorId === this.loginUser.mid
                    ? this.loginUser
                    : await this.getUser(authorId)
                if (!targetAuthor) {
                    throw new Error('Tweet author not found')
                }
                const hostId = targetAuthor.hostIds?.[0]
                const writableIp = await this.resolveWritableHostIp(targetAuthor)
                const deleteClient = createPooledClient(writableIp, this.lapi.connectionPool)

                const payload: Record<string, any> = {
                    aid: this.appId,
                    ver: "last",
                    version: "v3",
                    appuserid: this.loginUser.mid, // caller identity (admin or owner)
                    userid: authorId, // tweet owner; backend resolves this user's host
                    tweetid: tweetId,
                    authorid: authorId, // tweet owner
                    hostid: hostId,
                }

                console.log('[deleteTweet] Calling delete_tweet', { ...payload, writableIp })
                let response: any = await deleteClient.RunMApp("delete_tweet", payload)
                console.log('[deleteTweet] delete_tweet response', { tweetId, response })
                for (let depth = 0; depth < 3 && response && typeof response === "object"; depth++) {
                    if (response.success === false) {
                        throw new Error(typeof response.message === "string" ? response.message : "Delete tweet failed")
                    }
                    if (response.success === true && "data" in response && response.data !== undefined) {
                        response = response.data
                        continue
                    }
                    break
                }
                const deletedTweetId = response?.tweetid
                if (typeof deletedTweetId !== "string" || !deletedTweetId) {
                    throw new Error("Delete tweet failed: server returned success but no tweetid")
                }
                try {
                    this.evictDeletedTweetFromCaches(tweetId)
                } catch (cacheError) {
                    // The server deletion is already authoritative. Never report
                    // it as failed (or restore the deleted row) because browser
                    // storage cleanup encountered an unrelated quota/access error.
                    console.error('[deleteTweet] Server delete succeeded but full cache eviction failed', {
                        tweetId,
                        cacheError,
                    })
                    this._deletedTweetIds.add(tweetId)
                    this.tweetIndex.delete(tweetId)
                    this.originalTweetIndex.delete(tweetId)
                    try {
                        sessionStorage.removeItem(tweetId)
                        localStorage.removeItem(tweetId)
                    } catch (fallbackError) {
                        console.error('[deleteTweet] Basic persisted-cache cleanup also failed', {
                            tweetId,
                            fallbackError,
                        })
                    }
                }
                console.log('[deleteTweet] Delete completed', { tweetId, deletedTweetId })
                return deletedTweetId
            } catch (error) {
                console.error('[deleteTweet] Delete failed', { tweetId, authorId, error })
                this._deletedTweetIds.delete(tweetId)
                if (removedTweet) {
                    if (tweetIndex >= 0) {
                        const restoreIndex = Math.min(tweetIndex, this.tweets.length)
                        this.tweets.splice(restoreIndex, 0, removedTweet)
                    }
                    this.tweetIndex.set(tweetId, removedTweet)
                }
                if (wasFeedTweet) this.feedTweetIds.add(tweetId)
                if (wasPendingCandidate) this.feedPendingCandidateIds.add(tweetId)
                throw error
            }
        },

        /**
         * Purges a successfully deleted tweet from every Web cache. Quotes keep
         * their own content but lose the embedded deleted object; pure retweets
         * are removed because they have no independently renderable body.
         */
        evictDeletedTweetFromCaches(tweetId: MimeiId) {
            this._deletedTweetIds.add(tweetId)

            const removedIds = new Set<MimeiId>([tweetId])
            const collectRemoved = (ids: Set<MimeiId>) => {
                for (const id of ids) removedIds.add(id)
            }

            const main = withoutDeletedTweet(this.tweets, tweetId)
            this.tweets = main.tweets
            collectRemoved(main.removedIds)

            for (const id of removedIds) {
                this.tweetIndex.delete(id)
                this.feedTweetIds.delete(id)
                this.feedPendingCandidateIds.delete(id)
                this.interactionOverrides.delete(id)
                this.optimisticSavedListStates.delete(id)
            }
            for (const tweet of this.tweets) this.tweetIndex.set(tweet.mid, tweet)

            const originals = withoutDeletedTweet(this.originalTweets, tweetId)
            this.originalTweets = originals.tweets
            collectRemoved(originals.removedIds)
            this.originalTweetIndex.clear()
            for (const tweet of this.originalTweets) {
                this.originalTweetIndex.set(tweet.mid, tweet)
            }

            for (const [key, tweets] of Object.entries(this.savedListTweets)) {
                const sanitized = withoutDeletedTweet(tweets, tweetId)
                this.savedListTweets[key] = sanitized.tweets
                collectRemoved(sanitized.removedIds)
                setLocalCache(key, sanitized.tweets.map(tweetForSessionStorage))
            }

            // Rewrite every persisted tweet-list cache, including profiles that
            // are not currently loaded in memory.
            const listPrefixes = ['feed_tweets_', 'tweets_', 'pinned_', 'saved_tweets_']
            const localKeys = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index))
                .filter((key): key is string => !!key && listPrefixes.some(prefix => key.startsWith(prefix)))
            for (const key of localKeys) {
                const cached = getLocalCache<Tweet[]>(key)
                if (!cached) continue
                const sanitized = withoutDeletedTweet(cached, tweetId)
                collectRemoved(sanitized.removedIds)
                setLocalCache(key, sanitized.tweets.map(tweetForSessionStorage))
            }

            // Interaction updates can also leave a plain tweet snapshot under
            // its MID in localStorage. Sanitize those separately from expiring
            // list caches so a deleted tweet cannot be restored from either form.
            const localSnapshotKeys = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index))
                .filter((key): key is string => !!key)
            for (const key of localSnapshotKeys) {
                const raw = localStorage.getItem(key)
                if (!raw) continue
                try {
                    const cached = JSON.parse(raw)
                    if (!cached || cached.mid !== key) continue
                    const sanitized = withoutDeletedTweet([cached as Tweet], tweetId)
                    collectRemoved(sanitized.removedIds)
                    if (sanitized.tweets.length === 0) localStorage.removeItem(key)
                    else localStorage.setItem(key, JSON.stringify(tweetForSessionStorage(sanitized.tweets[0])))
                } catch {
                    // Not a JSON tweet snapshot.
                }
            }

            // Individual tweet snapshots use their MID as the session key.
            const sessionKeys = Array.from({ length: sessionStorage.length }, (_, index) => sessionStorage.key(index))
                .filter((key): key is string => !!key)
            for (const key of sessionKeys) {
                const raw = sessionStorage.getItem(key)
                if (!raw) continue
                try {
                    const cached = JSON.parse(raw)
                    if (!cached || cached.mid !== key) continue
                    const sanitized = withoutDeletedTweet([cached as Tweet], tweetId)
                    collectRemoved(sanitized.removedIds)
                    if (sanitized.tweets.length === 0) sessionStorage.removeItem(key)
                    else sessionStorage.setItem(key, JSON.stringify(tweetForSessionStorage(sanitized.tweets[0])))
                } catch {
                    // Not a JSON tweet snapshot.
                }
            }

            for (const id of removedIds) {
                this.tweetIndex.delete(id)
                this.originalTweetIndex.delete(id)
                this.feedTweetIds.delete(id)
                this.feedPendingCandidateIds.delete(id)
                this.interactionOverrides.delete(id)
                this.optimisticSavedListStates.delete(id)
                sessionStorage.removeItem(id)
                localStorage.removeItem(id)
            }

            // Keep the current user's saved-list metadata consistent with the
            // cached lists. This also covers unusable pure-retweet wrappers that
            // were discovered while scanning persisted caches above.
            const loginUser = this.loginUser
            if (loginUser) {
                const favoriteIds = loginUser.favoriteTweets ?? []
                const bookmarkedIds = loginUser.bookmarkedTweets ?? []
                const removedFavoriteCount = favoriteIds.filter(id => removedIds.has(id)).length
                const removedBookmarkCount = bookmarkedIds.filter(id => removedIds.has(id)).length
                loginUser.favoriteTweets = favoriteIds.filter(id => !removedIds.has(id))
                loginUser.bookmarkedTweets = bookmarkedIds.filter(id => !removedIds.has(id))
                if (removedFavoriteCount > 0) {
                    loginUser.favoritesCount = Math.max(0, (loginUser.favoritesCount ?? 0) - removedFavoriteCount)
                }
                if (removedBookmarkCount > 0) {
                    loginUser.bookmarksCount = Math.max(0, (loginUser.bookmarksCount ?? 0) - removedBookmarkCount)
                }
                setStoredLoginUser(loginUser)
            }

            const purgeSessionObject = (key: string) => {
                const raw = sessionStorage.getItem(key)
                if (!raw) return
                try {
                    const cached = JSON.parse(raw)
                    const tweet = key === 'mediaViewerData' ? cached?.tweet : cached
                    if (!tweet?.mid) return
                    const sanitized = withoutDeletedTweet([tweet as Tweet], tweetId)
                    if (sanitized.tweets.length === 0) {
                        sessionStorage.removeItem(key)
                    } else if (key === 'mediaViewerData') {
                        sessionStorage.setItem(key, JSON.stringify({ ...cached, tweet: sanitized.tweets[0] }))
                    } else {
                        sessionStorage.setItem(key, JSON.stringify(sanitized.tweets[0]))
                    }
                } catch {
                    sessionStorage.removeItem(key)
                }
            }
            purgeSessionObject('tweetDetail')
            purgeSessionObject('mediaViewerData')
        },

        /**
         * Deletes a comment from a tweet
         * Can be called by either the comment author or the parent tweet author
         * Uses the parent tweet author's client since comments are stored on the same node as the tweet
         * @param commentId The ID of the comment to delete
         * @param commentAuthorId The ID of the comment author
         * @param parentTweetId The ID of the parent tweet
         * @param parentAuthorId The ID of the parent tweet author
         */
        async deleteComment(commentId: MimeiId, commentAuthorId: MimeiId, parentTweetId: MimeiId, parentAuthorId: MimeiId) {
            // Verify authorization: can be called by comment author or parent tweet author
            if (!this.loginUser || (this.loginUser.username !== 'admin' && this.loginUser.mid !== commentAuthorId && this.loginUser.mid !== parentAuthorId)) {
                throw new Error("Not authorized to delete this comment")
            }

            // Get parent tweet author (comments are stored on the same node as the tweet).
            // Use loginUser directly when they are the parent tweet author, same as deleteTweet,
            // instead of re-fetching via getUser which races provider IPs and can spuriously
            // report "User not found" / enter cooldown for the caller's own account.
            const parentAuthor = parentAuthorId === this.loginUser.mid
                ? this.loginUser
                : await this.getUser(parentAuthorId)
            if (!parentAuthor) {
                throw new Error("Failed to get parent tweet author for deleting comment")
            }

            if (!parentAuthor.hostIds || !parentAuthor.hostIds[0]) {
                throw new Error("Parent tweet author's hostIds[0] is missing")
            }

            // Resolve a fresh writable IP rather than reusing parentAuthor.client, which may
            // be pinned to a stale/unhealthy IP from a previous race.
            const writableIp = await this.resolveWritableHostIp(parentAuthor)
            const deleteClient = createPooledClient(writableIp, this.lapi.connectionPool)

            // Call delete_comment API with proper parameters matching server expectations
            await deleteClient.RunMApp("delete_comment", {
                aid: this.appId,
                ver: "last",
                appuserid: this.loginUser.mid,  // User requesting deletion (comment author or parent tweet author)
                tweetid: parentTweetId,         // ID of tweet containing the comment
                commentid: commentId,            // ID of comment to delete
                hostid: parentAuthor.hostIds[0]      // Node ID where the tweet is hosted
            })

            // After successful deletion, remove comment from local cache
            // Helper function to remove comment from a tweet object
            const removeCommentFromTweet = (tweet: Tweet) => {
                if (tweet && tweet.comments) {
                    const commentIndex = tweet.comments.findIndex(c => c.mid === commentId)
                    if (commentIndex !== -1) {
                        // Use Vue reactivity - replace array to trigger update
                        tweet.comments = tweet.comments.filter(c => c.mid !== commentId)
                        // Update comment count if it exists
                        if (tweet.commentCount !== undefined) {
                            tweet.commentCount = Math.max(0, (tweet.commentCount || 0) - 1)
                        }
                        return true
                    }
                }
                return false
            }

            // Remove from tweets array
            const parentTweet = this.tweetIndex.get(parentTweetId)
            if (parentTweet) {
                removeCommentFromTweet(parentTweet)
            }

            // Also check originalTweets array in case it's displayed as a retweet
            const originalTweet = this.originalTweetIndex.get(parentTweetId)
            if (originalTweet) {
                removeCommentFromTweet(originalTweet)
            }
        },
        
        /**
         * Open a temp file on target host
         * @returns file's sid
         */
        async openTempFile() {
            const loginUser = this.loginUser
            if (!loginUser) throw new Error('Not logged in')
            const writableIp = await this.resolveWritableHostIp(loginUser)
            const client = createPooledClient(writableIp, this.lapi.connectionPool)
            const fsid = await client.RunMApp("open_temp_file", {
                aid: this.appId, ver: "last"
            })
            console.log("Open temp file", fsid, loginUser)
            return fsid
        },

        /**
         * Uploads a tweet or comment to the system
         * @param tweet a Tweet object to be uploaded
         * @param tweetId if none, a new tweet is created, otherwise a comment added to the tweetId
         * @returns a mid of the uploaded object
         */
        async uploadTweet(tweet: any, tweetId?: MimeiId) {
            if (!this.loginUser) throw new Error('Not logged in')

            // Leither may be busy after video processing; allow 5 minutes per write.
            const effectiveTimeout = 5 * 60 * 1000

            let ret: any
            try {
                const timeoutPromise = new Promise((_, reject) => {
                    setTimeout(() => reject(new Error(
                        `Tweet upload timeout after ${effectiveTimeout / 60000} minutes. This may be due to extensive video processing on the backend.`
                    )), effectiveTimeout)
                })

                const uploadPromise = (async () => {
                    if (tweetId) {
                        const parentTweet = await this.getTweet(tweetId)
                        if (!parentTweet) throw new Error('Parent tweet not found')
                        const parentAuthor = parentTweet.author ?? await this.getUser(parentTweet.authorId)
                        if (!parentAuthor) throw new Error('Parent tweet author not found')
                        const parentAuthorHostId = parentAuthor.hostIds?.[0]
                        if (!parentAuthorHostId) {
                            throw new Error('Parent tweet author has no hostIds[0]')
                        }
                        const parentWritableIp = await this.resolveWritableHostIp(parentAuthor)
                        const parentClient = createPooledClient(parentWritableIp, this.lapi.connectionPool)
                        tweet.parentTweetId = tweetId
                        const parentOriginalTimeout = parentClient.timeout
                        parentClient.timeout = effectiveTimeout
                        try {
                            return await parentClient.RunMApp('add_comment', {
                                aid: this.appId, ver: 'last', version: 'v2',
                                tweetid: tweetId,
                                comment: JSON.stringify(tweet),
                                tweetauthorid: parentAuthor.mid,
                                hostid: parentAuthorHostId,
                            })
                        } finally {
                            parentClient.timeout = parentOriginalTimeout
                        }
                    }
                    const loginUser = this.loginUser!
                    const writableIp = await this.resolveWritableHostIp(loginUser)
                    const writeClient = createPooledClient(writableIp, this.lapi.connectionPool)
                    const writeOriginalTimeout = writeClient.timeout
                    writeClient.timeout = effectiveTimeout
                    try {
                        return await writeClient.RunMApp('add_tweet', {
                            aid: this.appId, ver: 'last',
                            tweet: JSON.stringify(tweet),
                            hostid: loginUser.hostIds?.[0],
                        })
                    } finally {
                        writeClient.timeout = writeOriginalTimeout
                    }
                })()

                ret = await Promise.race([uploadPromise, timeoutPromise])
            } catch (error) {
                console.error(`Upload ${tweetId ? 'comment' : 'tweet'} failed:`, error)
                throw error
            }
                
            // Check if the backend returned null, indicating failure
            if (ret === null || ret === undefined || !ret.success) {
                const errorMessage = ret?.message || 'Unknown error occurred during tweet upload'
                throw new Error(errorMessage);
            }
            if (!tweetId && this.loginUser) {
                this.loginUser.tweetCount = (this.loginUser.tweetCount ?? 0) + 1
                this.users.set(this.loginUser.mid, this.loginUser)
                setStoredUser(this.loginUser.mid, this.loginUser)
                setStoredLoginUser(this.loginUser)
            }
            return ret.mid
        },
        /**
         * Resolves the user whose root node physically stores a tweet object.
         * Top-level tweets live with their author; comments and replies live
         * with their immediate parent's author. Never substitute another user
         * merely because that user's node happens to contain a readable copy.
         */
        async resolveTweetStorageAuthor(tweet: Tweet): Promise<User> {
            if (tweet.interactionHostAuthor) return tweet.interactionHostAuthor

            if (tweet.parentTweetId) {
                if (tweet.parentTweetId === tweet.mid) {
                    throw new Error(`Invalid parent reference for tweet ${tweet.mid}`)
                }
                const parent = this.tweetIndex.get(tweet.parentTweetId)
                    ?? this.originalTweetIndex.get(tweet.parentTweetId)
                    ?? await this.fetchTweet(tweet.parentTweetId, undefined)
                if (!parent) {
                    throw new Error(`Parent tweet unavailable for mutation: ${tweet.parentTweetId}`)
                }
                const parentAuthor = parent.author
                    ?? this.users.get(parent.authorId)
                    ?? await this.getUser(parent.authorId)
                if (!parentAuthor) {
                    throw new Error(`Parent author unavailable for mutation: ${parent.authorId}`)
                }
                tweet.interactionHostAuthor = parentAuthor
                return parentAuthor
            }

            const author = tweet.author
                ?? this.users.get(tweet.authorId)
                ?? await this.getUser(tweet.authorId)
            if (!author) {
                throw new Error(`Tweet author unavailable for mutation: ${tweet.authorId}`)
            }
            return author
        },
        /**
         * Registers a retweet/quote on the original object's storage root.
         * Mirrors iOS updateRetweetCount and returns the updated original tweet
         * when the server supplies it.
         */
        async updateRetweetCount(originalTweet: Tweet, retweetId: MimeiId): Promise<Tweet | null> {
            try {
                const loginUser = this.loginUser
                if (!loginUser) {
                    console.warn('[updateRetweetCount] No logged-in user')
                    return null
                }
                const storageAuthor = await this.resolveTweetStorageAuthor(originalTweet)
                const writableIp = await this.resolveWritableHostIp(storageAuthor)
                const client = createPooledClient(writableIp, this.lapi.connectionPool)
                client.timeout = TOGGLE_MUTATION_TIMEOUT_MS
                const ret = await client.RunMApp("retweet_added", {
                    aid: this.appId,
                    ver: "last",
                    version: "v2",
                    appuserid: loginUser.mid,
                    retweetid: retweetId,
                    tweetid: originalTweet.mid,
                    authorid: storageAuthor.mid,
                })
                const tweetDict = unwrapNestedV2Map(ret)
                if (!tweetDict) {
                    console.warn('[updateRetweetCount] Server returned invalid tweet data')
                    return null
                }
                // Use server count if available, otherwise keep optimistic +1 (upload already succeeded)
                const newCount = tweetDict?.retweetCount ?? (originalTweet.retweetCount ?? 0) + 1
                const serverFavorites = Array.isArray(tweetDict.favorites)
                    ? tweetDict.favorites
                    : originalTweet.favorites
                const updated = {
                    ...originalTweet,
                    retweetCount: newCount,
                    favorites: serverFavorites,
                }

                // The same original can be held as a top-level tweet, an embedded
                // retweet original, or the action bar's current detail object.
                // Keep every cached reference aligned with the authoritative count.
                const cachedTweets = new Set<Tweet>([
                    originalTweet,
                    this.tweetIndex.get(originalTweet.mid),
                    this.originalTweetIndex.get(originalTweet.mid),
                    ...this.tweets
                        .filter(tweet => tweet.originalTweet?.mid === originalTweet.mid)
                        .map(tweet => tweet.originalTweet),
                ].filter((tweet): tweet is Tweet => !!tweet))
                for (const cachedTweet of cachedTweets) {
                    cachedTweet.retweetCount = newCount
                    if (serverFavorites) cachedTweet.favorites = [...serverFavorites]
                }
                try {
                    sessionStorage.setItem(originalTweet.mid, JSON.stringify(tweetForSessionStorage(updated)))
                } catch (error) {
                    console.warn('[updateRetweetCount] Failed to cache updated original tweet:', error)
                }
                return updated
            } catch (error) {
                console.warn('[updateRetweetCount] Failed to update retweet count:', error)
                return null
            }
        },
        /**
         * Updates an existing tweet's content and, when supplied, its complete
         * attachment list. Omitting attachments preserves the server-side list
         * for legacy content-only admin edits.
         */
        async updateTweet(
            tweetId: MimeiId,
            content: string,
            authorId?: MimeiId,
            attachments?: MimeiFileType[],
            options?: { downloadable?: boolean; isPrivate?: boolean },
        ) {
            if (!this.loginUser) {
                throw new Error('Not authorized to edit this tweet')
            }
            try {
                const targetAuthorId = authorId ?? this.loginUser.mid
                console.log('[updateTweet] Starting update', {
                    tweetId,
                    targetAuthorId,
                    callerId: this.loginUser.mid,
                    contentLength: content.length,
                })
                const targetAuthor = targetAuthorId === this.loginUser.mid
                    ? this.loginUser
                    : await this.getUser(targetAuthorId)
                if (targetAuthorId !== this.loginUser.mid) {
                    console.log('[updateTweet] Resolved target author', {
                        tweetId,
                        targetAuthorId,
                        hasAuthor: !!targetAuthor,
                        providerIp: targetAuthor?.providerIp,
                    })
                }
                if (!targetAuthor) {
                    throw new Error(`Could not resolve tweet author ${targetAuthorId}`)
                }

                // update_tweet enforces author identity in appuserid, so for admin edits
                // we must act on the tweet owner's node and pass owner id as appuserid.
                const writableIp = await this.resolveWritableHostIp(targetAuthor)
                const client = createPooledClient(writableIp, this.lapi.connectionPool)
                client.timeout = UPDATE_TWEET_TIMEOUT_MS
                const attachmentReferences = attachments?.map(attachment => {
                    const mid = String(attachment.mid || '').trim()
                    const separator = mid.lastIndexOf('/')
                    return {
                        ...attachment,
                        mid: separator >= 0 ? mid.substring(separator + 1) : mid,
                    }
                })
                const request: Record<string, unknown> = {
                    aid: this.appId,
                    ver: "last",
                    appuserid: targetAuthorId,
                    userid: targetAuthorId,
                    hostid: targetAuthor.hostIds?.[0],
                    tweetid: tweetId,
                    content: content,
                }
                if (attachmentReferences !== undefined) {
                    request.attachments = JSON.stringify(attachmentReferences)
                }
                if (options?.downloadable !== undefined) {
                    request.downloadable = options.downloadable
                }
                if (options?.isPrivate !== undefined) {
                    request.isPrivate = options.isPrivate
                }
                const ret = await client.RunMApp("update_tweet", request)
                console.log('[updateTweet] update_tweet response', { tweetId, ret })
                if (!ret || !ret.success) {
                    throw new Error(ret?.message || 'Failed to update tweet')
                }
                // Update local tweet in store
                const idx = this.tweets.findIndex(t => t.mid === tweetId)
                if (idx !== -1) {
                    this.tweets[idx].content = content
                    if (attachmentReferences !== undefined) {
                        this.tweets[idx].attachments = attachmentReferences.map(attachment => ({
                            ...attachment,
                            mid: this.getMediaUrl(attachment.mid, `http://${writableIp}`),
                            downloadable: options?.downloadable ?? attachment.downloadable,
                        }))
                    }
                    if (options?.downloadable !== undefined) {
                        this.tweets[idx].downloadable = options.downloadable
                    }
                    if (options?.isPrivate !== undefined) {
                        this.tweets[idx].isPrivate = options.isPrivate
                    }
                    console.log('[updateTweet] Updated local tweet cache', { tweetId, tweetIndex: idx })
                } else {
                    console.log('[updateTweet] Tweet was not in local cache after server update', { tweetId })
                }
                console.log('[updateTweet] Update completed', { tweetId, returnedMid: ret.mid })
                return ret.mid
            } catch (error) {
                console.error('[updateTweet] Update failed', { tweetId, authorId, error })
                throw error
            }
        },
        /**
         * Upload App upgrade package file.
         * @param cid IPFS id of the install package
         * @param mini If true, upload as mini package
         * @returns MimeiId of the install package
         */
        async uploadPackage(cid: string, mini: boolean = false) {
            const loginUser = this.loginUser
            if (!loginUser) throw new Error('Not logged in')
            const writableIp = await this.resolveWritableHostIp(loginUser)
            const client = createPooledClient(writableIp, this.lapi.connectionPool)
            const originalTimeout = client.timeout
            try {
                // Use longer timeout for package upload (10 minutes)
                client.timeout = 10 * 60 * 1000
                
                const params: any = {
                    aid: this.lapi.appId, ver: "last", cid: cid
                }
                if (mini) {
                    params.mini = "mini"
                }
                const mid = await client.RunMApp("upload_package", params)
                return mid
            } finally {
                // Restore original timeout
                client.timeout = originalTimeout
            }
        },
        /**
         * Upload a file to mm database, and add referrence to userId.
         * @param filename 
         * @returns mid of uploaded file
         */
        async uploadFile(cid: string, filename: string) {
            const loginUser = this.loginUser
            if (!loginUser) throw new Error('Not logged in')
            const writableIp = await this.resolveWritableHostIp(loginUser)
            const client = createPooledClient(writableIp, this.lapi.connectionPool)
            const originalTimeout = client.timeout
            try {
                // Use longer timeout for file upload (10 minutes)
                client.timeout = 10 * 60 * 1000
                
                const mid = await client.RunMApp("upload_file", {
                    aid: this.lapi.appId,
                    ver: "last", 
                    cid: cid,
                    userid: loginUser.mid,
                })
                return mid
            } finally {
                // Restore original timeout
                client.timeout = originalTimeout
            }
        },
        /**
         * Shares a file with other users
         * @param file The file to share
         * @returns The Mimei ID of the shared file
         */
        async shareFile(file: FileSystemItem) {
            const loginUser = this.loginUser
            if (!loginUser) throw new Error('Not logged in')
            const writableIp = await this.resolveWritableHostIp(loginUser)
            const client = createPooledClient(writableIp, this.lapi.connectionPool)
            const mid = await client.RunMApp("share_file", {
                aid: this.lapi.appId,
                ver: "last",
                file: JSON.stringify(file),
                userid: loginUser.mid,
            })
            return mid
        },
        /**
         * Retrieves a shared file by its Mimei ID
         * @param mid A mimei id
         * @returns the IP of a node that provides the mimei. IP only, no port number.
         * There should be one node only for sharing a file on hard drive by its mimei label.
         */
        async getSharedFile(mid: MimeiId) {
            // get file object and base url of the mid
            let ip = await this.lapi.client.RunMApp("get_shared_file_ip", {
                aid: this.lapi.appId,
                ver: "last",
                mid: mid
            })
            let ip0 = this.getIpWithoutPort(ip)
            if (!ip0) {
                console.error("Invalid IP", ip)
                return
            }

            const hproseClient = createPooledClient(ip, this.lapi.connectionPool)
            let file = await hproseClient.RunMApp("get_shared_file", {
                aid: this.lapi.appId,
                ver: "last",
                mid: mid
            })

            const sharingUser = await this.getUser(file.userId)
            // Cloud port is the file server port on the same node.
            file.url = `http://${ip0}:${sharingUser?.cloudDrivePort}`   // base url for the file
            return file
        },
        /**
         * Toggles the like status of a tweet
         * @param tweet The tweet to update
         * @param isFavorite The desired favorite state
         * @returns The updated tweet object
         */
        async toggleFavorite(tweet: Tweet, isFavorite: boolean) {
            const loginUser = this.loginUser
            if (!loginUser) throw new Error('Not logged in')
            const userHostId = loginUser.hostIds?.[0]
            if (!userHostId) throw new Error('Writable host not configured')
            const storageAuthor = await this.resolveTweetStorageAuthor(tweet)
            const params = {
                aid: this.appId, ver: "last", version: "v2",
                appuserid: loginUser.mid,
                tweetid: tweet.mid,
                authorid: storageAuthor.mid,
                userhostid: userHostId,
                isfavorite: isFavorite,
            }
            const writableIp = await this.resolveWritableHostIp(storageAuthor)
            const client = createPooledClient(writableIp, this.lapi.connectionPool)
            client.timeout = TOGGLE_MUTATION_TIMEOUT_MS
            const ret = await client.RunMApp("toggle_favorite", params)
            return this._applyServerTweet(tweet, ret)
        },
        /**
         * Toggles the bookmark status of a tweet
         * @param tweet The tweet to toggle bookmark for
         * @param isBookmarked The desired bookmark state
         * @returns The updated tweet object
         */
        async toggleBookmark(tweet: Tweet, isBookmarked: boolean) {
            const loginUser = this.loginUser
            if (!loginUser) throw new Error('Not logged in')
            const userHostId = loginUser.hostIds?.[0]
            if (!userHostId) throw new Error('Writable host not configured')
            const storageAuthor = await this.resolveTweetStorageAuthor(tweet)
            const params = {
                aid: this.appId, ver: "last", version: "v2",
                userid: loginUser.mid,
                tweetid: tweet.mid,
                authorid: storageAuthor.mid,
                userhostid: userHostId,
                isbookmarked: isBookmarked,
            }
            const writableIp = await this.resolveWritableHostIp(storageAuthor)
            const client = createPooledClient(writableIp, this.lapi.connectionPool)
            client.timeout = TOGGLE_MUTATION_TIMEOUT_MS
            const ret = await client.RunMApp("toggle_bookmark", params)
            return this._applyServerTweet(tweet, ret)
        },
        _applyServerTweet(tweet: Tweet, ret: any): Tweet {
            // Unwrap v2 response: if ret has data field, use it
            const response = (ret?.success && ret.data) ? ret.data : ret
            if (response?.success && response.tweet) {
                const s = response.tweet
                const updated = { ...tweet,
                    likeCount: s.favoriteCount ?? tweet.likeCount,
                    bookmarkCount: s.bookmarkCount ?? tweet.bookmarkCount,
                    commentCount: s.commentCount ?? tweet.commentCount,
                    retweetCount: s.retweetCount ?? tweet.retweetCount,
                    // [favorite, bookmark, retweeted] per appUser.
                    favorites: Array.isArray(s.favorites) ? s.favorites : tweet.favorites,
                    favoriteOverride: Array.isArray(s.favorites) ? Boolean(s.favorites[0]) : tweet.favoriteOverride,
                    bookmarkOverride: Array.isArray(s.favorites) ? Boolean(s.favorites[1]) : tweet.bookmarkOverride,
                }
                this.interactionOverrides.set(tweet.mid, {
                    favorite: updated.favoriteOverride,
                    bookmark: updated.bookmarkOverride,
                })
                const idx = this.tweets.findIndex(e => e.mid == tweet.mid)
                if (idx >= 0) {
                    Object.assign(this.tweets[idx], updated)
                }
                localStorage.setItem(tweet.mid, JSON.stringify(tweetForSessionStorage(updated)))

                // Update login user from server response (like Android's appUser.from)
                if (response.user && this.loginUser) {
                    Object.assign(this.loginUser, response.user)
                    setStoredLoginUser(this.loginUser)
                }

                return updated
            }
            throw new Error('Saved tweet mutation returned invalid data')
        },

        /**
         * Download file and return the data blob to web client.
         * @param url The URL of the file to download
         */
        async downloadBlob(url: string) {
            console.log("Download", url)
            
            // Check if it's a mobile device
            const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
            
            // If URL already ends with .apk, use direct download for both mobile and desktop
            if (url.toLowerCase().endsWith('.apk')) {
                const link = document.createElement('a');
                link.href = url;
                link.download = 'tweet_install.apk';
                document.body.appendChild(link);
                link.click();
                document.body.removeChild(link);
                return Promise.resolve();
            }
            
            // For URLs that don't end with .apk (like zip files), fetch and rename
            try {
                const response = await fetch(url);
                if (!response.ok) {
                    throw new Error('Network response was not ok');
                }
                
                const blob = await response.blob();
                
                // Create a new blob with APK MIME type
                const apkBlob = new Blob([blob], { 
                    type: 'application/vnd.android.package-archive' 
                });
                
                // Create download link
                const link = document.createElement('a');
                link.href = window.URL.createObjectURL(apkBlob);
                link.download = 'tweet_install.apk';
                document.body.appendChild(link);
                link.click();
                document.body.removeChild(link);
                
                // Clean up
                window.URL.revokeObjectURL(link.href);
            } catch (error) {
                console.error('Download failed:', error);
                // Fallback: try opening in new window
                window.open(url, '_blank');
            }
        },

        /**
         * Checks if an IP address is a local network address
         * @param ip is full IP address with port
         * @returns true if the ip is of local network.
         */
        isLocalIP(ip: string) {
            const localPatterns = [
                /^127\./, // Loopback
                /^10\./, // Class A private
                /^192\.168\./, // Class C private
                /^172\.(1[6-9]|2[0-9]|3[0-1])\./, // Class B private
            ];

            // IPv6 local patterns
            const localIPv6Patterns = [
                /^::1$/, // IPv6 loopback
                /^fe80:/, // IPv6 link-local
                /^fc00:/, // IPv6 unique local
                /^fd00:/, // IPv6 unique local
            ];

            // Check for IPv4 patterns
            if (localPatterns.some(pattern => pattern.test(ip))) {
                return true;
            }

            // Check for IPv6 patterns (remove port first if present)
            const ipWithoutPort = ip.replace(/:\d+$/, '');
            if (localIPv6Patterns.some(pattern => pattern.test(ipWithoutPort))) {
                return true;
            }

            return false;
        },

        /**
         * Checks if a string is empty or null
         * @param str The string to check
         * @returns True if the string is empty, null, or undefined
         */
        isEmptyString(str?: String) {
            return str == null || str == undefined || str.trim() == '';
        },

        /**
         * Finds the first accessible IP address from a list of IPs
         * @param ipList Array of IP addresses to test
         * @param mid The Mimei ID to test against
         * @param filterIPv6 Whether to filter out IPv6 addresses
         * @returns The first accessible IP address or null if none found
         */
        async findFirstAccessibleIP(
            ipList: string[], 
            mid: string, 
            filterIPv6 = true,     // filter IPv6 address.
        ): Promise<string | null> {
            if (!ipList?.length) {
                console.error('No IP addresses provided in findFirstAccessibleIP.');
                return null;
            }
            
            // Filter IPs if needed
            let processedIpList = [...ipList];
            if (filterIPv6) {
                // IPv6 addresses have multiple colons
                processedIpList = ipList.filter(ip => (ip.match(/:/g) || []).length <= 1);
                
                if (!processedIpList.length) {
                    console.log('No IPv4 addresses found in the list');
                    return null;
                }
            }
            
            const fetchWithTimeout = (url: string, timeout = 15000): Promise<any> => {
                return new Promise((resolve, reject) => {
                    const controller = new AbortController();
                    const timer = setTimeout(() => {
                        controller.abort();
                        reject(new Error('Request timed out'));
                    }, timeout);
                    
                    fetch(url, { signal: controller.signal })
                        .then(response => {
                            if (!response.ok) throw new Error('Network response was not OK');
                            return response.json();
                        })
                        .then(data => {
                            clearTimeout(timer);
                            resolve(data);
                        })
                        .catch(error => {
                            clearTimeout(timer);
                            reject(error);
                        });
                });
            };
            
            return new Promise<string | null>((resolve) => {
                let resolved = false;
                let pendingRequests = 0;
                
                // Function to check if we should resolve with null
                const checkComplete = () => {
                    if (!resolved && pendingRequests === 0) {
                        resolved = true;
                        resolve(null);
                    }
                };
                
                // Process each IP
                processedIpList.forEach(ip => {
                    if (this.isEmptyString(ip) || this.isLocalIP(ip)) {
                        return;
                    }
                    
                    pendingRequests++;
                    const url = `http://${ip}/getvar?name=mmversions&arg0=${mid}`;
                    
                    fetchWithTimeout(url)
                        .then(() => {
                            if (!resolved) {
                                resolved = true;
                                resolve(ip);
                            }
                        })
                        .catch(error => {
                            console.log(`Error fetching from ${ip}:`, error.message);
                        })
                        .finally(() => {
                            pendingRequests--;
                            checkComplete();
                        });
                });
                
                // Set a timeout as a fallback
                setTimeout(() => {
                    if (!resolved) {
                        resolved = true;
                        resolve(null);
                    }
                }, 15000);
                
                // Handle the case where all IPs were filtered out
                if (pendingRequests === 0) {
                    checkComplete();
                }
            });
        },
        
        /**
         * Finds the first accessible IPv4 address from a list
         * @param ipList Array of IP addresses to test
         * @param mid The Mimei ID to test against
         * @returns The first accessible IPv4 address or null if none found
         */
        async findFirstAccessibleIPv4(ipList: string[], mid: string): Promise<string | null> {
            return await this.findFirstAccessibleIP(ipList, mid, true);
        },

        /**
         * Resolves a user's hostIds[0] to an IP via get_node_ips (v2).
         * Returns the first non-local, non-IPv6 (when v4Only is on)
         * address, or null if none are usable.
         */
        async getNodeIp(user: User, refresh: boolean = false): Promise<string | null> {
            const hostId = user.hostIds?.[0];
            if (!hostId) {
                console.error("[getNodeIp] User has no hostIds[0]");
                return null;
            }
            return await this.getNodeIpByHostId(hostId, refresh)
        },

        /**
         * Resolves the writable host IP for a user by resolving hostIds[0] to an IP,
         * matching iOS User.resolveWritableUrl(). File uploads must use this host
         * rather than the user's cached providerIp (which may point to a read-only node).
         * Result is cached on user.writableHostIp.
         */
        async resolveWritableHostIp(user: User, refresh: boolean = false): Promise<string> {
            const hostId = user.hostIds?.[0]
            const TTL = 5 * 60 * 1000 // 5 minutes

            if (!hostId) {
                throw new Error('Writable host not configured: user has no hostIds[0]')
            }

            if (!refresh) {
                const cached = this._writableHostCache.get(hostId)
                if (cached && Date.now() < cached.expiresAt) {
                    user.writableHostIp = cached.ip
                    return cached.ip
                }
            }

            // A provider-discovery result may have polluted older persisted
            // NodePool entries. The first write-route lookup in this store
            // session must therefore resolve hostIds[0] from get_node_ips;
            // only the dedicated in-memory writable cache is trusted afterward.
            const ip = await this.getNodeIp(user, true)
            if (!ip) {
                throw new Error(`Upload server not responding: could not resolve hostIds[0]=${hostId}`)
            }

            this._writableHostCache.set(hostId, { ip, expiresAt: Date.now() + TTL })
            user.writableHostIp = ip
            return ip
        },

        /**
         * Uploads binary data via chunked upload_ipfs to the user's writable host.
         * Matches iOS MediaProcessor.uploadRegularFile: chunked PUT loop followed
         * by a separate finalization call. Returns the resulting CID.
         */
        async uploadBlobToIpfs(
            user: User,
            data: ArrayBuffer | Uint8Array,
            onProgress?: (percent: number) => void,
        ): Promise<string> {
            const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
            const chunkSize = 2 * 1024 * 1024 // 2MB chunks
            const uploadTimeout = 10 * 60 * 1000 // 10 min for large files

            const parseFsid = (response: any): string => {
                if (typeof response === 'string') return response
                if (response && typeof response === 'object') {
                    if (response.success === false) {
                        throw new Error(response.message || 'Upload failed')
                    }
                    if (response.success === true && response.data) return response.data
                }
                throw new Error(`Unexpected upload_ipfs response: ${JSON.stringify(response)}`)
            }

            // Matches iOS uploadRegularFile: 2 attempts; on first failure clear cached
            // writableHostIp so resolveWritableHostIp re-resolves a fresh healthy IP.
            const maxAttempts = 2
            let lastError: any
            for (let attempt = 1; attempt <= maxAttempts; attempt++) {
                // The retry must bypass both the failed writableUrl hint and
                // cached host so it can discover a different healthy root route.
                const uploadIp = await this.resolveWritableHostIp(user, attempt > 1)
                console.log(`[uploadBlobToIpfs] Attempt ${attempt}/${maxAttempts} using IP:`, uploadIp)
                const client = await this.lapi.connectionPool.getConnection(uploadIp)
                const originalTimeout = client.timeout
                client.timeout = uploadTimeout
                try {
                    let offset = 0
                    let fsid: string | null = null
                    while (offset < bytes.length) {
                        const end = Math.min(offset + chunkSize, bytes.length)
                        const chunk = bytes.slice(offset, end)
                        const request: any = { aid: this.appId, ver: 'last', version: 'v2', offset }
                        if (fsid) request.fsid = fsid
                        fsid = parseFsid(await client.RunMApp('upload_ipfs', request, [chunk]))
                        offset = end
                        onProgress?.(Math.max(1, Math.round((offset / bytes.length) * 100)))
                    }
                    if (!fsid) throw new Error('upload_ipfs returned no fsid')

                    const finalResponse = await client.RunMApp('upload_ipfs', {
                        aid: this.appId, ver: 'last', version: 'v2',
                        offset, fsid, finished: 'true',
                    })
                    if (finalResponse && typeof finalResponse === 'object' && finalResponse.cid) {
                        return finalResponse.cid
                    }
                    return parseFsid(finalResponse)
                } catch (error) {
                    lastError = error
                    console.error(`[uploadBlobToIpfs] Attempt ${attempt}/${maxAttempts} failed:`, error)
                    if (attempt < maxAttempts) {
                        // Invalidate cache so next attempt re-resolves a fresh IP.
                        const hostId = user.hostIds?.[0]
                        if (hostId) this._writableHostCache.delete(hostId)
                        user.writableHostIp = null
                        this.lapi.connectionPool.clearAll()
                        await new Promise(resolve => setTimeout(resolve, 1000))
                    }
                } finally {
                    client.timeout = originalTimeout
                    this.lapi.connectionPool.releaseConnection(uploadIp, client)
                }
            }
            throw lastError
        },

        /**
         * Registers a new user account (matches iOS registerUser)
         */
        async register(
            username: string,
            password: string,
            alias?: string,
            profile?: string,
            hostId?: string,
            cloudDrivePort: number = 0
        ): Promise<boolean> {
            const userObj: any = {
                mid: "",
                username: username,
                password: password,
                name: alias || "",
                profile: profile || "",
                cloudDrivePort: cloudDrivePort,
                timestamp: Date.now(),
            }
            if (hostId && hostId.trim()) {
                userObj.hostIds = [hostId.trim()]
            }

            const originalTimeout = this.lapi.client.timeout
            this.lapi.client.timeout = 15000
            let ret
            try {
                ret = await this.lapi.client.RunMApp("register", {
                    aid: this.appId,
                    ver: "last",
                    version: "v2",
                    user: JSON.stringify(userObj)
                })
            } finally {
                this.lapi.client.timeout = originalTimeout
            }

            if (!ret || !ret["success"]) {
                const msg = ret?.["message"] || "Registration failed"
                throw new Error(msg)
            }
            const { mid: registeredMid, user: registeredBlob } = parseRegisterSuccessUser(ret)
            if (registeredMid) {
                void this._autoFollowDefaultUsersAfterRegister(
                    registeredMid,
                    registeredBlob,
                )
            } else {
                console.warn("[register] No user.mid in registration response; skipping default followings auto-follow")
            }
            return true
        },

        /**
         * After successful registration, follow `VITE_DEFAULT_FOLLOWINGS` as the new account (same list
         * as iOS `Gadget.getAlphaIds()` after register).
         */
        _autoFollowDefaultUsersAfterRegister(
            registeredUserId: MimeiId,
            registeredUserBlob?: any,
        ) {
            void (async () => {
                const ids = defaultFollowingIdsFromEnv()
                if (ids.length === 0) return

                if (
                    !registeredUserBlob ||
                    typeof registeredUserBlob !== 'object' ||
                    registeredUserBlob.mid !== registeredUserId ||
                    !Array.isArray(registeredUserBlob.hostIds) ||
                    !registeredUserBlob.hostIds[0]
                ) {
                    console.warn("[register:autoFollow] Registration response has no authoritative hostIds[0]; cannot auto-follow")
                    return
                }

                let writableIp: string
                try {
                    writableIp = await this.resolveWritableHostIp(registeredUserBlob as User, true)
                } catch (error) {
                    console.warn("[register:autoFollow] Could not resolve registered user's hostIds[0]; cannot auto-follow", error)
                    return
                }

                const seeded = { ...registeredUserBlob, mid: registeredUserId }
                delete (seeded as any).password
                delete (seeded as any).client
                setStoredUser(registeredUserId, seeded)

                const followerClient = createPooledClient(writableIp, this.lapi.connectionPool)
                followerClient.timeout = TOGGLE_MUTATION_TIMEOUT_MS

                for (const followingId of ids) {
                    try {
                        const target = await this.getUser(followingId)
                        if (!target) {
                            console.warn(`[register:autoFollow] User not found, skip: ${followingId}`)
                            continue
                        }
                        const targetHostId = target.hostIds?.[0]
                        if (!targetHostId) {
                            console.warn(`[register:autoFollow] User has no root host, skip: ${followingId}`)
                            continue
                        }
                        const toggled = await followerClient.RunMApp("toggle_following", {
                            aid: this.appId,
                            ver: "last",
                            version: "v2",
                            followingid: followingId,
                            followingid_hostid: targetHostId,
                            userid: registeredUserId,
                            userid_hostid: registeredUserBlob?.hostIds?.[0],
                        })
                        const isFollowing = parseToggleFollowedV2Result(toggled)
                        if (isFollowing !== true) {
                            console.warn(`[register:autoFollow] Unexpected toggle result for ${followingId}`, toggled)
                        }
                    } catch (e) {
                        console.warn(`[register:autoFollow] Failed for ${followingId}`, e)
                    }
                }
            })()
        },

        /**
         * Updates the current user's profile data (matches iOS updateUserCore)
         */
        async updateProfile(updates: {
            name?: string,
            profile?: string,
            password?: string,
            hostId?: string,
            cloudDrivePort?: number,
            domainToShare?: string,
        }): Promise<boolean> {
            const user = this.loginUser
            if (!user) throw new Error("Not logged in")

            const userObj: any = {
                mid: user.mid,
                username: user.username,
                name: updates.name ?? user.name ?? "",
                profile: updates.profile ?? user.profile ?? "",
                timestamp: typeof user.timestamp === 'number' ? user.timestamp : Date.now(),
                cloudDrivePort: updates.cloudDrivePort ?? user.cloudDrivePort ?? 0,
                // Include cached stats/avatar so the server doesn't need a get_user_core_data
                // round-trip to merge them (avoids a redundant second set_author_core_data call).
                avatar: user.avatar ?? "",
                followingCount: user.followingCount ?? 0,
                followersCount: user.followersCount ?? 0,
                tweetCount: user.tweetCount ?? 0,
                bookmarksCount: user.bookmarksCount ?? 0,
                favoritesCount: user.favoritesCount ?? 0,
                commentsCount: user.commentsCount ?? 0,
                lastLogin: user.lastLogin ?? 0,
            }
            if (updates.password) {
                userObj.password = updates.password
            }
            // hostId: use provided value if non-empty, otherwise preserve existing
            if (updates.hostId !== undefined && updates.hostId.trim()) {
                userObj.hostIds = [updates.hostId.trim()]
            } else {
                userObj.hostIds = user.hostIds || []
            }
            // domainToShare: if explicitly provided (even empty string to clear), use it
            if (updates.domainToShare !== undefined) {
                const trimmed = updates.domainToShare.trim()
                if (trimmed) userObj.domainToShare = trimmed
            }

            // Mutation: route through user's writable host (hostIds[0]).
            const writableIp = await this.resolveWritableHostIp(user)
            const writeClient = createPooledClient(writableIp, this.lapi.connectionPool)
            const originalTimeout = writeClient.timeout
            writeClient.timeout = 30000
            let ret
            try {
                ret = await writeClient.RunMApp("set_author_core_data", {
                    aid: this.appId,
                    ver: "last",
                    version: "v2",
                    user: JSON.stringify(userObj)
                })
            } finally {
                writeClient.timeout = originalTimeout
            }

            if (!ret) throw new Error("Profile update failed")
            if (ret["success"] === false) {
                throw new Error(ret["message"] || "Profile update failed")
            }

            // Update local state
            if (updates.name !== undefined) user.name = updates.name
            if (updates.profile !== undefined) user.profile = updates.profile
            if (updates.cloudDrivePort !== undefined) user.cloudDrivePort = updates.cloudDrivePort
            if (updates.hostId !== undefined && updates.hostId.trim()) {
                user.hostIds = [updates.hostId.trim()]
            }
            this._user = user
            this._mergeUserIntoCachedRefs(user.mid, user)

            return true
        },

        /**
         * Generates a new agent token locally and stores its public key on the server.
         * Mirrors the iOS flow used for AI agent access.
         */
        async generateAgentToken(): Promise<string> {
            const user = this.loginUser
            if (!user) throw new Error("Must be logged in to generate agent token")

            const tokenResult = await createAgentTokenForUser(user.mid, ["post", "comment"])

            const userObj: any = {
                mid: user.mid,
                agentPublicKey: tokenResult.publicKey,
                cloudDrivePort: user.cloudDrivePort ?? 0,
            }
            if (typeof user.domainToShare === "string" && user.domainToShare.trim()) {
                userObj.domainToShare = user.domainToShare.trim()
            }

            // Mutation: route through user's writable host (hostIds[0]).
            const writableIp = await this.resolveWritableHostIp(user)
            const writeClient = createPooledClient(writableIp, this.lapi.connectionPool)
            const originalTimeout = writeClient.timeout
            writeClient.timeout = 30000
            let ret
            try {
                ret = await writeClient.RunMApp("set_author_core_data", {
                    aid: this.appId,
                    ver: "last",
                    version: "v2",
                    user: JSON.stringify(userObj)
                })
            } finally {
                writeClient.timeout = originalTimeout
            }

            if (!ret) throw new Error("Failed to update agent public key")
            if (ret["success"] === false) {
                throw new Error(ret["message"] || "Failed to update agent public key")
            }
            if (ret["status"] && ret["status"] !== "success") {
                throw new Error(ret["reason"] || "Failed to update agent public key")
            }

            user.agentPublicKey = tokenResult.publicKey
            this._user = user
            setStoredLoginUser(user)

            return tokenResult.tokenString
        },

        /**
         * Uploads avatar image to IPFS and sets it as user avatar (matches iOS ProfileEditView.swift)
         * @param blob The cropped avatar image blob
         * @returns The confirmed avatar MimeiId
         */
        async setUserAvatar(blob: Blob): Promise<string> {
            const user = this.loginUser
            if (!user) throw new Error("Not logged in")

            const cid = await this.uploadBlobToIpfs(user, await blob.arrayBuffer())

            // Mutation: route through user's writable host (hostIds[0]) so the
            // change lands on the writable node directly instead of relying on
            // server-side replication from a read-only host.
            const writableIp = await this.resolveWritableHostIp(user)
            const writeClient = createPooledClient(writableIp, this.lapi.connectionPool)
            const originalTimeout = writeClient.timeout
            writeClient.timeout = 30000
            let confirmedAvatar: string = cid
            try {
                const ret = await writeClient.RunMApp("set_user_avatar", {
                    aid: this.appId, ver: "last", version: "v2",
                    userid: user.mid, avatar: cid,
                })
                if (ret && typeof ret === 'object') confirmedAvatar = ret.data || ret.avatar || cid
                else if (typeof ret === 'string') confirmedAvatar = ret
            } finally {
                writeClient.timeout = originalTimeout
            }

            // Use writableIp for display: the CID was just uploaded there and is
            // guaranteed to exist. providerIp (read host) may not have replicated it yet,
            // which would cause a 404 and permanently break the avatar in AppHeader.
            const avatar = this.getMediaUrl(confirmedAvatar, `http://${writableIp}`)
            this._mergeUserIntoCachedRefs(user.mid, { avatar })

            return confirmedAvatar
        },

        /**
         * Fetches the backend domain from the server via check_upgrade API.
         * Returns the domain without protocol prefix (matching iOS backendDomainToShare).
         */
        async fetchBackendDomain(): Promise<string> {
            const user = this.loginUser
            if (!user) return ""
            try {
                const ret = await user.client.RunMApp("check_upgrade", {
                    aid: this.appId,
                    ver: "last",
                    version: "v2",
                    entry: "check_upgrade"
                })
                if (!ret) return ""
                let domain = ret["domain"]
                if (!domain && ret["data"]) {
                    domain = ret["data"]["domain"]
                }
                if (!domain) return ""
                // Strip protocol prefix like iOS does for placeholder display
                if (domain.startsWith("https://")) return domain.slice(8)
                if (domain.startsWith("http://")) return domain.slice(7)
                return domain
            } catch (e) {
                console.warn("[fetchBackendDomain] Failed:", e)
                return ""
            }
        },

        /**
         * Deletes the current user's account (matches iOS deleteAccount)
         */
        async deleteAccount(): Promise<boolean> {
            const user = this.loginUser
            if (!user) throw new Error("Not logged in")

            // Mutation: route through user's writable host (hostIds[0]).
            const writableIp = await this.resolveWritableHostIp(user)
            const writeClient = createPooledClient(writableIp, this.lapi.connectionPool)
            const originalTimeout = writeClient.timeout
            writeClient.timeout = 30000
            let ret
            try {
                ret = await writeClient.RunMApp("delete_account", {
                    aid: this.appId,
                    ver: "last",
                    version: "v2",
                    userid: user.mid
                })
            } finally {
                writeClient.timeout = originalTimeout
            }

            if (ret && ret["success"] === false) {
                throw new Error(ret["message"] || "Delete account failed")
            }

            // Clean up local state same as logout
            this.logout()
            return true
        },

        getIpWithoutPort(address: string): string | null {
            const match = address.match(/^(?:\[([0-9a-fA-F:]+)\]|([0-9.]+))(?::\d+)?$/);
            if (!match) return null;
            return match[1] ? `[${match[1]}]` : match[2];
        },
    },
});
