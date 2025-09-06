import { defineStore } from 'pinia';
import { useLeitherStore } from './leitherStore';
import { useAlertStore } from './alert.store';
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
        _user: null as User | null      // login user data
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
                usr.client = state.lapi.getClient(usr.providerIp)
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
                        return {
                            mid: this.getMediaUrl(e.mid, "http://" + author.providerIp),
                            type: e.type,
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
                            tweet.originalTweet = await this.fetchTweet(tweet.originalTweetId, tweet.originalAuthorId)
                        }
                        
                        // If originalTweetId exists but originalTweet is null, skip this tweet
                        if (!tweet.originalTweet) {
                            console.warn("Skipping tweet with missing original tweet:", tweet.mid, "originalTweetId:", tweet.originalTweetId)
                            return
                        }
                    } catch (error) {
                        console.error("Error fetching original tweet:", tweet.originalTweetId, error)
                        // Skip this tweet if original tweet cannot be fetched
                        console.warn("Skipping tweet due to original tweet fetch error:", tweet.mid)
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

                console.log("Fetching tweets for user:", user.mid, "page:", pageNumber, "size:", pageSize)
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

                // Cache original tweets first
                if (response.originalTweets) {
                    await this.updateOriginalTweets(response.originalTweets)
                }
                // Extract tweets from the new response format
                const tweetsData = response.tweets

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
         * Load tweets of a specific user by rank.
         * Handles null elements in the response list and preserves their positions.
         * @param user The user whose tweets to retrieve
         * @param pageNumber Page number for pagination (0-based)
         * @param pageSize Number of tweets per page
         * @returns Array of tweets with null elements preserved for pagination.
         */
        async getUserTweetsByPage(
            user: User,
            pageNumber: number,
            pageSize: number
        ): Promise<Tweet[] | null> {
            try {
                const params = {
                    aid: this.appId,
                    ver: "last",
                    userid: user.mid,
                    pn: pageNumber,
                    ps: pageSize,
                    appuserid: this.loginUser?.mid ? this.loginUser?.mid : GUEST_ID,
                }

                console.log("Fetching tweets for user:", user.mid, "page:", pageNumber, "size:", pageSize)
                const response = await user.client.RunMApp("get_tweets_by_user", params)

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

                // Cache original tweets first (same as getTweetFeed)
                if (originalTweetsData) {
                    for (const originalTweetJson of originalTweetsData) {
                        if (originalTweetJson != null) {
                            try {
                                const originalTweet = originalTweetJson as Tweet
                                const author = await this.getUser(originalTweet.authorId)
                                if (author) {
                                    originalTweet.author = author
                                    if (!this.originalTweets.find(t => t.mid === originalTweet.mid)) {
                                        this.originalTweets.push(originalTweet)
                                    }
                                }
                            } catch (e) {
                                console.error("Error caching original tweet:", e)
                            }
                        }
                    }
                }

                const result = tweetsData?.map((tweetJson: any) => {
                    // If the element is null, keep it as null
                    if (tweetJson == null) {
                        return null
                    } else {
                        // Try to decode the tweet
                        try {
                            const tweet = tweetJson as Tweet
                            tweet.author = user
                            return tweet
                        } catch (e) {
                            console.error("Error decoding tweet:", e)
                            return null
                        }
                    }
                }) || null
                return result
            } catch (e) {
                console.error("Error fetching tweets for user:", user.mid)
                console.error("Exception:", e)
                return null
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
            authorId: MimeiId | undefined = undefined
        ): Promise<Tweet | null> {
            let tweet = await this.fetchTweet(tweetId, authorId)
            console.log("Get tweet", tweet)
            if (!tweet ) {
                // Author node has not data, try to load the tweet by id alone from some other provider.
                tweet = await this.fetchTweet(tweetId)
                if (!tweet) return null
            }

            if (tweet?.originalTweetId) {
                tweet.originalTweet = await this.fetchTweet(tweet.originalTweetId, tweet.originalAuthorId)
                if (!tweet.originalTweet) {
                    tweet.originalTweet = await this.fetchTweet(tweet.originalTweetId)
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
         * @returns The tweet object or undefined if not found
         */
        async fetchTweet(
            tweetId: MimeiId,
            authorId: MimeiId | undefined = undefined
        ): Promise<Tweet | null> {
            // check if the tweet has been retrieved
            let cachedTweet = this.tweets.find(e => e.mid == tweetId)
            if (cachedTweet)
                return cachedTweet

            if (sessionStorage.getItem(tweetId)) {
                let t = JSON.parse(sessionStorage.getItem(tweetId)!)
                t.author.client = this.lapi.getClient(t.author.providerIp)  // hprose client cannot be serielized.
                return t
            }
            // Get IP address of the provider of this tweet
            let author, providerClient, providerIp, tweetInDB
            if (authorId) {
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
                providerIp = await this.getProviderIp(tweetId)
                if (!providerIp)
                    return null
                providerClient = this.lapi.getClient(providerIp)
                // Get tweet data from Tweet App Mimei. Its definition is different from this app.
                tweetInDB = await providerClient.RunMApp("get_tweet", {
                    aid: this.lapi.appId,
                    ver: "last",
                    tweetid: tweetId,
                    appuserid: this.loginUser?.mid ? this.loginUser?.mid : GUEST_ID
                })
            }
            console.log("Get tweet from db", tweetInDB, providerIp, author)
            if (!tweetInDB)
                return null
            author = author ? author : await this.getUser(tweetInDB.authorId)
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
            sessionStorage.setItem(tweetInDB.mid, JSON.stringify(tweet))
            return tweet
        },

        /**
         * Retrieves user data by user ID, caching the result
         * @param userId The user ID to retrieve data for
         * @returns The user object or undefined if not found
         */
        async getUser(userId: MimeiId): Promise<User | undefined> {
            // check if the user has been cached.
            if (this.loginUser && this.loginUser.mid == userId)
                return this.loginUser
            if (this.users.get(userId))
                return this.users.get(userId)

            let providerIp = await this.getProviderIp(userId)
            if (!providerIp) {
                console.warn("No provider found for user", userId)
                return
            }
            let providerClient = this.lapi.getClient(providerIp)

            let user = await providerClient.RunMApp("get_user", {
                aid: this.appId, ver: "last", userid: userId,
            })
            // cache the user data
            if (user) {
                user.providerIp = providerIp
                user.hostId = user.hostIds[0]
                user.cloudDrivePort = import.meta.env.VITE_CLOUD_DRIVE_PORT
                sessionStorage.setItem(userId, JSON.stringify(user))
                user.client = providerClient
                user.avatar = this.getMediaUrl(user.avatar, `http://${providerIp}`)
                delete user.baseUrl
                delete user.writableUrl
                this.users.set(userId, user)
            }
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
        async getProviderIp(mid: string): Promise<string | null> {
            let ip = await this.lapi.client.RunMApp("get_provider_ip", {
                aid: this.lapi.appId,
                ver: "last",
                mid: mid,
            })
            if (!ip) {
                console.error("No provider found for", mid)
                return null
            }
            return ip
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
                        let author = await this.getUser(e.authorId)
                        if (author) {
                            tweet.comments?.push({
                                mid: e.mid,
                                authorId: e.authorId,
                                author: author,
                                content: e.content,
                                timestamp: e.timestamp,
                                attachments: e.attachments?.map((a: MimeiFileType) => {
                                    // comments on the same node as the tweet.
                                    a.mid = this.getMediaUrl(a.mid, "http://" + tweet.provider)
                                    return a
                                }),
                            })
                        }
                    } catch (error) {
                        console.error("Error processing comment:", e.mid, error)
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
            try {
                // given username, get UserId
                let userId = await this.lapi.client.RunMApp("get_userid", {
                    aid: this.appId, ver: "last", username: username
                })
                
                if (!userId) {
                    console.error("Login failed: User not found", username)
                    useAlertStore().error("User not found. Please check your username.")
                    return
                }
                
                let user = await this.getUser(userId)
                console.log("Login user", user)
                if (!user) {
                    console.error("Login failed: Could not fetch user data", userId)
                    useAlertStore().error("Could not fetch user data. Please try again.")
                    return
                }
                
                let ret = await user.client.RunMApp("login", {
                    aid: this.appId, ver: "last", username: username, password: password
                })
                if (!ret) {
                    console.error("Login failed: Authentication failed", userId)
                    useAlertStore().error("Authentication failed. Please check your credentials.")
                    return
                }
                
                if (ret["status"] === 'success') {
                    /**
                     * Now find the IP of a host where user has write permission
                     */
                    if (user.hostId) {
                        const ip = await this.getNodeIp(user, true)
                        console.log("Host IP", ip)
                        if (!ip) {
                            console.error("No writable host found for user", ip, user)
                            useAlertStore().error("No writable host found for user. Please contact support.")
                            return
                        }
                        user.providerIp = ip
                        sessionStorage.setItem("user", JSON.stringify(user))
                        user.client = this.lapi.getClient(ip)
                        this._user = user
                        this.addFollowing(userId)
                        useAlertStore().success("Login successful!")
                        return user
                    } else {
                        console.error("Login failed: User has no host ID", user)
                        useAlertStore().error("User account configuration error. Please contact support.")
                        return
                    }
                } else {
                    console.error("Login failed", ret["reason"])
                    useAlertStore().error(ret["reason"] || "Login failed. Please check your credentials.")
                    return
                }
            } catch (error) {
                console.error("Login error:", error)
                useAlertStore().error("Login failed due to network error. Please try again.")
                return
            }
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
            var ret: any
            const originalTimeout = this.loginUser?.client.timeout
            
            // Use longer timeout for tweet upload (Leither service may be busy after video processing)
            const effectiveTimeout = 5 * 60 * 1000 // 5 minutes
            
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
                        return await this.loginUser?.client.RunMApp("add_comment",
                            {aid: this.appId, ver: "last", tweetid: tweetId, comment: JSON.stringify(tweet), userid: this.loginUser?.mid, hostid: this.loginUser?.hostId}
                        )
                    } else {
                        return await this.loginUser?.client.RunMApp("add_tweet",
                            {aid: this.appId, ver: "last", tweet: JSON.stringify(tweet),
                                hostid: this.loginUser?.hostId})
                    }
                })()
                
                // Race between upload and timeout
                ret = await Promise.race([uploadPromise, timeoutPromise])
                
            } catch (error) {
                console.error(`Upload ${tweetId ? 'comment' : 'tweet'} failed:`, error)
                throw error
            } finally {
                // Restore original timeout
                this.loginUser!.client.timeout = originalTimeout
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
         * @returns MimeiId of the install package
         */
        async uploadPackage(cid: string) {
            let mid = await this.loginUser?.client.RunMApp("upload_package", {
                aid: this.lapi.appId, ver: "last", cid: cid
            })
            return mid
        },
        /**
         * Upload a file to mm database, and add referrence to userId.
         * @param filename 
         * @returns mid of uploaded file
         */
        async uploadFile(cid: string, filename: string) {
            let mid = await this.loginUser?.client.RunMApp("upload_file", {
                aid: this.lapi.appId,
                ver: "last", 
                cid: cid,
                userid: this.loginUser?.mid
            })
            return mid
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

            const hproseClient = this.lapi.getClient(ip)
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
            return fetch(url) // Return the promise from fetch
                .then(response => {
                    if (!response.ok) {
                        throw new Error('Network response was not ok');
                    }
                    return response.blob(); // Convert the response to a Blob
                })
                .then(blob => {
                    const link = document.createElement('a');
                    link.href = window.URL.createObjectURL(blob);
                    link.download = 'tweet_install.apk';
                    document.body.appendChild(link);
                    link.click();
                    document.body.removeChild(link);
                })
                .catch(error => {
                    console.error('There was a problem with the fetch operation:', error);
                });
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
                console.error('No IP addresses provided in findFirstAccessibleIP()');
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
                            if (!response.ok) throw new Error('Network response was not ok');
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
         * @param nodeId The node ID to get IPs for
         * @returns The first non-local IP address found
         */
        async getNodeIp(
            user: User,
            v4Only = false
        ): Promise<string | null> {
            return await user.client.RunMApp("get_node_ip", {
                aid: this.lapi.appId,
                ver: "last",
                nodeid: user.hostId,
                v4only: v4Only ? "true" : "false"
            })
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
