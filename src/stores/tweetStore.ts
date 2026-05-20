import { defineStore } from 'pinia';
import { reactive } from 'vue';
import { useLeitherStore } from './leitherStore';
import { useAlertStore } from './alert.store';
import { createPooledClient } from '@/utils/clientProxy';
import { nodePool } from '@/utils/nodePool';
import { normalizeMediaType, v4Only } from '@/lib';
import i18n from '@/i18n';
import { ed25519 } from '@noble/curves/ed25519.js';

const GUEST_ID = "000000000000000000000000000"

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
function socketAddressFromUrlHostPort(hostname: string, port: string): string | undefined {
    if (!hostname) return undefined
    const v6 = hostname.includes(':')
    if (v6) return port ? `[${hostname}]:${port}` : `[${hostname}]`
    return port ? `${hostname}:${port}` : hostname
}

/** Normalize host/IP so we can run range checks on raw addresses and URLs. */
function hostFromAddress(address: string): string {
    const raw = String(address ?? "").trim()
    if (!raw) return ""
    try {
        if (raw.includes("://")) {
            const hostname = new URL(raw).hostname
            if (hostname) return hostname
        }
    } catch {
        // Fall through to manual parsing for non-standard input.
    }
    let candidate = raw
    const slashIndex = candidate.indexOf("/")
    if (slashIndex >= 0) candidate = candidate.slice(0, slashIndex)
    if (candidate.startsWith("[")) {
        const end = candidate.indexOf("]")
        if (end > 1) return candidate.slice(1, end)
    }
    const ipv4WithOptionalPort = candidate.match(/^(\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?$/)
    if (ipv4WithOptionalPort) return ipv4WithOptionalPort[1]
    const hostPort = candidate.match(/^([^:]+):\d+$/)
    if (hostPort) return hostPort[1]
    return candidate
}

/** Tailscale typically uses the RFC6598 shared range 100.64.0.0/10. */
function isTailscaleAddress(address: string): boolean {
    const host = hostFromAddress(address)
    return /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host)
}

/** Prefer host:port from API user blob; avoids get_provider for the new mid right after register. */
function providerIpFromRegisteredUserBlob(u: any): string | undefined {
    if (!u || typeof u !== 'object') return undefined
    const direct = u.providerIp
    if (typeof direct === 'string' && direct.trim() && !String(direct).includes('://')) {
        const normalizedDirect = direct.trim()
        if (!isTailscaleAddress(normalizedDirect)) return normalizedDirect
    }
    for (const key of ['writableUrl', 'baseUrl'] as const) {
        const raw = u[key]
        if (typeof raw !== 'string' || !raw.trim()) continue
        try {
            const url = new URL(raw.trim())
            const host = url.hostname
            if (!host) continue
            const candidate = socketAddressFromUrlHostPort(host, url.port) ?? host
            if (!isTailscaleAddress(candidate)) return candidate
        } catch {
            const s = raw.trim()
            if (/^[\w.:\[\]-]+$/.test(s) && !s.includes('://') && !isTailscaleAddress(s)) return s
        }
    }
    return undefined
}

type RegisterSuccessUser = {
    mid?: string
    user?: any
    /** Connect here for toggle_followed as the new user */
    followerProviderIp?: string
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
    const fromBlob = providerIpFromRegisteredUserBlob(u)
    return { mid: u.mid, user: u, followerProviderIp: fromBlob }
}

function parseRegisteredUserMid(ret: any): string | undefined {
    return parseRegisterSuccessUser(ret).mid
}
const TWEET_COUNT = 5

