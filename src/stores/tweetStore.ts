import { defineStore } from 'pinia';
import { useLeitherStore } from './leitherStore';
import { useAlertStore } from './alert.store';
const GUEST_ID = "000000000000000000000000000"
const THIRTY_DAYS = 25920000000

export const useTweetStore = defineStore('tweetStore', {
    state: () => ({
        tweets: [] as Tweet[],
        users: new Map<MimeiId, User>(),
        _followings: [] as MimeiId[],
        lapi: useLeitherStore(),
        appId: import.meta.env.VITE_MIMEI_APPID,
        installApk: import.meta.env.VITE_APP_PKG,
        _user: null as User | null      // login user data
    }),
    getters: {
        loginUser: (state): User | null => {
            if (state._user)
                return state._user
            if (sessionStorage.getItem("user")) {
                let usr = JSON.parse(sessionStorage.getItem("user")!)
                usr.client = state.lapi.getClient(usr.providerIp)
                state._user = usr
                return usr
            }
            return null
        },
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
        addFollowing(mid: string) {
            if (this.followings.indexOf(mid) == -1) {
                this._followings.push(mid)
                sessionStorage.setItem("followings", JSON.stringify(this._followings))
            }
        },

        /**
         * If an userId is given, load tweets of the given user.
         * Otherwise load tweets from all the followings.
         * @param authorId 
         */
        async loadTweets(authorId: string | undefined = undefined) {
            let followings = authorId? [authorId] : this.followings
            followings.forEach(async (uid: string) => {
                let author = await this.getUser(uid)
                if (!author)
                    return
                let tweetsByUser = await this.getTweetListByUser(author)
                if (!tweetsByUser)
                    return
                console.log("Tweets of user", tweetsByUser)

                // Tweet may not have its author data yet.
                tweetsByUser.forEach(async tweet => {
                    // skip tweet that is in tweets already.
                    if (this.tweets.find(e => e.mid == tweet.mid))
                        return
                    tweet.author = author
                    tweet.provider = author.providerIp
                    tweet.attachments = tweet.attachments?.map(e => {
                        return {
                            mid: this.getMediaUrl(e.mid, "http://" + author.providerIp),
                            type: e.type,
                            timestamp: e.timestamp,
                            fileName: e.fileName,
                            downloadable: tweet.downloadable,
                            size: e.size
                        }
                    })
                    tweet.comments = []     // load comments only on detail page

                    if (tweet?.originalTweetId) {
                        tweet.originalTweet = await this.fetchTweet(tweet.originalTweetId, tweet.originalAuthorId)
                        if (!tweet.originalTweet) {
                            return  // failed to find original tweet, exit.
                        }
                    }
                    sessionStorage.setItem(tweet.mid, JSON.stringify(tweet))

                    // add the tweets into right location of tweets
                    let index = this.tweets.findIndex(e => e.timestamp < tweet.timestamp);
                    if (index === -1) {
                        // If no smaller timestamp is found, push to the end
                        this.tweets.push(tweet);
                    } else {
                        // Insert the tweet at the found index
                        this.tweets.splice(index, 0, tweet);
                    }
                })
            })
        },

        async getTweetListByUser(user: User): Promise<Tweet[] | undefined> {
            return await user.client.RunMApp("get_tweets", {
                aid: this.appId,
                ver: "last",
                userid: user.mid,
                start: Date.now(),
                end: Date.now() - THIRTY_DAYS,
                gid: GUEST_ID      // visitor's mid. Placeholder
            })
        },

        /**
         * Given only tweet ID, find it full data. Do NOT load comments yet. Wait until user opens
         * detail tweet page.
         * @param tweetId 
         * @param authorId must be used to find the right node for the tweet, which refers to authorId
         * @returns a Tweet object short of comments.
         */
        async getTweet(tweetId: MimeiId, authorId: MimeiId | undefined = undefined): Promise<Tweet | undefined> {
            let tweet = await this.fetchTweet(tweetId, authorId)
            if (!tweet) return

            if (tweet?.originalTweetId) {
                tweet.originalTweet = await this.fetchTweet(tweet.originalTweetId, tweet.originalAuthorId)
                if (!tweet.originalTweet) {
                    console.info("Missing originalTweet", tweet)
                    return
                }
            }
            sessionStorage.setItem(tweetId, JSON.stringify(tweet))
            return tweet
        },

        /**
         * Given tweet ID, get its content. There are 2 steps. First, find provider of
         * this tweet with its ID. 2nd, retrieve the tweet from the provider. Assume
         * author data is also available on the provider. Get author data too.
         */
        async fetchTweet(tweetId: MimeiId, authorId: MimeiId | undefined = undefined): Promise<Tweet | undefined> {
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
            let author, providerClient, providerIp
            if (authorId) {
                author = await this.getUser(authorId)
                if (!author)
                    return
                providerIp = author?.providerIp
                providerClient = author?.client
            } else {
                providerIp = await this.getProviderIp(tweetId)
                if (!providerIp)
                    return
                providerClient = this.lapi.getClient(providerIp)
            }
            // Get tweet data from Tweet App Mimei. Its definition is different from this app.
            let tweetInDB = await providerClient.RunMApp("get_tweet", {
                aid: this.lapi.appId,
                ver: "last",
                tweetid: tweetId,
                userid: GUEST_ID,  // just a placeholder
            })
            console.log(tweetInDB, providerIp, author)
            if (!tweetInDB)
                return
            author = await this.getUser(tweetInDB.authorId)

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

        async getUser(userId: MimeiId): Promise<User | undefined> {
            // check if the user has been retrieved.
            if (this.loginUser && this.loginUser.mid == userId)
                return this.loginUser
            if (this.users.get(userId))
                return this.users.get(userId)

            let providerIp = await this.getProviderIp(userId)
            if (!providerIp)
                return
            let providerClient = this.lapi.getClient(providerIp)

            let user = await providerClient.RunMApp("get_user_core_data", {
                aid: this.appId, ver: "last", userid: userId,
            })
            // cache the user data
            if (user) {
                user.providerIp = providerIp
                sessionStorage.setItem(userId, JSON.stringify(user))
                user.client = providerClient
                user.avatar = this.getMediaUrl(user.avatar, `http://${providerIp}`)
                delete user.baseUrl
                delete user.writableUrl
                this.users.set(userId, user)
            }
            return user
        },

        async getFollowCount(userId: MimeiId) {
            let user = await this.getUser(userId)
            if (!user) return
            let f = await user.client.RunMApp("get_follow_count", {
                aid: this.appId, ver: "last", userid: user.mid,
            })
            user.followingCount = f["followingCount"]
            user.followerCount = f["followersCount"]
        },

        // Given a mimie Id, find IP of its best provider
        async getProviderIp(mid: string): Promise<string | null> {
            let IPs = await this.lapi.client.RunMApp("get_providers", {
                aid: this.lapi.appId,
                ver: "last",
                mid: mid,
            })
            // return import.meta.env.VITE_LEITHER_NODE
            let ip = await this.findFirstAccessibleIP(IPs,  this.lapi.appId)
            return ip
        },
        /**
         * Load comments of a tweet into its comments attribute. 
         * Comments are on the same node with the tweet.
         * @param tweet 
         */
        async loadComments(tweet: Tweet) {
            if (!tweet || !tweet.provider) return
            let client = tweet.author.client
            let comments = await client.RunMApp("get_comments", {
                aid: this.lapi.appId,
                ver: "last",
                tweetid: tweet.mid,
                userid: GUEST_ID,
            }) as any[]
            
            // comment type is a different Tweet type from the definition in this app
            comments.forEach(async e => {
                let author = await this.getUser(e.authorId)
                if (author) {
                    tweet.comments?.push({
                        mid: e.mid,
                        authorId: e.authorId,
                        author: author,
                        content: e.content,
                        timestamp: e.timestamp,
                        attachments: e.attachments?.map((a: MimeiFileType) => {
                            // comments on same node with tweet.
                            a.mid = this.getMediaUrl(a.mid, "http://" + tweet.provider)
                            return a
                        }),
                    })
                }
            })
            tweet.comments?.sort((a, b) => (b.timestamp as number) - (a.timestamp as number))
        },

        getMediaUrl(mid: string | undefined, baseUrl: string): string {
            let url = baseUrl
            if (!mid) {
                return "https://en.numista.com/catalogue/photos/essos/64a16406c47562.49601462-original.jpg"
            }
            return mid.length > 27 ? url + "/ipfs/" + mid : url + "/mm/" + mid
        },

        async login(username: string, password: string) {
            // given username, get UserId
            let userId = await this.lapi.client.RunMApp("get_userid", {
                aid: this.appId, ver: "last", username: username
            })
            let user = await this.getUser(userId)
            if (!user)
                return
            let ret = await user.client.RunMApp("login", {
                aid: this.appId, ver: "last", username: username, password: password
            })
            if (!ret) {
                useAlertStore().error("Login failed")
                return
            }
            if (ret["status"] == "success") {
                // now find the IP of a host where user has write permission
                if (user.hostIds && user.hostIds.length>0) {
                    let hostIps: String = await this.lapi.client.RunMApp("get_node_ip", {
                        aid: this.appId, ver: "last", nodeid: user.hostIds[0]
                    })
                    let ip = await this.findFirstAccessibleIP(hostIps.trim().split(','), this.lapi.appId)
                    if (!ip) return
                    
                    user.providerIp = ip
                    sessionStorage.setItem("user", JSON.stringify(user))
                    user.client = this.lapi.getClient(ip)
                    console.log("user", user)
                    this._user = user
                    this.addFollowing(userId)
                    return user
                }
            } else {
                useAlertStore().error(ret["reason"])
            }
        },
        async deleteTweet(tweetId: MimeiId, authorId: MimeiId) {
            this.tweets.splice(this.tweets.findIndex(e=>e.mid==tweetId), 1)
            let user = await this.getUser(authorId)
            if (user) {
                await user.client.RunMApp("delete_tweet", {aid: this.appId, ver: "last",
                    tweetid: tweetId, authorid: authorId
                })
            }
        },
        logout() {
            sessionStorage.clear()
            this.$reset
        },
        async getFollowers(userId: MimeiId) {
            let user = await this.getUser(userId)
            if (!user)
                return []
            return await user.client.RunMApp("get_followers", {aid: this.appId, ver: "last", userid: userId})
        },
        async getFollowings(userId: MimeiId) {
            let user = await this.getUser(userId)
            if (!user)
                return []
            return await user.client.RunMApp("get_followings", {aid: this.appId, ver: "last", userid: userId})
        },

        async openTempFile() {
            return await this.lapi.client.RunMApp("open_temp_file", {
                aid: this.appId, ver: "last"
            })
        },
        async uploadTweet(tweet: any) {
            let u = sessionStorage.getItem("user")
            if (!u) return null
            let user = JSON.parse(u) as User
            tweet.authorId = user.mid
            let t = await this.lapi.client.RunMApp("upload_tweet",
                { aid: this.appId, ver: "last", tweet: JSON.stringify(tweet) })
            return t
        },
        /**
         * Upload App upgrade package file.
         * @param cid IPFS id of the install package
         * @returns MimeiId of the install package
         */
        async uploadPackage(cid: string) {
            let mid = await this.lapi.client.RunMApp("upload_package", {
                aid: this.lapi.appId, ver: "last", cid: cid
            })
            return mid
        },
        /**
         * @param filename 
         * @returns 
         */
        async uploadFile(cid: string, filename: string) {
            let mid = await this.lapi.client.RunMApp("upload_file", {
                aid: this.lapi.appId,
                ver: "last", 
                cid: cid,
                userid: this.loginUser?.mid
            })
            return mid
        },
        /**
         * Download a downloadable App package and return the data blob to web client.
         */
        async downloadApk() {
            fetch(this.installApk)
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

        isLocalIP(ip: string) {
            const localPatterns = [
                /^127\./, // Loopback
                /^10\./, // Class A private
                /^192\.168\./, // Class C private
                /^172\.(1[6-9]|2[0-9]|3[0-1])\./ // Class B private
            ];

            return localPatterns.some(pattern => pattern.test(ip));
        },

        isEmptyString(str?: String) {
            return str == null || str == undefined || str.trim() == '';
        },
        async findFirstAccessibleIP(ipList: string[], mid: string) {
            if (!ipList || ipList.length < 1) {
                return null; // Return null immediately if the list is empty
            }
            const fetchWithTimeout = (url: string, timeout = 5000) => {
                return new Promise((resolve, reject) => {
                    const timer = setTimeout(() => reject(new Error('Request timed out')), timeout);
                    fetch(url)
                        .then(response => {
                            if (!response.ok) {
                                throw new Error('Network response was not ok');
                            }
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
            const promises = [] as any[]
            ipList.forEach(async ip => {
                if (this.isEmptyString(ip) || this.isLocalIP(ip))
                    return
                const url = `http://${ip}/getvar?name=mmversions&arg0=${mid}`;
                // console.log(`trying ${url}`);
                promises.push( fetchWithTimeout(url)
                    .then(data => ({ ip, data }))
                    .catch(error => {
                        console.log(`Error fetching from ${ip}`, error);
                        return null;
                    })
                );
            });
            while (promises.length > 0) {
                try {
                    const result = await Promise.race(promises);
                    if (result && result.data) {
                        return result.ip;
                    }
                    // Remove the resolved promise from the array
                    promises.splice(promises.indexOf(Promise.resolve(result)), 1);
                } catch (error) {
                    // Remove the rejected promise from the array
                    promises.splice(promises.indexOf(Promise.reject(error)), 1);
                }
            }
            return null; // No accessible IP found
        }
    },
});

