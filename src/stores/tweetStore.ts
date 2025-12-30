import { defineStore } from 'pinia';
import { useLeitherStore } from './leitherStore';
import { useAlertStore } from './alert.store';
import { createPooledClient } from '@/utils/clientProxy';
import { normalizeMediaType } from '@/lib';
const GUEST_ID = "000000000000000000000000000"
const TWEET_COUNT = 30

export const useTweetStore = defineStore('tweetStore', {
    state: () => ({
        tweets: [] as Tweet[],      // tweets 
        originalTweets: [] as Tweet[],
        users: new Map<MimeiId, User>(),
        _followings: [] as MimeiId[],
        lapi: useLeitherStore(),
        appId: import.meta.env.VITE_MIMEI_APPID,
        installApk: import.meta.env.VITE_APP_PKG,
        _user: null as User | null,      // login user data
        healthCheckCache: new Map<string, {isHealthy: boolean, timestamp: number}>(), // Cache health check results
        healthCheckInProgress: new Map<string, Promise<boolean>>() // Track ongoing health checks
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
                state._followings = import.meta.env.VITE_DEFAULT_FOLLOWINGS.split(",")
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
                // load author's tweets
                return await this.loadTweetsByUser(authorId, pageNumber, pageSize)
            } else {
                if (this.loginUser) {
                    // load tweets from all the followings of login user.
                    return await this.getTweetFeed(this.loginUser, pageNumber, pageSize)  
                } else {
                    // load admin's tweets
                    return await this.loadTweetsByUser(this.followings[0], pageNumber, pageSize)
                }
            }
        },
        /**
         * Processes and enriches tweet data with author information and media URLs
         * @param tweets Array of tweets to process and add to the store
         */
        async addTweetToStore(tweet: Tweet) {
            try {
                // skip tweet that is in this.tweets already.
                if (this.tweets.find(e => e.mid == tweet.mid))
                    return
                
                let author = await this.getUser(tweet.authorId)
                if (!author) {
                    console.warn("Author not found for tweet:", tweet.mid, "authorId:", tweet.authorId)
                    return
                }
                
                tweet.comments = []     // load comments only on detail page
                tweet.author = author
                tweet.provider = author.providerIp
                
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
                        const originalTweet = this.originalTweets.find(t => t.mid == tweet.originalTweetId)
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
  Original Tweet ID: ${tweet.originalTweetId}
  Original Author ID: ${tweet.originalAuthorId}
  Possible causes: 
    - Original tweet was deleted
    - Original tweet is private/restricted
    - Backend failed to include original tweet in response
    - Network/provider node is unreachable
  Note: This reduces visible tweet count and may affect pagination`)
                            return
                        }
                    } catch (error) {
                        console.error(`[addTweetToStore] ❌ ERROR fetching original tweet:
  Retweet ID: ${tweet.mid}
  Original Tweet ID: ${tweet.originalTweetId}
  Error:`, error)
                        // Skip this tweet if original tweet cannot be fetched
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
            } catch (error) {
                console.error("Error in getTweetReady for tweet:", tweet.mid, error)
                throw error; // Re-throw to let caller handle it
            }
        },

        /**
         * Loads tweets for a specific user by rank/popularity
         * @param userId The user ID whose tweets to load
         * @param pageNumber page number to load (0-based)
         * @param pageSize number of tweets per page
         * @returns the number of tweets loaded.
         */
        async loadTweetsByUser(
            userId: string,
            pageNumber: number = 0,
            pageSize: number = 10
        ): Promise<number | null> {
            let user = await this.getUser(userId)
            if (!user)
                return null

            try {
                const params = {
                    aid: this.appId,
                    ver: "last",
                    userid: user.mid,
                    pn: pageNumber,
                    ps: pageSize,
                    appuserid: this.loginUser?.mid ? this.loginUser?.mid : GUEST_ID,
                }

                console.log("Fetching tweets for user", user.mid, "page:", pageNumber, "size:", pageSize)
                const response = await user.client.RunMApp("get_tweets_by_user", params)
                console.log("Tweets response:", response)

                // Check success status first
                const success = response?.success
                if (success !== true) {
                    const errorMessage = response?.message || "Unknown error occurred"
                    console.error("Tweets loading failed for user", user.mid, ":", errorMessage)
                    console.error("Response:", response)
                    return null
                }

                // Extract tweets and originalTweets from the new response format
                const tweetsData = response.tweets
                const originalTweetsData = response.originalTweets

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

                if (tweetsData) {
                    for (const tweetJson of tweetsData) {
                        if (tweetJson != null) {
                            const tweet = tweetJson as Tweet
                            const cachedTweet = this.tweets.find(t => t.mid === tweet.mid)
                            if (!cachedTweet) {
                                try {
                                    await this.addTweetToStore(tweet)
                                } catch (error) {
                                    console.error("Error processing tweet:", tweet.mid, error)
                                }
                            }
                        }
                    }
                }
                return tweetsData?.length || null
            } catch (e) {
                console.error("Error fetching tweets for user:", user.mid)
                console.error("Exception:", e)
                return null
            }
        },

        async updateOriginalTweets(originalTweetsData: any) {
            for (const originalTweetJson of originalTweetsData) {
                if (originalTweetJson != null) {
                    try {
                        const originalTweet = originalTweetJson as Tweet
                        if (!this.originalTweets.find(t => t.mid === originalTweet.mid)) {
                            const author = await this.getUser(originalTweet.authorId)
                            if (author) {
                                originalTweet.author = author
                                this.originalTweets.push(originalTweet)
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
            let pinnedTweets = [] as Tweet[]
            let user = await this.getUser(userId)
            if (!user)
                return []

            const params = {
                aid: this.appId,
                ver: "last",
                userid: userId,
                appuserid: this.loginUser?.mid ? this.loginUser?.mid : GUEST_ID
            }
            let pinned = await user.client.RunMApp("get_pinned_tweets", params)
            console.log("Pinned tweets", pinned)
            
            // Validate that pinned is an array
            if (!Array.isArray(pinned)) {
                console.warn("Pinned tweets response is not an array:", typeof pinned, pinned)
                return []
            }
            
            if (pinned.length > 0) {
                // Create an array to store tweets with their pin timestamps for sorting
                const tweetsWithPinTime: Array<{tweet: Tweet, pinTimestamp: number}> = []
                
                for (const e of pinned) {
                    try {
                        const tweetObject = e.tweet
                        const pinTimestamp = e.timestamp ? Number(e.timestamp) : 0
                        
                        console.log("Processing pinned tweet:", tweetObject.mid, "pinned at:", pinTimestamp)
                        
                        // Validate tweet object
                        if (!tweetObject || !tweetObject.mid) {
                            console.warn("Invalid tweet object:", tweetObject)
                            continue
                        }

                        // Check if tweet is already in cache
                        let existingTweet = this.tweets.find(t => t.mid == tweetObject.mid)
                        if (existingTweet) {
                            // Update existing tweet with pin timestamp info
                            tweetsWithPinTime.push({tweet: existingTweet, pinTimestamp})
                        } else {
                            // Ensure the tweet has a proper author object
                            if (!tweetObject.author || typeof tweetObject.author !== 'object') {
                                try {
                                    // Try to get the author from the tweet's authorId
                                    const author = await this.getUser(tweetObject.authorId)
                                    if (author) {
                                        tweetObject.author = author
                                    } else {
                                        console.warn("Could not fetch author for pinned tweet:", tweetObject.mid)
                                        continue
                                    }
                                } catch (error) {
                                    console.error("Error fetching author for pinned tweet:", tweetObject.mid, error)
                                    continue
                                }
                            }
                            
                            // Add new tweet to cache and pinned list
                            this.tweets.push(tweetObject)
                            tweetsWithPinTime.push({tweet: tweetObject, pinTimestamp})
                            console.log("Successfully added pinned tweet to cache:", tweetObject.mid)
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

                // Process main tweets
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
                                } else {
                                    const cachedTweet = this.tweets.find(t => t.mid === tweet.mid)
                                    if (!cachedTweet) {
                                        await this.addTweetToStore(tweet)
                                    }
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
                    hostid: this.loginUser.hostId
                }

                console.log("Calling update_following_tweets with params:", params)
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

                // Process main tweets (exactly like getTweetFeed)
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
                                } else {
                                    const cachedTweet = this.tweets.find(t => t.mid === tweet.mid)
                                    if (!cachedTweet) {
                                        await this.addTweetToStore(tweet)
                                    }
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
            console.log("Get tweet", tweet)
            if (!tweet ) {
                // Author node has not data, try to load the tweet by id alone from some other provider.
                tweet = await this.fetchTweet(tweetId, undefined, useRacing)
                if (!tweet) return null
            }

            if (tweet?.originalTweetId) {
                // Original tweets don't use racing (loaded after main tweet)
                tweet.originalTweet = await this.fetchTweet(tweet.originalTweetId, tweet.originalAuthorId, false)
                if (!tweet.originalTweet) {
                    tweet.originalTweet = await this.fetchTweet(tweet.originalTweetId, undefined, false)
                    if (!tweet.originalTweet) { 
                        console.info("Missing originalTweet", tweet)
                        return null
                    }
                }
            }
            sessionStorage.setItem(tweetId, JSON.stringify(tweet))
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
            let cachedTweet = this.tweets.find(e => e.mid == tweetId)
            if (cachedTweet) {
                console.log(`[fetchTweet] ✅ Cache HIT (in-memory): ${tweetId} - No fetch needed!`)
                return cachedTweet
            }

            if (sessionStorage.getItem(tweetId)) {
                console.log(`[fetchTweet] ✅ Cache HIT (sessionStorage): ${tweetId} - No fetch needed!`)
                let t = JSON.parse(sessionStorage.getItem(tweetId)!)
                t.author.client = createPooledClient(t.author.providerIp, this.lapi.connectionPool)  // hprose client cannot be serielized.
                return t
            }

            console.log(`[fetchTweet] ⚠️ Cache MISS: ${tweetId} - Will fetch (useRacing: ${useRacing})`)
            // Get IP address of the provider of this tweet
            let author, providerClient, providerIp, tweetInDB
            if (authorId && !useRacing) {
                // Use authorId only when NOT racing (for faster racing, skip this branch)
                author = await this.getUser(authorId)
                if (!author)
                    return null
                providerIp = author?.providerIp
                providerClient = author?.client
                // With authodId, we can get most up to date tweet record.
                tweetInDB = await providerClient.RunMApp("refresh_tweet", {
                    aid: this.lapi.appId,
                    ver: "last",
                    tweetid: tweetId,
                    appuserid: this.loginUser?.mid ? this.loginUser?.mid : GUEST_ID,
                    userid: authorId,     // author of the tweet
                    hostid: author?.hostId,
                })
            } else {
                if (useRacing) {
                    // TweetDetail page: Get multiple provider IPs and race them for faster loading
                    // Using only tweetId (ignoring authorId) is faster because:
                    // 1. No need to fetch user first (blocks racing)
                    // 2. Can start racing immediately
                    // 3. User is fetched after race completes
                    console.log('[fetchTweet TIMING] Starting race for tweet:', tweetId, new Date().toISOString())
                    const providerIps = await this.getProviderIps(tweetId)
                    if (providerIps.length === 0)
                        return null
                    
                    // Race the API calls with multiple IPs
                    const raceResult = await this.raceProviderIps(providerIps, async (ip, client) => {
                        return await client.RunMApp("get_tweet", {
                            aid: this.lapi.appId,
                            ver: "last",
                            tweetid: tweetId,
                            appuserid: this.loginUser?.mid ? this.loginUser?.mid : GUEST_ID
                        })
                    })
                    
                    if (!raceResult) {
                        console.error("[fetchTweet] All provider IPs failed for tweet", tweetId);
                        return null;
                    }
                    
                    tweetInDB = raceResult.result;
                    providerIp = raceResult.ip;
                    providerClient = await this.lapi.getClient(providerIp);
                    console.log('[fetchTweet TIMING] ✅ Tweet data received from race:', new Date().toISOString());
                } else {
                    // Normal flow: Get single provider IP (old behavior)
                    providerIp = await this.getProviderIp(tweetId)
                    if (!providerIp)
                        return null
                    providerClient = await this.lapi.getClient(providerIp)
                    // Get tweet data from Tweet App Mimei. Its definition is different from this app.
                    tweetInDB = await providerClient.RunMApp("get_tweet", {
                        aid: this.lapi.appId,
                        ver: "last",
                        tweetid: tweetId,
                        appuserid: this.loginUser?.mid ? this.loginUser?.mid : GUEST_ID
                    })
                }
            }
            console.log("Get tweet from db", tweetInDB, providerIp, author)
            if (!tweetInDB)
                return null
            console.log('[fetchTweet TIMING] Fetching author data...', new Date().toISOString())
            author = author ? author : await this.getUser(tweetInDB.authorId)
            console.log('[fetchTweet TIMING] ✅ Author data received:', new Date().toISOString())
            // convert Tweet App's definition to this app's definition.
            let tweet = {
                mid: tweetInDB.mid,
                authorId: author!.mid,
                timestamp: tweetInDB.timestamp,
                author: author!,
                title: tweetInDB.title,
                content: tweetInDB.content,
                attachments: tweetInDB.attachments?.map((e: MimeiFileType) => {
                    e.mid = this.getMediaUrl(e.mid, "http://" + author?.providerIp)
                    e.downloadable = tweetInDB.downloadable
                    return e
                }),
                comments: [],
                originalTweetId: tweetInDB.originalTweetId,
                originalAuthorId: tweetInDB.originalAuthorId,
                provider: providerIp,
                likeCount: tweetInDB.likeCount,
                bookmarkCount: tweetInDB.bookmarkCount,
                commentCount: tweetInDB.commentCount,
            }
            console.log('[fetchTweet TIMING] ✅ Complete tweet object constructed:', new Date().toISOString())
            sessionStorage.setItem(tweetInDB.mid, JSON.stringify(tweet))
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

            // Try to get user with retry mechanism
            let providerIp: string | null = null
            let user: any = null
            let providerClient: any = null
            
            // First attempt
            try {
                providerIp = await this.getProviderIp(userId)
                console.log("Get user provider IP (first attempt)", providerIp)
                if (!providerIp) {
                    console.warn("No provider found for user", userId)
                    return
                }
                
                providerClient = createPooledClient(providerIp, this.lapi.connectionPool)
                
                user = await providerClient.RunMApp("get_user", {
                    aid: this.appId, 
                    ver: "last", 
                    version: "v3",
                    userid: userId,
                })
                
                console.log("get_user result (first attempt):", user)
            } catch (error) {
                console.error("First attempt to get user failed:", error)
                user = null
            }
            
            // If first attempt failed (user is null or not valid), retry with refreshed providerIP
            if (!user || typeof user !== 'object' || !user.mid || !user.hostIds) {
                console.log("First attempt failed, retrying with refreshed providerIP...")
                
                try {
                    // Refresh providerIP by calling getProviderIp again
                    providerIp = await this.getProviderIp(userId)
                    console.log("Get user provider IP (retry attempt)", providerIp)
                    
                    if (!providerIp) {
                        console.warn("No provider found for user on retry", userId)
                        return undefined
                    }
                    
                    providerClient = createPooledClient(providerIp, this.lapi.connectionPool)
                    
                    user = await providerClient.RunMApp("get_user", {
                        aid: this.appId, 
                        ver: "last", 
                        version: "v3",
                        userid: userId,
                    })
                    
                    console.log("get_user result (retry attempt):", user)
                } catch (error) {
                    console.error("Retry attempt to get user failed:", error)
                    return undefined
                }
            }
            
            // Validate user object
            if (!user || typeof user !== 'object' || !user.mid || !user.hostIds) {
                console.error("get_user returned invalid User object after retry:", user)
                return undefined
            }
            
            // cache the user data
            user.providerIp = providerIp
            user.hostId = user.hostIds[0]
            // Use server's cloudDrivePort if available
            // IMPORTANT: Use nullish coalescing (??) to allow 0 as a valid value (meaning no service)
            // If cloudDrivePort is not set by server, it remains undefined (no backend service)
            user.cloudDrivePort = user.cloudDrivePort ?? user.clouddriveport
            sessionStorage.setItem(userId, JSON.stringify(user))
            user.client = providerClient
            user.avatar = this.getMediaUrl(user.avatar, `http://${providerIp}`)
            delete user.baseUrl
            delete user.writableUrl
            this.users.set(userId, user)
            
            return user
        },
        
        /**
         * Remove a user from cache and session storage
         * @param userId The user ID to remove
         */
        removeUser(userId: MimeiId) {
            this.users.delete(userId)
            sessionStorage.removeItem(userId)
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
        async isServerHealthy(ip: string): Promise<boolean> {
            const now = Date.now();
            const cacheTTL = 30 * 60 * 1000; // 30 minutes cache
            
            // Check if we have a recent cached result
            const cached = this.healthCheckCache.get(ip);
            if (cached && (now - cached.timestamp) < cacheTTL) {
                console.log(`[isServerHealthy] Using cached result for ${ip}: ${cached.isHealthy ? 'healthy' : 'unhealthy'}`);
                return cached.isHealthy;
            }
            
            // Check if a health check is already in progress for this IP
            const inProgress = this.healthCheckInProgress.get(ip);
            if (inProgress) {
                console.log(`[isServerHealthy] Health check already in progress for ${ip}, waiting...`);
                return await inProgress;
            }
            
            // Start a new health check
            const healthCheckPromise = (async () => {
                try {
                    const baseUrl = `http://${ip}`;
                    
                    // Make a simple HEAD request to check if server is alive
                    const controller = new AbortController();
                    const timeoutId = setTimeout(() => controller.abort(), 3000); // 3 second timeout for HEAD request
                    
                    const response = await fetch(baseUrl, {
                        method: 'HEAD',
                        signal: controller.signal,
                        mode: 'no-cors', // Allow cross-origin requests
                    }).catch(() => null);
                    
                    clearTimeout(timeoutId);
                    
                    // For no-cors mode, we just check if the request completed without error
                    // If we get here without exception, the server is reachable
                    const isHealthy = response !== null;
                    
                    // Cache the result
                    this.healthCheckCache.set(ip, { isHealthy, timestamp: Date.now() });
                    
                    console.log(`[isServerHealthy] Server ${ip} is ${isHealthy ? 'reachable' : 'not reachable'}`);
                    return isHealthy;
                } catch (error) {
                    console.error(`[isServerHealthy] Health check error for ${ip}:`, error);
                    // Cache negative result
                    this.healthCheckCache.set(ip, { isHealthy: false, timestamp: Date.now() });
                    return false;
                } finally {
                    // Remove from in-progress map
                    this.healthCheckInProgress.delete(ip);
                }
            })();
            
            // Store the promise so other callers can wait for it
            this.healthCheckInProgress.set(ip, healthCheckPromise);
            
            return await healthCheckPromise;
        },

        /**
         * Check if a server is healthy with a timeout
         * @param ip The IP address (with optional port) to check
         * @param timeout Timeout in milliseconds (default: 10000ms = 10s)
         * @returns True if server is healthy within timeout, false otherwise
         */
        async isServerHealthyWithTimeout(ip: string, timeout: number = 10000): Promise<boolean> {
            return Promise.race([
                this.isServerHealthy(ip),
                new Promise<boolean>((resolve) => {
                    setTimeout(() => resolve(false), timeout);
                })
            ]);
        },

        /**
         * Get provider IP for a user with health checking
         * Calls get_provider_ips API and tests IPs in pairs with 10-second timeout
         * @param mid User's member ID
         * @param v4only If true, filter out IPv6 addresses. Default is true.
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

            // Create promises for each IP
            const racePromises = ips.map(async (ip) => {
                try {
                    console.log(`[raceProviderIps] Trying IP: ${ip}`);
                    const client = await this.lapi.getClient(ip);
                    const result = await apiCall(ip, client);
                    console.log(`[raceProviderIps] ✅ Success with IP: ${ip}`);
                    return { result, ip };
                } catch (error) {
                    console.warn(`[raceProviderIps] ❌ Failed with IP: ${ip}`, error);
                    // Return a never-resolving promise so race continues with other IPs
                    return new Promise<{ result: T, ip: string }>(() => {});
                }
            });

            try {
                // Race all promises, return first successful result
                const winner = await Promise.race(racePromises);
                return winner;
            } catch (error) {
                console.error(`[raceProviderIps] All IPs failed:`, error);
                return null;
            }
        },

        /**
         * Get a single provider IP for a given mid (returns first available)
         * @param mid The mid to get provider IP for
         * @param v4only Whether to filter out IPv6 addresses (default: false)
         * @returns A single IP address, or null if none found
         */
        async getProviderIp(mid: string, v4only: boolean = false): Promise<string | null> {
            const ips = await this.getProviderIps(mid, v4only);
            return ips.length > 0 ? ips[0] : null;
        },

        /**
         * Get the first pair of provider IPs for a given mid without testing them
         * @param mid The mid to get provider IPs for
         * @param v4only Whether to filter out IPv6 addresses (default: false)
         * @returns Array of IP addresses (up to 2), or empty array if none found
         */
        async getProviderIps(mid: string, v4only: boolean = false): Promise<string[]> {
            try {
                console.log(`[getProviderIps] Getting provider IPs for ${mid} (v4only: ${v4only})...`);
                
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
                
                const ipResponse = await this.lapi.client.RunMApp("get_provider_ips", params);
                
                console.log(`[getProviderIps] Raw response from get_provider_ips for ${mid}:`, ipResponse);
                
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
                        if (v4only) {
                            // Filter out IPv6 addresses (they contain [ ] brackets or multiple colons)
                            if (ip.includes('[') || ip.includes(']')) return false;
                            // Count colons - IPv6 has multiple colons, IPv4 with port has only one
                            const colonCount = (ip.match(/:/g) || []).length;
                            if (colonCount > 1) return false;
                        }
                        
                        return true;
                    });
                
                if (ipAddresses.length === 0) {
                    console.error("[getProviderIps] No valid IPs returned for", mid);
                    return [];
                }
                
                // Return first 2 IPs without testing them
                const resultIps = ipAddresses.slice(0, 2);
                console.log(`[getProviderIps] Returning ${resultIps.length} IP address(es) for ${mid}:`, resultIps);
                return resultIps;
                
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
            if (!tweet || !tweet.provider) return
            let client = tweet.author.client
            let comments = await client.RunMApp("get_comments", {
                aid: this.lapi.appId,
                ver: "last",
                tweetid: tweet.mid,
                appuserid: this.loginUser?.mid ? this.loginUser?.mid : GUEST_ID,
                pn: 0,
                ps: 20
            }) as any[]
            
            // comment type is a different Tweet type from the definition in this app
            if (comments) {
                for (const e of comments) {
                    try {
                        // Skip null or invalid comments
                        if (!e || !e.mid || !e.authorId) {
                            console.warn("Skipping invalid comment:", e)
                            continue
                        }
                        
                        let author = await this.getUser(e.authorId)
                        if (author) {
                            tweet.comments?.push({
                                mid: e.mid,
                                authorId: e.authorId,
                                author: author,
                                content: e.content,
                                timestamp: e.timestamp,
                                attachments: e.attachments?.filter((a: MimeiFileType | null) => a !== null && a !== undefined)
                                    .map((a: MimeiFileType) => {
                                        // comments on the same node as the tweet.
                                        if (a.mid && tweet.provider) {
                                            a.mid = this.getMediaUrl(a.mid, "http://" + tweet.provider)
                                        }
                                        return a
                                    }),
                            })
                        }
                    } catch (error) {
                        console.error("Error processing comment:", e?.mid || "unknown", error)
                        continue
                    }
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
                        this.removeUser(userId)
                        sessionStorage.removeItem(userId)
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
                    // Set timeout for login API call (15 seconds for faster failure detection)
                    const originalTimeout = user.client.timeout
                    user.client.timeout = 15000  // 15 seconds
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
                        /**
                         * Now find the IP of a host where user has write permission
                         */
                        if (user.hostId) {
                            console.log(`[login] Getting writable host IP for user (hostId: ${user.hostId})`);
                            // Try to get writable host IP with timeout
                            const ipPromise = this.getNodeIp(user, true)
                            const timeoutPromise = new Promise<string | null>((resolve) => {
                                setTimeout(() => resolve(null), 10000) // 10 second timeout
                            })
                            const ip = await Promise.race([ipPromise, timeoutPromise])
                            console.log(`[login] Writable host IP: ${ip}`)
                            if (!ip) {
                                // Retry on IP fetch failure (could be network issue)
                                if (attempt < maxRetries) {
                                    console.warn(`Login attempt ${attempt + 1} failed: No writable host found. Retrying...`)
                                    lastError = new Error("No writable host found")
                                    // Clear user cache to force fresh IP on next attempt
                                    this.removeUser(userId)
                                    await this.delay(1000 * (attempt + 1)) // Exponential backoff: 1s, 2s
                                    continue
                                }
                                console.error("No writable host found for user after all retries", user)
                                throw new Error("No writable host found. The server may be temporarily unavailable. Please try again later.")
                            }
                            user.providerIp = ip
                            sessionStorage.setItem("user", JSON.stringify(user))
                            user.client = createPooledClient(ip, this.lapi.connectionPool)
                            this._user = user
                            this.addFollowing(userId)
                            console.log(`[login] Login flow completed successfully for ${username}`);
                            useAlertStore().success("Login successful!")
                            return user
                        } else {
                            console.error("Login failed: User has no host ID", user)
                            throw new Error("User account configuration error. Please contact support.")
                        }
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
            this.$reset
        },
        /**
         * Gets the list of followers for a specific user
         * @param userId The user ID to get followers for
         * @returns Array of follower user IDs
         */
        async getFollowers(userId: MimeiId) {
            let user = await this.getUser(userId)
            if (!user)
                return []
            let list = await user.client.RunMApp("get_followers_sorted", {aid: this.appId, ver: "last", userid: userId})
            return list.sort((a: any, b: any) => b["value"] - a["value"]).slice(0, 50).map((e: any) => e["field"])
        },
        /**
         * Gets the list of users that a specific user is following
         * @param userId The user ID to get followings for
         * @returns Array of following user IDs
         */
        async getFollowings(userId: MimeiId) {
            let user = await this.getUser(userId)
            if (!user)
                return []
            let list = await user.client.RunMApp("get_followings_sorted", {aid: this.appId, ver: "last", userid: userId})
            return list.sort((a: any, b: any) => b["value"] - a["value"]).slice(0, 50).map((e: any) => e["field"])
        },

        /**
         * Deletes a tweet from the system
         * @param tweetId The ID of the tweet to delete
         * @param authorId The ID of the tweet author
         */
        async deleteTweet(tweetId: MimeiId, authorId: MimeiId) {
            this.tweets.splice(this.tweets.findIndex(e=>e.mid==tweetId), 1)
            let user = await this.getUser(authorId)
            if (user) {
                await this.loginUser?.client.RunMApp("delete_tweet", {aid: this.appId, ver: "last",
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
            if (!this.loginUser || (this.loginUser.mid !== commentAuthorId && this.loginUser.mid !== parentAuthorId)) {
                console.error("Unauthorized: Only comment author or parent tweet author can delete comments")
                return
            }

            // Get parent tweet author's client (comments are stored on the same node as the tweet)
            let parentAuthor = await this.getUser(parentAuthorId)
            if (!parentAuthor || !parentAuthor.client) {
                console.error("Failed to get parent tweet author's client for deleting comment")
                return
            }
            
            if (!parentAuthor.hostId) {
                console.error("Parent tweet author's hostId is missing")
                return
            }

            // Call delete_comment API with proper parameters matching server expectations
            await parentAuthor.client.RunMApp("delete_comment", {
                aid: this.appId,
                ver: "last",
                appuserid: this.loginUser.mid,  // User requesting deletion (comment author or parent tweet author)
                tweetid: parentTweetId,         // ID of tweet containing the comment
                commentid: commentId,            // ID of comment to delete
                hostid: parentAuthor.hostId      // Node ID where the tweet is hosted
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
            const parentTweet = this.tweets.find(t => t.mid === parentTweetId)
            if (parentTweet) {
                removeCommentFromTweet(parentTweet)
            }

            // Also check originalTweets array in case it's displayed as a retweet
            const originalTweet = this.originalTweets.find(t => t.mid === parentTweetId)
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
        async uploadTweet(tweet: any, tweetId: MimeiId) {
            console.log('[TWEET-STORE] Starting uploadTweet...');
            console.log('[TWEET-STORE] Tweet data:', {
                authorId: tweet.authorId,
                title: tweet.title,
                contentLength: tweet.content?.length || 0,
                attachmentsCount: tweet.attachments?.length || 0,
                isPrivate: tweet.isPrivate,
                downloadable: tweet.downloadable,
                tweetId: tweetId
            });
            
            var ret: any
            const originalTimeout = this.loginUser?.client.timeout
            
            // Use longer timeout for tweet upload (Leither service may be busy after video processing)
            const effectiveTimeout = 5 * 60 * 1000 // 5 minutes
            console.log('[TWEET-STORE] Using timeout:', effectiveTimeout / (60 * 1000), 'minutes');
            
            try {
                // Set timeout for this operation
                this.loginUser!.client.timeout = effectiveTimeout
                
                // Create a timeout promise to handle long-running operations
                const timeoutPromise = new Promise((_, reject) => {
                    setTimeout(() => {
                        const timeoutMinutes = Math.round(effectiveTimeout / (60 * 1000))
                        const timeoutHours = Math.round(effectiveTimeout / (60 * 60 * 1000))
                        const timeoutText = timeoutHours > 0 ? `${timeoutHours} hours` : `${timeoutMinutes} minutes`
                        reject(new Error(`Tweet upload timeout after ${timeoutText}. This may be due to extensive video processing on the backend.`))
                    }, effectiveTimeout)
                })
                
                // Create the upload promise
                const uploadPromise = (async () => {
                    if (tweetId) {
                        console.log('[TWEET-STORE] Calling add_comment API...');
                        // Fetch parent tweet to get its author's hostId
                        const parentTweet = await this.getTweet(tweetId);
                        if (!parentTweet || !parentTweet.author?.hostId) {
                            throw new Error('Failed to fetch parent tweet or parent tweet author hostId');
                        }
                        const parentAuthorHostId = parentTweet.author.hostId;
                        console.log('[TWEET-STORE] Using parent tweet author hostId:', parentAuthorHostId);
                        return await this.loginUser?.client.RunMApp("add_comment",
                            {aid: this.appId, ver: "last", tweetid: tweetId, comment: JSON.stringify(tweet), userid: this.loginUser?.mid, hostid: parentAuthorHostId}
                        )
                    } else {
                        console.log('[TWEET-STORE] Calling add_tweet API...');
                        return await this.loginUser?.client.RunMApp("add_tweet",
                            {aid: this.appId, ver: "last", tweet: JSON.stringify(tweet),
                                hostid: this.loginUser?.hostId})
                    }
                })()
                
                // Race between upload and timeout
                console.log('[TWEET-STORE] Starting Promise.race between upload and timeout...');
                ret = await Promise.race([uploadPromise, timeoutPromise])
                console.log('[TWEET-STORE] Promise.race completed, result:', ret);
                
            } catch (error) {
                console.error('[TWEET-STORE] Upload failed:', error);
                console.error(`Upload ${tweetId ? 'comment' : 'tweet'} failed:`, error)
                throw error
            } finally {
                // Restore original timeout
                this.loginUser!.client.timeout = originalTimeout
                console.log('[TWEET-STORE] Restored original timeout');
            }
            
            console.log(`Upload ${tweetId ? 'comment' : 'tweet'} result:`, tweetId, ret)
                
            // Check if the backend returned null, indicating failure
            if (ret === null || ret === undefined || !ret.success) {
                const errorMessage = ret?.message || 'Unknown error occurred during tweet upload'
                throw new Error(errorMessage);
            }
            return ret.mid
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

            const hproseClient = await this.lapi.getClient(ip)
            let file = await hproseClient.RunMApp("get_shared_file", {
                aid: this.lapi.appId,
                ver: "last",
                mid: mid
            })

            const sharingUser = await this.getUser(file.userId)
            // Cloud port is the file server port on the same node.
            console.log("Sharing user", sharingUser, file)
            file.url = `http://${ip0}:${sharingUser?.cloudDrivePort}`   // base url for the file
            console.log("Get shared file", file)
            return file
        },
        /**
         * Toggles the like status of a tweet
         * @param tweetId The ID of the tweet to toggle like for
         * @returns The updated tweet object
         */
        async toggleFavorite(tweetId: MimeiId) {
            var ret = await this.loginUser?.client.RunMApp("toggle_favorite", {
                aid: this.appId, ver: "last", appuserid: this.loginUser?.mid, tweetid: tweetId, authorid: this.tweets.find(e => e.mid == tweetId)?.authorId, userhostid: this.loginUser?.hostId
            })
            var tweet = this.tweets.find(e => e.mid == tweetId)
            tweet!.likeCount = ret["count"]
            localStorage.setItem(tweetId, JSON.stringify(tweet))
            return tweet
        },
        /**
         * Toggles the bookmark status of a tweet
         * @param tweetId The ID of the tweet to toggle bookmark for
         * @returns The updated tweet object
         */
        async toggleBookmark(tweetId: MimeiId) {
            var ret = await this.loginUser?.client.RunMApp("toggle_bookmark", {
                aid: this.appId, ver: "last", userid: this.loginUser?.mid, tweetid: tweetId, authorid: this.tweets.find(e => e.mid == tweetId)?.authorId, userhostid: this.loginUser?.hostId
            })
            var tweet = this.tweets.find(e => e.mid == tweetId)
            tweet!.bookmarkCount = ret["count"]
            localStorage.setItem(tweetId, JSON.stringify(tweet))
            return tweet
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
         * @returns true if the ip is of local network. Only allow port# between 8000 and 9000.
         */
        isLocalIP(ip: string) {
            const localPatterns = [
                /^127\./, // Loopback
                /^10\./, // Class A private
                /^192\.168\./, // Class C private
                /^172\.(1[6-9]|2[0-9]|3[0-1])\./ // Class B private
            ];

            // IPv6 local patterns
            const localIPv6Patterns = [
                /^::1$/, // IPv6 loopback
                /^fe80:/, // IPv6 link-local
                /^fc00:/, // IPv6 unique local
                /^fd00:/, // IPv6 unique local
            ];

            const portRegex = /:(\d+)$/;
            const portMatch = ip.match(portRegex);

            if (portMatch) {
                const port = parseInt(portMatch[1], 10);
                if (port < 8000 || port > 9000) {
                    return true;
                }
            }

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
            
            const fetchWithTimeout = (url: string, timeout = 30000): Promise<any> => {
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
                }, 30000);
                
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
         * Gets the IP address list of a node, after removing local IPv4
         * Calls get_node_ips with version=v2 which returns a list of IPs
         * @param user The user object containing client and hostId
         * @param v4Only Whether to filter out IPv6 addresses (default: false)
         * @returns The first non-local IP address found, or null if none available
         */
        async getNodeIp(
            user: User,
            v4Only = false
        ): Promise<string | null> {
            try {
                console.log(`[getNodeIp] Getting node IPs for nodeId ${user.hostId} (v4Only: ${v4Only})...`);
                
                // Call get_node_ips (plural) with version v2 to get list of IPs
                const params: any = {
                    aid: this.lapi.appId,
                    ver: "last",
                    version: "v2",
                    nodeid: user.hostId,
                };
                
                // Only add v4only parameter if true
                if (v4Only) {
                    params.v4only = "true";
                }
                
                const ipResponse = await user.client.RunMApp("get_node_ips", params);
                
                console.log(`[getNodeIp] Raw response from get_node_ips for nodeId ${user.hostId}:`, ipResponse);
                
                if (!ipResponse) {
                    console.error("[getNodeIp] No response from get_node_ips for nodeId", user.hostId);
                    return null;
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
                    console.error("[getNodeIp] Invalid response format from get_node_ips:", ipResponse);
                    return null;
                }
                
                // Filter and trim IP addresses, optionally removing IPv6 addresses
                const ipAddresses = ipList
                    .map(ip => ip.trim())
                    .filter(ip => {
                        if (ip.length === 0) return false;
                        
                        // If v4Only is true, filter out IPv6 addresses
                        if (v4Only) {
                            // Filter out IPv6 addresses (they contain [ ] brackets or multiple colons)
                            if (ip.includes('[') || ip.includes(']')) return false;
                            // Count colons - IPv6 has multiple colons, IPv4 with port has only one
                            const colonCount = (ip.match(/:/g) || []).length;
                            if (colonCount > 1) return false;
                        }
                        
                        return true;
                    });
                
                if (ipAddresses.length === 0) {
                    console.error("[getNodeIp] No valid IPs returned for nodeId", user.hostId);
                    return null;
                }
                
                // Return first IP address
                const resultIp = ipAddresses[0];
                console.log(`[getNodeIp] Returning IP address for nodeId ${user.hostId}:`, resultIp);
                return resultIp;
                
            } catch (error) {
                console.error("[getNodeIp] Error getting node IPs for nodeId", user.hostId, error);
                return null;
            }
        },

        /**
         * Extracts the IP address from a full address string (removes port)
         * @param address full ip address with port
         * @returns IP without port
         */
        getIpWithoutPort(address: string): string | null {
            const regex = /^(?:\[([0-9a-fA-F:]+)\]|([0-9.]+))(?::(\d+))?$/;
            const match = address.match(regex);
            if (match) {
                // If match[1] exists, it's IPv6, so return with brackets
                // If match[2] exists, it's IPv4, return as is
                let ip = match[1] ? `[${match[1]}]` : match[2];
                const port = match[3] ? parseInt(match[3], 10) : null; // Port number (or null if not present)
                return ip;
            }
            return null
        },
    },
});