export const useTweetStore = defineStore('tweetStore', {
    state: () => ({
        tweets: [] as Tweet[],      // tweets
        tweetIndex: new Map<string, Tweet>(),  // O(1) lookup by mid
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
            if (sessionStorage.getItem("user")) {
                let usr = JSON.parse(sessionStorage.getItem("user")!)
                usr.client = createPooledClient(usr.providerIp, state.lapi.connectionPool)
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
                        .slice(0, 50)
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
        async addTweetToStore(tweet: Tweet) {
            try {
                if (this._deletedTweetIds.has(tweet.mid)) return
                const existing = this.tweetIndex.get(tweet.mid)
                if (existing) {
                    // Tweet already cached — refresh mutable fields from fresh data.
                    this.refreshCachedTweet(existing, tweet)
                    return
                }

                // Use pre-resolved author if caller already set it, otherwise fetch
                let author = tweet.author || await this.getUser(tweet.authorId)
                if (!author) {
                    console.warn("Author not found for tweet:", tweet.mid, "authorId:", tweet.authorId)
                    return
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
                        
                        // If originalTweetId exists but originalTweet is null, skip this tweet
                        if (!tweet.originalTweet) {
                            console.warn(`[addTweetToStore] ❌ SKIPPING RETWEET - Original tweet unavailable:
  Retweet ID: ${tweet.mid}
  Original Tweet ID: ${tweet.originalTweetId}`)
                            return
                        }
                    } catch (error) {
                        console.error(`[addTweetToStore] ❌ ERROR fetching original tweet:
  Retweet ID: ${tweet.mid}
  Original Tweet ID: ${tweet.originalTweetId}
  Error:`, error)
                        console.warn(`[addTweetToStore] ❌ SKIPPING RETWEET due to fetch error`)
                        return
                    }
                }
                
                try {
                    sessionStorage.setItem(tweet.mid, JSON.stringify(tweet))
                } catch (error) {
                    console.error("Error saving tweet to sessionStorage:", error)
                    // Continue even if sessionStorage fails
                }
                
                this.tweets.push(tweet);
                this.tweetIndex.set(tweet.mid, tweet);
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
            pageSize: number = 10
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
                    const response = await user.client.RunMApp("get_tweets_by_user", params)

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

                    // Pre-fetch all unique authors in parallel (addTweetToStore calls getUser internally)
                    if (tweetsData) {
                        const uniqueAuthorIds = [...new Set(
                            tweetsData.filter((t: any) => t != null).map((t: any) => t.authorId)
                        )] as string[]
                        await Promise.all(uniqueAuthorIds.map(id => this.getUser(id).catch(() => undefined)))
                    }

                    if (tweetsData) {
                        for (const tweetJson of tweetsData) {
                            if (tweetJson == null) continue
                            const tweet = tweetJson as Tweet
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
                    .map(t => {
                        // Strip non-serializable fields (client, etc.)
                        const { author, originalTweet, comments, ...rest } = t
                        const cached: any = { ...rest }
                        if (author) {
                            const { client, ...authorRest } = author as any
                            cached.author = authorRest
                        }
                        if (originalTweet) {
                            const { author: origAuthor, comments: origComments, ...origRest } = originalTweet
                            cached.originalTweet = { ...origRest }
                            if (origAuthor) {
                                const { client, ...origAuthorRest } = origAuthor as any
                                cached.originalTweet.author = origAuthorRest
                            }
                        }
                        return cached
                    })
                    .sort((a, b) => (b.timestamp as number) - (a.timestamp as number))
                localStorage.setItem(`tweets_${userId}`, JSON.stringify(userTweets))
            } catch (e) {
                console.warn("Failed to cache user tweets to localStorage:", e)
            }
        },

        /**
         * Load cached tweets for a user from localStorage
         * Returns tweets with author.client restored
         */
        getCachedUserTweets(userId: string): Tweet[] {
            try {
                const cached = localStorage.getItem(`tweets_${userId}`)
                if (!cached) return []
                const tweets = JSON.parse(cached) as Tweet[]
                for (const t of tweets) {
                    if (t.author?.providerIp) {
                        t.author.client = createPooledClient(t.author.providerIp, this.lapi.connectionPool)
                    }
                    if (t.originalTweet?.author?.providerIp) {
                        t.originalTweet.author.client = createPooledClient(t.originalTweet.author.providerIp, this.lapi.connectionPool)
                    }
                    t.comments = []
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
                    const { author, originalTweet, comments, ...rest } = t
                    const cached: any = { ...rest }
                    if (author) {
                        const { client, ...authorRest } = author as any
                        cached.author = authorRest
                    }
                    if (originalTweet) {
                        const { author: origAuthor, comments: origComments, ...origRest } = originalTweet
                        cached.originalTweet = { ...origRest }
                        if (origAuthor) {
                            const { client, ...origAuthorRest } = origAuthor as any
                            cached.originalTweet.author = origAuthorRest
                        }
                    }
                    return cached
                })
                localStorage.setItem(`pinned_${userId}`, JSON.stringify(serializable))
            } catch (e) {
                console.warn("Failed to cache pinned tweets:", e)
            }
        },

        /**
         * Load cached pinned tweets from localStorage
         */
        getCachedPinnedTweets(userId: string): Tweet[] {
            try {
                const cached = localStorage.getItem(`pinned_${userId}`)
                if (!cached) return []
                const tweets = JSON.parse(cached) as Tweet[]
                for (const t of tweets) {
                    if (t.author?.providerIp) {
                        t.author.client = createPooledClient(t.author.providerIp, this.lapi.connectionPool)
                    }
                    if (t.originalTweet?.author?.providerIp) {
                        t.originalTweet.author.client = createPooledClient(t.originalTweet.author.providerIp, this.lapi.connectionPool)
                    }
                    t.comments = []
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
                                    sessionStorage.setItem(originalTweet.mid, JSON.stringify(originalTweet))
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
                    const raw = await user.client.RunMApp("get_pinned_tweets", params)

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
                            // Update existing tweet with pin timestamp info
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
            type: 'bookmark_list' | 'favorite_list',
            pageNumber: number = 0,
            pageSize: number = 20
        ): Promise<Tweet[]> {
            const user = await this.getUser(userId)
            if (!user || !user.client) return []

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
                raw = await user.client.RunMApp("get_user_meta", params)
            } catch (e) {
                console.warn(`[loadUserTweetsByType] ${type} RPC failed for ${userId}:`, e)
                return []
            }

            const data = (raw && typeof raw === 'object' && 'success' in raw)
                ? (raw.success ? (raw.data ?? []) : [])
                : raw

            if (!Array.isArray(data)) {
                console.warn(`[loadUserTweetsByType] ${type} response not an array for ${userId}:`, data)
                return []
            }

            const result: Tweet[] = []
            for (const t of data) {
                if (!t || !t.mid) continue
                try {
                    await this.addTweetToStore(t)
                } catch (e) {
                    console.error(`[loadUserTweetsByType] addTweetToStore failed for`, t.mid, e)
                    continue
                }
                const stored = this.tweetIndex.get(t.mid)
                if (stored) result.push(stored)
            }
            return result
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
            pageSize: number
        ): Promise<number | null> {
            try {
                const params = {
                    aid: this.appId,
                    ver: "last",
                    pn: pageNumber,
                    ps: pageSize,
                    userid: user.mid,
                    appuserid: this.loginUser?.mid ? this.loginUser?.mid : GUEST_ID,
                }
                const response = await user.client.RunMApp("get_tweet_feed", params)

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

                // Pre-fetch all unique authors in parallel to avoid sequential RPC calls
                if (tweetsData) {
                    const uniqueAuthorIds = [...new Set(
                        tweetsData.filter((t: any) => t != null).map((t: any) => t.authorId)
                    )] as string[]
                    await Promise.all(uniqueAuthorIds.map(id => this.getUser(id).catch(() => undefined)))
                }

                // Process main tweets (authors are now in-memory cache)
                if (tweetsData) {
                    for (const tweetJson of tweetsData) {
                        if (tweetJson != null) {
                            try {
                                const tweet = tweetJson as Tweet
                                const author = await this.getUser(tweet.authorId)
                                if (!author) {
                                    continue
                                }
                                tweet.author = author

                                // Skip private tweets in feed
                                if (tweet.isPrivate) {
                                    continue
                                }
                                const cachedTweet = this.tweetIndex.get(tweet.mid)
                                if (cachedTweet) {
                                    this.refreshCachedTweet(cachedTweet, tweet)
                                } else {
                                    await this.addTweetToStore(tweet)
                                }
                            } catch (error) {
                                console.error("Error processing tweet in feed:", error)
                                continue
                            }
                        }
                    }
                }

                // If this is the first page (pageNumber === 0), also update following tweets in background
                if (pageNumber === 0) {
                    // Call updateFollowingTweets in background without blocking the main flow
                    this.updateFollowingTweets().catch(error => {
                        console.error("Background updateFollowingTweets failed:", error)
                        // Don't throw the error as this is a background operation
                    })
                }

                return tweetsData?.length || null
            } catch (e) {
                console.error("Error fetching tweet feed:", e)
                return null
            }
        },

        /**
         * Updates following tweets by calling the update_following_tweets endpoint.
         * This function can only be called after user has logged in.
         * Processes tweets exactly like getTweetFeed() and updates state.tweets directly.
         */
        async updateFollowingTweets(): Promise<void> {
            // Check if user is logged in
            if (!this.loginUser) {
                console.error("updateFollowingTweets: User must be logged in to call this function")
                useAlertStore().error("You must be logged in to update following tweets")
                return
            }

            try {
                const params = {
                    aid: this.appId,
                    ver: "last",
                    appuserid: this.loginUser.mid,
                    hostid: this.loginUser.hostIds?.[0]
                }

                const response = await this.loginUser.client.RunMApp("update_following_tweets", params)

                // Check success status first
                const success = response?.success
                if (success !== true) {
                    const errorMessage = response?.message || "Unknown error occurred"
                    console.error("Update following tweets failed:", errorMessage)
                    console.error("Response:", response)
                    return
                }

                // Cache original tweets first (same as getTweetFeed)
                if (response.originalTweets) {
                    await this.updateOriginalTweets(response.originalTweets)
                }

                // Extract tweets from the response format (same as getTweetFeed)
                const tweetsData = response.tweets

                // Pre-fetch all unique authors in parallel to avoid sequential RPC calls
                if (tweetsData) {
                    const uniqueAuthorIds = [...new Set(
                        tweetsData.filter((t: any) => t != null).map((t: any) => t.authorId)
                    )] as string[]
                    await Promise.all(uniqueAuthorIds.map(id => this.getUser(id).catch(() => undefined)))
                }

                // Process main tweets (authors are now in-memory cache)
                if (tweetsData) {
                    for (const tweetJson of tweetsData) {
                        if (tweetJson != null) {
                            try {
                                const tweet = tweetJson as Tweet
                                const author = await this.getUser(tweet.authorId)
                                if (!author) {
                                    continue
                                }
                                tweet.author = author

                                // Skip private tweets in feed (same as getTweetFeed)
                                if (tweet.isPrivate) {
                                    continue
                                }
                                const cachedTweet = this.tweetIndex.get(tweet.mid)
                                if (cachedTweet) {
                                    this.refreshCachedTweet(cachedTweet, tweet)
                                } else {
                                    await this.addTweetToStore(tweet)
                                }
                            } catch (error) {
                                console.error("Error processing tweet in updateFollowingTweets:", error)
                                continue
                            }
                        }
                    }
                }

                console.log(`Successfully updated following tweets: ${tweetsData?.length || 0} tweets processed`)
            } catch (e) {
                console.error("Error calling update_following_tweets:", e)
            }
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
            useRacing: boolean = false
        ): Promise<Tweet | null> {
            let tweet = await this.fetchTweet(tweetId, authorId, useRacing)
            if (!tweet ) {
                // Author node has not data, try to load the tweet by id alone from some other provider.
                tweet = await this.fetchTweet(tweetId, undefined, useRacing)
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
         * @returns The tweet object or undefined if not found
         */
        async fetchTweet(
            tweetId: MimeiId,
            authorId: MimeiId | undefined = undefined,
            useRacing: boolean = false
        ): Promise<Tweet | null> {
            // check if the tweet has been retrieved
            let cachedTweet = this.tweetIndex.get(tweetId) ?? this.originalTweetIndex.get(tweetId)
            if (cachedTweet) {
                console.log(`[fetchTweet] ✅ Cache HIT (in-memory): ${tweetId} - No fetch needed!`)
                return cachedTweet
            }

            if (sessionStorage.getItem(tweetId)) {
                console.log(`[fetchTweet] ✅ Cache HIT (sessionStorage): ${tweetId} - No fetch needed!`)
                let t = JSON.parse(sessionStorage.getItem(tweetId)!)
                if (t.author && t.author.providerIp) {
                    // hprose clients aren't JSON-serializable; rebuild on restore.
                    t.author.client = createPooledClient(t.author.providerIp, this.lapi.connectionPool)
                    if (t.originalTweet?.author?.providerIp) {
                        t.originalTweet.author.client = createPooledClient(t.originalTweet.author.providerIp, this.lapi.connectionPool)
                    }
                    return t
                } else {
                    console.log(`[fetchTweet] Cached tweet ${tweetId} missing author/providerIp, fetching fresh data`)
                    // Remove invalid cache
                    sessionStorage.removeItem(tweetId)
                }
            }

            console.log(`[fetchTweet] ⚠️ Cache MISS: ${tweetId} - Will fetch (authorId: ${authorId}, useRacing: ${useRacing})`)
            let author: any, providerClient: any, providerIp: any, tweetInDB: any

            if (authorId) {
                // Step 1: resolve author to get their node, then use refresh_tweet
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
                // Step 2: no authorId, or author-based fetch failed — resolve provider IP from tweetId.
                // Use get_tweet WITHOUT version:"v3" here, because v3 requires userid and returns null without it.
                // Pre-v3 get_tweet returns a single object; we normalize it to an array below.
                if (useRacing) {
                    const providerIps = await this.getProviderIps(tweetId)
                    if (providerIps.length === 0) {
                        console.warn(`[fetchTweet] No provider IPs for tweet ${tweetId} (racing path)`)
                        return null
                    }
                    const raceResult = await this.raceProviderIps(providerIps, async (ip, client) => {
                        return await client.RunMApp("get_tweet", {
                            aid: this.lapi.appId,
                            ver: "last",
                            tweetid: tweetId,
                            appuserid: this.loginUser?.mid ? this.loginUser?.mid : GUEST_ID
                        })
                    })
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
                        appuserid: this.loginUser?.mid ? this.loginUser?.mid : GUEST_ID
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
                } else {
                    // Fallback: fetch original tweet separately
                    originalTweetData = await this.fetchTweet(tweetData.originalTweetId, tweetData.originalAuthorId, false)
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
                provider: providerIp,
                likeCount: tweetData.favoriteCount ?? tweetData.likeCount,
                bookmarkCount: tweetData.bookmarkCount,
                commentCount: tweetData.commentCount,
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
                    provider: providerIp,
                    likeCount: originalTweetData.favoriteCount ?? originalTweetData.likeCount,
                    bookmarkCount: originalTweetData.bookmarkCount,
                    commentCount: originalTweetData.commentCount,
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

            sessionStorage.setItem(tweetData.mid, JSON.stringify(tweet))
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
                return this.loginUser
            if (!forceRefresh && this.users.get(userId))
                return this.users.get(userId)

            // Deduplicate concurrent fetches for the same user.
            // Use separate keys for forced vs normal fetches so a cached (fast)
            // non-refresh promise never satisfies a caller that needs fresh data.
            const pendingKey = forceRefresh ? `${userId}:force` : userId
            const pending = this._pendingUserFetches.get(pendingKey)
            if (pending) return pending

            const fetchPromise = this._fetchUser(userId, forceRefresh)
            this._pendingUserFetches.set(pendingKey, fetchPromise)
            try {
                return await fetchPromise
            } finally {
                this._pendingUserFetches.delete(pendingKey)
            }
        },

        async _fetchUser(userId: MimeiId, forceRefresh: boolean): Promise<User | undefined> {
            // Try sessionStorage cache for faster initial display
            // Trust the cached IP — if it's stale, the RPC call will fail and the
            // retry loop (attempt 2) will resolve a fresh IP automatically.
            if (!forceRefresh) {
                const cached = sessionStorage.getItem(userId)
                if (cached) {
                    try {
                        const cachedUser = JSON.parse(cached)
                        if (cachedUser && cachedUser.mid && cachedUser.hostIds && cachedUser.providerIp) {
                            cachedUser.client = createPooledClient(cachedUser.providerIp, this.lapi.connectionPool)
                            cachedUser.avatar = this.getMediaUrl(cachedUser.avatar, `http://${cachedUser.providerIp}`)
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
            const providerIps = await this.getProviderIps(userId, v4Only, forceRefresh)
            if (providerIps.length === 0) {
                console.warn(`[_fetchUser] No provider IPs for user ${userId}`)
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
            })

            if (!raceResult) {
                console.error(`[_fetchUser] All provider IPs failed for user ${userId}`)
                this._nullifyCachedIp(userId)
                return undefined
            }

            let user: any = raceResult.result
            const providerIp = raceResult.ip

            if (!user || typeof user !== 'object' || !user.mid || !user.hostIds) {
                console.error(`[_fetchUser] Invalid user object for ${userId}:`, user)
                this._nullifyCachedIp(userId)
                return undefined
            }

            // cache the user data
            user.providerIp = providerIp
            // Use server's cloudDrivePort if available
            // IMPORTANT: Use nullish coalescing (??) to allow 0 as a valid value (meaning no service)
            // If cloudDrivePort is not set by server, it remains undefined (no backend service)
            user.cloudDrivePort = user.cloudDrivePort ?? user.clouddriveport
            sessionStorage.setItem(userId, JSON.stringify(user))
            user.client = createPooledClient(providerIp, this.lapi.connectionPool)
            user.avatar = this.getMediaUrl(user.avatar, `http://${providerIp}`)
            delete user.baseUrl
            delete user.writableUrl
            // Initialize writableHostIp if not already set
            if (user.writableHostIp === undefined) {
                user.writableHostIp = null
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
        async isServerHealthy(ip: string, timeoutMs: number = 5000): Promise<boolean> {
            const cacheTTL = 30 * 60 * 1000;
            const cached = this.healthCheckCache.get(ip);
            if (cached && (Date.now() - cached.timestamp) < cacheTTL) {
                console.log(`[isServerHealthy] cached ${ip}: ${cached.isHealthy ? 'healthy' : 'unhealthy'}`);
                return cached.isHealthy;
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

        async isServerHealthyWithTimeout(ip: string, timeout: number = 5000): Promise<boolean> {
            return this.isServerHealthy(ip, timeout);
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
            apiCall: (ip: string, client: any) => Promise<T>
        ): Promise<{ result: T, ip: string } | null> {
            if (ips.length === 0) {
                return null;
            }

            console.log(`[raceProviderIps] Racing ${ips.length} IP(s):`, ips);

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

                    console.log(`[raceProviderIps] ✅ Success with IP: ${ip}`);
                    return { result, ip };
                } catch (error) {
                    console.warn(`[raceProviderIps] ❌ Failed with IP: ${ip}`, error);
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
                console.error(`[raceProviderIps] All IPs failed:`, error);
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

        /**
         * Nullify the providerIp in the sessionStorage cache for a user,
         * so the next fetch won't reuse a stale IP while preserving other cached data.
         */
        _nullifyCachedIp(userId: string) {
            nodePool.invalidate(userId)
            const cached = sessionStorage.getItem(userId)
            if (cached) {
                try {
                    const cachedUser = JSON.parse(cached)
                    cachedUser.providerIp = null
                    sessionStorage.setItem(userId, JSON.stringify(cachedUser))
                } catch (e) {
                    sessionStorage.removeItem(userId)
                }
            }
        },

        /**
         * Get the first pair of provider IPs for a given mid without testing them
         * @param mid The mid to get provider IPs for
         * @param v4only Whether to filter out IPv6 addresses (default: v4Only)
         * @returns Array of IP addresses (up to 2), or empty array if none found
         */
        async getProviderIps(mid: string, v4only: boolean = v4Only, refresh: boolean = false): Promise<string[]> {
            return nodePool.resolveIPs(mid, () => this._resolveProviderIps(mid, v4only, refresh), refresh);
        },

        /** Raw RPC call to resolve provider IPs — called via nodePool for caching & dedup */
        async _resolveProviderIps(mid: string, v4only: boolean, refresh: boolean): Promise<string[]> {
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

                        // Filter out private/local IPs (not reachable from public internet)
                        if (this.isLocalIP(ip)) return false;
                        // Explicit guard for VPN-assigned Tailscale addresses.
                        if (isTailscaleAddress(ip)) return false;

                        return true;
                    });

                if (ipAddresses.length === 0) {
                    console.error("[getProviderIps] No valid IPs returned for", mid);
                    return [];
                }

                // Race all candidate IPs in parallel; return the first one that passes
                // a health check. Remaining checks are abandoned once a winner is found.
                const candidates = ipAddresses.slice(0, 4);
                const winner = await new Promise<string | null>((resolve) => {
                    let settled = 0;
                    for (const ip of candidates) {
                        this.isServerHealthyWithTimeout(ip, 3000).then(healthy => {
                            if (healthy) { resolve(ip); return; }
                            if (++settled === candidates.length) resolve(null);
                        }).catch(() => {
                            if (++settled === candidates.length) resolve(null);
                        });
                    }
                });

                if (!winner) {
                    console.warn(`[getProviderIps] All health checks failed for ${mid}, falling back to first candidate:`, candidates[0]);
                    return [candidates[0]];
                }

                console.log(`[getProviderIps] First healthy IP for ${mid}:`, winner);
                return [winner];

            } catch (error) {
                console.error("[getProviderIps] Error getting provider IPs for", mid, error);
                return [];
            }
        },
        /**
         * Load comments of a tweet into its comments attribute. 
         * Comments are on the same node with the tweet.
         * @param tweet The tweet to load comments for
         */
        async loadComments(tweet: Tweet) {
            if (!tweet || !tweet.provider) {
                console.warn('[loadComments] Skipping: no tweet or provider', tweet?.mid, tweet?.provider)
                return
            }
            console.log('[loadComments] Loading comments for tweet:', tweet.mid, 'provider:', tweet.provider)
            // Use auto-releasing proxy so the pool slot is freed after the RPC.
            let client = createPooledClient(tweet.provider, this.lapi.connectionPool)
            let comments = await client.RunMApp("get_comments", {
                aid: this.lapi.appId,
                ver: "last",
                tweetid: tweet.mid,
                appuserid: this.loginUser?.mid ? this.loginUser?.mid : GUEST_ID,
                pn: 0,
                ps: 20
            }) as any[]

            console.log('[loadComments] API returned:', comments?.length ?? 0, 'comments')

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
                    if (!e || !e.mid || !e.authorId) {
                        console.warn("Skipping invalid comment:", e)
                        continue
                    }
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
                        favorites: e.favorites,
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
                                    ud.avatar = this.getMediaUrl(ud.avatar, `http://${tweetProvider}`)
                                    if (ud.writableHostIp === undefined) ud.writableHostIp = null
                                    this.users.set(authorId, ud)
                                    setCommentAuthor(commentMid, ud)
                                    return
                                }
                            } catch (err) {
                                console.warn("[loadComments] tweet-provider get_user failed for", authorId, err)
                            }
                        }

                        // 3. User's own provider — checks sessionStorage then network, with retries
                        for (let attempt = 1; attempt <= 3; attempt++) {
                            if (attempt > 1) await new Promise(r => setTimeout(r, 5000))
                            try {
                                const author = await this._getUserForProviderRetryAttempt(authorId, attempt)
                                if (author) { setCommentAuthor(commentMid, author); return }
                            } catch (error: any) {
                                if (!error?.message?.includes('timeout'))
                                    console.warn("Error loading comment author:", authorId, error)
                            }
                        }
                    })()
                }
            }
            tweet.comments?.sort((a, b) => (b.timestamp as number) - (a.timestamp as number))
        },

        /**
         * Constructs the full media URL from a media ID and base URL
         * @param mid The media ID
         * @param baseUrl The base URL for the media server
         * @returns The complete media URL
         */
        getMediaUrl(mid: string | undefined, baseUrl: string): string {
            let url = baseUrl
            if (!mid) {
                return import.meta.env.VITE_APP_LOGO
            }
            return mid.length > 27 ? url + "/ipfs/" + mid : url + "/mm/" + mid
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
                        sessionStorage.setItem("user", JSON.stringify(user))
                        user.client = createPooledClient(user.providerIp, this.lapi.connectionPool)
                        this._user = user
                        this.addFollowing(userId)
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
            this._user = null
            this._followings = []
            this.tweets = []
            this.tweetIndex.clear()
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
            if (!loginUser?.client) {
                throw new Error("You must be logged in to toggle following")
            }

            // Route the call directly to loginUser's primary host (hostIds[0])
            // so the backend's `userHostId === nodeId` check fires and the local
            // handler runs. The cross-node delegation path in toggle_following.js
            // drops the response payload (Java-Map-backed bridge object whose
            // keys are not JS-enumerable), turning a clearly successful op into
            // a client-side failure. Falls back to loginUser.client if the
            // writable host can't be resolved.
            let homeClient = loginUser.client
            try {
                const writableIp = await this.resolveWritableHostIp(loginUser)
                homeClient = createPooledClient(writableIp, this.lapi.connectionPool)
            } catch (e) {
                console.warn('[toggleFollowing] Could not resolve home host, using current client:', e)
            }

            // Follow can RPC to home node and sync many tweets; default pooled timeout (15s) is often too short.
            const originalTimeout = homeClient.timeout
            homeClient.timeout = 120000
            let ret: unknown
            try {
                const followingUser = this.users.get(followingId)
                ret = await homeClient.RunMApp("toggle_following", {
                    aid: this.appId,
                    ver: "last",
                    version: "v2",
                    followingid: followingId,
                    followingid_hostid: followingUser?.hostIds?.[0],
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

            if (isFollowing && !wasFollowing) {
                if (this.loginUser) {
                    this.loginUser.followingCount = (this.loginUser.followingCount ?? 0) + 1
                }
                if (targetUser) {
                    targetUser.followersCount = (targetUser.followersCount ?? 0) + 1
                }
            } else if (!isFollowing && wasFollowing) {
                if (this.loginUser) {
                    this.loginUser.followingCount = Math.max(0, (this.loginUser.followingCount ?? 0) - 1)
                }
                if (targetUser) {
                    targetUser.followersCount = Math.max(0, (targetUser.followersCount ?? 0) - 1)
                }
            }

            sessionStorage.setItem("user", JSON.stringify(this.loginUser))
            return isFollowing
        },

        /**
         * Deletes a tweet from the system
         * @param tweetId The ID of the tweet to delete
         * @param authorId The ID of the tweet author
         */
        async deleteTweet(tweetId: MimeiId, authorId: MimeiId) {
            this._deletedTweetIds.add(tweetId)
            this.tweets.splice(this.tweets.findIndex(e=>e.mid==tweetId), 1)
            this.tweetIndex.delete(tweetId)
            let user = await this.getUser(authorId)
            if (user && this.loginUser) {
                // Mutation: route through loginUser's writable host (hostIds[0]).
                let client = this.loginUser.client
                try {
                    const writableIp = await this.resolveWritableHostIp(this.loginUser)
                    client = createPooledClient(writableIp, this.lapi.connectionPool)
                } catch (e) {
                    console.warn('[deleteTweet] Could not resolve writable host, using current client:', e)
                }
                await client.RunMApp("delete_tweet", {aid: this.appId, ver: "last",
                    tweetid: tweetId, userid: authorId
                })
            }
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
                console.error("Unauthorized: Only comment author, parent tweet author, or admin can delete comments")
                return
            }

            // Get parent tweet author's client (comments are stored on the same node as the tweet)
            let parentAuthor = await this.getUser(parentAuthorId)
            if (!parentAuthor || !parentAuthor.client) {
                console.error("Failed to get parent tweet author's client for deleting comment")
                return
            }
            
            if (!parentAuthor.hostIds || !parentAuthor.hostIds[0]) {
                console.error("Parent tweet author's hostIds[0] is missing")
                return
            }

            // Call delete_comment API with proper parameters matching server expectations
            await parentAuthor.client.RunMApp("delete_comment", {
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
            var fsid = await this.loginUser?.client.RunMApp("open_temp_file", {
                aid: this.appId, ver: "last"
            })
            console.log("Open temp file", fsid, this.loginUser)
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

            // Point the main client at the writable host (hostIds[0]) for writes.
            // Matches iOS appUser.resolveWritableUrl; runs once per session then
            // caches via user.writableHostIp.
            if (!this.loginUser.writableHostIp && this.loginUser.hostIds?.[0]) {
                try {
                    const writableIp = await Promise.race([
                        this.resolveWritableHostIp(this.loginUser),
                        new Promise<string>((_, reject) =>
                            setTimeout(() => reject(new Error('writable host discovery timeout')), 5000))
                    ])
                    this.loginUser.client = createPooledClient(writableIp, this.lapi.connectionPool)
                    sessionStorage.setItem('user', JSON.stringify(this.loginUser))
                } catch (error) {
                    console.warn('[TWEET-STORE] Writable host unavailable, using current client:', error)
                }
            }

            // Leither may be busy after video processing; allow 5 minutes per write.
            const effectiveTimeout = 5 * 60 * 1000
            const originalTimeout = this.loginUser.client.timeout
            this.loginUser.client.timeout = effectiveTimeout

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
                        const parentAuthorHostId = parentTweet?.author?.hostIds?.[0]
                        if (!parentAuthorHostId) {
                            throw new Error('Parent tweet author has no hostIds[0]')
                        }
                        return await this.loginUser!.client.RunMApp('add_comment', {
                            aid: this.appId, ver: 'last',
                            tweetid: tweetId,
                            comment: JSON.stringify(tweet),
                            userid: this.loginUser!.mid,
                            hostid: parentAuthorHostId,
                        })
                    }
                    return await this.loginUser!.client.RunMApp('add_tweet', {
                        aid: this.appId, ver: 'last',
                        tweet: JSON.stringify(tweet),
                        hostid: this.loginUser!.hostIds?.[0],
                    })
                })()

                ret = await Promise.race([uploadPromise, timeoutPromise])
            } catch (error) {
                console.error(`Upload ${tweetId ? 'comment' : 'tweet'} failed:`, error)
                throw error
            } finally {
                this.loginUser.client.timeout = originalTimeout
            }
                
            // Check if the backend returned null, indicating failure
            if (ret === null || ret === undefined || !ret.success) {
                const errorMessage = ret?.message || 'Unknown error occurred during tweet upload'
                throw new Error(errorMessage);
            }
            return ret.mid
        },
        /**
         * Registers a quote tweet on the original tweet's node (increments retweet count).
         * Mirrors iOS updateRetweetCount — calls RunMApp("retweet_added") on the original
         * tweet author's client.
         */
        async updateRetweetCount(originalTweet: Tweet, retweetId: MimeiId): Promise<void> {
            const client = (originalTweet.author as any)?.client ?? this.loginUser?.client
            if (!client) {
                console.warn('[updateRetweetCount] No client available')
                return
            }
            try {
                const ret = await client.RunMApp("retweet_added", {
                    aid: this.appId,
                    ver: "last",
                    version: "v2",
                    appuserid: this.loginUser?.mid,
                    retweetid: retweetId,
                    tweetid: originalTweet.mid,
                    authorid: originalTweet.authorId,
                })
                // Mirror iOS unwrapV2Response: prefer ret.data, fall back to ret itself
                const tweetDict = ret?.success ? (ret.data ?? ret) : null
                // Use server count if available, otherwise keep optimistic +1 (upload already succeeded)
                const newCount = tweetDict?.retweetCount ?? (originalTweet.retweetCount ?? 0) + 1
                const idx = this.tweets.findIndex(e => e.mid === originalTweet.mid)
                if (idx >= 0) this.tweets[idx].retweetCount = newCount
            } catch (error) {
                console.warn('[updateRetweetCount] Failed to update retweet count:', error)
            }
        },
        /**
         * Updates an existing tweet's content
         * @param tweet The full tweet object with modified content
         * @returns The mid of the updated tweet
         */
        async updateTweet(tweetId: MimeiId, content: string, authorId?: MimeiId) {
            if (!this.loginUser) {
                throw new Error('Not authorized to edit this tweet')
            }
            try {
                // Mutation: route through loginUser's writable host (hostIds[0]).
                let client = this.loginUser.client
                try {
                    const writableIp = await this.resolveWritableHostIp(this.loginUser)
                    client = createPooledClient(writableIp, this.lapi.connectionPool)
                } catch (e) {
                    console.warn('[updateTweet] Could not resolve writable host, using current client:', e)
                }
                const ret = await client.RunMApp("update_tweet",
                    {aid: this.appId, ver: "last",
                        appuserid: authorId ?? this.loginUser.mid,
                        tweetid: tweetId,
                        content: content})
                if (!ret || !ret.success) {
                    throw new Error(ret?.message || 'Failed to update tweet')
                }
                // Update local tweet in store
                const idx = this.tweets.findIndex(t => t.mid === tweetId)
                if (idx !== -1) {
                    this.tweets[idx].content = content
                }
                return ret.mid
            } catch (error) {
                console.error('[TWEET-STORE] Update tweet failed:', error)
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
            const originalTimeout = this.loginUser?.client.timeout
            
            try {
                // Use longer timeout for package upload (10 minutes)
                this.loginUser!.client.timeout = 10 * 60 * 1000
                
                const params: any = {
                    aid: this.lapi.appId, ver: "last", cid: cid
                }
                if (mini) {
                    params.mini = "mini"
                }
                let mid = await this.loginUser?.client.RunMApp("upload_package", params)
                return mid
            } finally {
                // Restore original timeout
                this.loginUser!.client.timeout = originalTimeout
            }
        },
        /**
         * Upload a file to mm database, and add referrence to userId.
         * @param filename 
         * @returns mid of uploaded file
         */
        async uploadFile(cid: string, filename: string) {
            const originalTimeout = this.loginUser?.client.timeout
            
            try {
                // Use longer timeout for file upload (10 minutes)
                this.loginUser!.client.timeout = 10 * 60 * 1000
                
                let mid = await this.loginUser?.client.RunMApp("upload_file", {
                    aid: this.lapi.appId,
                    ver: "last", 
                    cid: cid,
                    userid: this.loginUser?.mid
                })
                return mid
            } finally {
                // Restore original timeout
                this.loginUser!.client.timeout = originalTimeout
            }
        },
        /**
         * Shares a file with other users
         * @param file The file to share
         * @returns The Mimei ID of the shared file
         */
        async shareFile(file: FileSystemItem) {
            let mid = await this.loginUser?.client.RunMApp("share_file", {
                aid: this.lapi.appId,
                ver: "last",
                file: JSON.stringify(file),
                userid: this.loginUser?.mid
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
         * @param tweetId The ID of the tweet to toggle like for
         * @returns The updated tweet object
         */
        async toggleFavorite(tweet: Tweet) {
            if (!tweet.author?.client) throw new Error('Author client not available for toggle_favorite')
            const client = tweet.author.client
            const originalTimeout = client.timeout
            client.timeout = 15000
            try {
                var ret = await client.RunMApp("toggle_favorite", {
                    aid: this.appId, ver: "last", version: "v2", appuserid: this.loginUser?.mid, tweetid: tweet.mid, authorid: tweet.authorId, userhostid: this.loginUser?.hostIds?.[0]
                })
                return this._applyServerTweet(tweet, ret)
            } finally {
                client!.timeout = originalTimeout
            }
        },
        /**
         * Toggles the bookmark status of a tweet
         * @param tweet The tweet to toggle bookmark for
         * @returns The updated tweet object
         */
        async toggleBookmark(tweet: Tweet) {
            if (!tweet.author?.client) throw new Error('Author client not available for toggle_bookmark')
            const client = tweet.author.client
            const originalTimeout = client.timeout
            client.timeout = 15000
            try {
                var ret = await client.RunMApp("toggle_bookmark", {
                    aid: this.appId, ver: "last", version: "v2", userid: this.loginUser?.mid, tweetid: tweet.mid, authorid: tweet.authorId, userhostid: this.loginUser?.hostIds?.[0]
                })
                return this._applyServerTweet(tweet, ret)
            } finally {
                client!.timeout = originalTimeout
            }
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
                }
                const idx = this.tweets.findIndex(e => e.mid == tweet.mid)
                if (idx >= 0) {
                    Object.assign(this.tweets[idx], updated)
                }
                localStorage.setItem(tweet.mid, JSON.stringify(updated))

                // Update login user from server response (like Android's appUser.from)
                if (response.user && this.loginUser) {
                    Object.assign(this.loginUser, response.user)
                    sessionStorage.setItem("user", JSON.stringify(this.loginUser))
                }

                return updated
            }
            return { ...tweet }
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
                /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // RFC 6598 Shared Address Space (Tailscale)
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
         * Returns the first non-local, non-VPN, non-IPv6 (when v4Only is on)
         * address, or null if none are usable.
         */
        async getNodeIp(user: User): Promise<string | null> {
            try {
                const hostId = user.hostIds?.[0];
                if (!hostId) {
                    console.error("[getNodeIp] User has no hostIds[0]");
                    return null;
                }

                const params: any = {
                    aid: this.lapi.appId, ver: "last", version: "v2",
                    nodeid: hostId,
                };
                if (v4Only) params.v4only = "true";

                const ipResponse = await user.client.RunMApp("get_node_ips", params);
                if (!ipResponse) {
                    console.error(`[getNodeIp] No response for nodeId ${hostId}`);
                    return null;
                }

                // get_node_ips may return array, {data: array|string}, or a bare string.
                let ipList: string[] = [];
                if (Array.isArray(ipResponse)) ipList = ipResponse;
                else if (typeof ipResponse === 'string') ipList = [ipResponse];
                else if (typeof ipResponse === 'object' && Array.isArray(ipResponse.data)) ipList = ipResponse.data;
                else if (typeof ipResponse === 'object' && typeof ipResponse.data === 'string') ipList = [ipResponse.data];
                else {
                    console.error(`[getNodeIp] Invalid response for nodeId ${hostId}:`, ipResponse);
                    return null;
                }

                const ipAddresses = ipList
                    .map(ip => ip.trim())
                    .filter(ip => {
                        if (!ip) return false;
                        // Filter IPv6 (brackets or multiple colons) when v4Only.
                        if (v4Only && (ip.includes('[') || (ip.match(/:/g) || []).length > 1)) return false;
                        // Skip local and VPN-only addresses.
                        return !this.isLocalIP(ip) && !isTailscaleAddress(ip);
                    });

                if (ipAddresses.length === 0) {
                    console.error(`[getNodeIp] No valid IPs for nodeId ${hostId}`);
                    return null;
                }

                // Race all candidates in parallel (matches iOS _getHostIP withTaskGroup).
                // Return the first IP that passes a health check; cancel the rest.
                const candidates = ipAddresses.slice(0, 4);
                const winner = await new Promise<string | null>((resolve) => {
                    let settled = 0;
                    for (const ip of candidates) {
                        this.isServerHealthyWithTimeout(ip, 5000).then(healthy => {
                            if (healthy) { resolve(ip); return; }
                            if (++settled === candidates.length) resolve(null);
                        }).catch(() => {
                            if (++settled === candidates.length) resolve(null);
                        });
                    }
                });

                if (winner) {
                    console.log(`[getNodeIp] ✅ First healthy IP for nodeId ${hostId}:`, winner);
                    return winner;
                }
                console.error(`[getNodeIp] All health checks failed for nodeId ${hostId}`);
                return null;

            } catch (error) {
                console.error(`[getNodeIp] Error for nodeId ${user.hostIds?.[0] || 'unknown'}:`, error);
                return null;
            }
        },

        /**
         * Resolves the writable host IP for a user by resolving hostIds[0] to an IP,
         * matching iOS User.resolveWritableUrl(). File uploads must use this host
         * rather than the user's cached providerIp (which may point to a read-only node).
         * Result is cached on user.writableHostIp.
         */
        async resolveWritableHostIp(user: User): Promise<string> {
            const hostId = user.hostIds?.[0]
            if (!hostId) {
                throw new Error('Upload server not configured: user has no hostIds[0]')
            }

            const TTL = 5 * 60 * 1000 // 5 minutes
            const cached = this._writableHostCache.get(hostId)
            if (cached && Date.now() < cached.expiresAt) {
                user.writableHostIp = cached.ip
                return cached.ip
            }

            const ip = await this.getNodeIp(user)
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
                const uploadIp = await this.resolveWritableHostIp(user)
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
            const { mid: registeredMid, user: registeredBlob, followerProviderIp } = parseRegisterSuccessUser(ret)
            if (registeredMid) {
                void this._autoFollowDefaultUsersAfterRegister(
                    registeredMid,
                    registeredBlob,
                    followerProviderIp,
                )
            } else {
                console.warn("[register] No user.mid in registration response; skipping default followings auto-follow")
            }
            return true
        },

        /**
         * After successful registration, follow `VITE_DEFAULT_FOLLOWINGS` as the new account (same list
         * as iOS `Gadget.getAlphaIds()` after register).
         * @param followerProviderIp from register payload (baseUrl/writableUrl); fallback: entry `hostIP` (same node as register RPC).
         */
        _autoFollowDefaultUsersAfterRegister(
            registeredUserId: MimeiId,
            registeredUserBlob?: any,
            followerProviderIp?: string,
        ) {
            void (async () => {
                const ids = defaultFollowingIdsFromEnv()
                if (ids.length === 0) return

                const ip =
                    (followerProviderIp && followerProviderIp.trim()) ||
                    (this.lapi.hostIP && String(this.lapi.hostIP).trim()) ||
                    ''
                if (ip && isTailscaleAddress(ip)) {
                    console.warn("[register:autoFollow] Ignoring Tailscale provider IP hint", ip)
                }
                const usableIp = ip && !isTailscaleAddress(ip)
                    ? ip
                    : ((this.lapi.hostIP && String(this.lapi.hostIP).trim() && !isTailscaleAddress(String(this.lapi.hostIP).trim()))
                        ? String(this.lapi.hostIP).trim()
                        : '')
                if (!usableIp) {
                    console.warn("[register:autoFollow] No provider IP hint or entry hostIP; cannot auto-follow")
                    return
                }

                // Seed cache so later getUser skips a failing get_provider_ips for the new mid (short race window).
                if (
                    registeredUserBlob &&
                    typeof registeredUserBlob === 'object' &&
                    registeredUserBlob.mid === registeredUserId &&
                    Array.isArray(registeredUserBlob.hostIds) &&
                    registeredUserBlob.hostIds.length > 0
                ) {
                    const seeded = { ...registeredUserBlob, mid: registeredUserId, providerIp: usableIp }
                    delete (seeded as any).password
                    delete (seeded as any).client
                    sessionStorage.setItem(registeredUserId, JSON.stringify(seeded))
                }

                // Same as `toggleFollowing`: follower's node — use known IP from register response or entry node.
                const followerClient = createPooledClient(usableIp, this.lapi.connectionPool)
                followerClient.timeout = 120000

                for (const followingId of ids) {
                    try {
                        const target = await this.getUser(followingId)
                        if (!target) {
                            console.warn(`[register:autoFollow] User not found, skip: ${followingId}`)
                            continue
                        }
                        const toggled = await followerClient.RunMApp("toggle_following", {
                            aid: this.appId,
                            ver: "last",
                            version: "v2",
                            followingid: followingId,
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
            let writeClient = user.client
            try {
                const writableIp = await this.resolveWritableHostIp(user)
                writeClient = createPooledClient(writableIp, this.lapi.connectionPool)
            } catch (e) {
                console.warn('[updateProfile] Could not resolve writable host, using current client:', e)
            }
            const originalTimeout = writeClient.timeout
            writeClient.timeout = 15000
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
            sessionStorage.setItem("user", JSON.stringify(user))

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
            let writeClient = user.client
            try {
                const writableIp = await this.resolveWritableHostIp(user)
                writeClient = createPooledClient(writableIp, this.lapi.connectionPool)
            } catch (e) {
                console.warn('[updateAgentPublicKey] Could not resolve writable host, using current client:', e)
            }
            const originalTimeout = writeClient.timeout
            writeClient.timeout = 15000
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
            sessionStorage.setItem("user", JSON.stringify(user))

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
            let writeClient = user.client
            try {
                const writableIp = await this.resolveWritableHostIp(user)
                writeClient = createPooledClient(writableIp, this.lapi.connectionPool)
            } catch (e) {
                console.warn('[setUserAvatar] Could not resolve writable host, using current client:', e)
            }
            const originalTimeout = writeClient.timeout
            writeClient.timeout = 15000
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

            // Avatar display uses user.providerIp (read host), not the writable host.
            const displayIp = user.providerIp || user.writableHostIp
            const updatedUser = { ...user, avatar: this.getMediaUrl(confirmedAvatar, `http://${displayIp}`) }
            this._user = updatedUser
            sessionStorage.setItem("user", JSON.stringify(updatedUser))

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
            let writeClient = user.client
            try {
                const writableIp = await this.resolveWritableHostIp(user)
                writeClient = createPooledClient(writableIp, this.lapi.connectionPool)
            } catch (e) {
                console.warn('[deleteAccount] Could not resolve writable host, using current client:', e)
            }
            const originalTimeout = writeClient.timeout
            writeClient.timeout = 15000
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
