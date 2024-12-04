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
        _user: null as unknown
    }),
    getters: {
        loginUser: (state) => {
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

        // Load tweets of a list of followed User IDs
        async loadTweets(authorId: string | undefined = undefined) {
            let followings = authorId? [authorId] : this.followings
            followings.forEach(async (uid: string) => {
                let author = await this.getUser(uid)
                if (!author) return

                let tweetsByUser = await this.getTweetListByUser(author)
                console.log(tweetsByUser)
                if (!tweetsByUser || tweetsByUser.length == 0) return

                // Tweet may not have its author data yet.
                tweetsByUser.forEach(async tweet => {
                    // skip tweet that is in tweets already.
                    if (this.tweets.find(e => { e.mid == tweet.mid }))
                        return

                    tweet.author = author
                    tweet.provider = author.providerIp
                    tweet.attachments = tweet.attachments?.map(e => {
                        return {
                            mid: this.getMediaUrl(e.mid, "http://" + author.providerIp),
                            type: e.type
                        }
                    })
                    tweet.comments = []     // load comments only on detail page

                    if (tweet?.originalTweetId) {
                        let cachedTweet = sessionStorage.getItem(tweet?.originalTweetId)
                        if (cachedTweet) {
                            tweet.originalTweet = JSON.parse(cachedTweet)
                        } else {
                            let originTweet = await this.fetchTweet(tweet.originalTweetId)
                            tweet.originalTweet = originTweet
                            sessionStorage.setItem(originTweet?.mid!!, JSON.stringify(originTweet))
                        }
                    }
                    sessionStorage.setItem(tweet.mid, JSON.stringify(tweet))

                    // add the tweets into right location of tweets
                    let index = this.tweets.findIndex(e => { return e.timestamp!! < tweet.timestamp!! });
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
            console.log(user, this.appId)
            if (!user) return
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
         * @param authorId not used
         * @returns a Tweet object short of comments.
         */
        async getTweet(tweetId: string, authorId: string | undefined = undefined): Promise<Tweet | undefined> {
            let tweet = await this.fetchTweet(tweetId)
            if (!tweet) return

            if (tweet?.originalTweetId) {
                tweet.originalTweet = await this.fetchTweet(tweet.originalTweetId)
            }
            sessionStorage.setItem(tweetId, JSON.stringify(tweet))
            return tweet
        },

        /**
         * Given tweet ID, get its content. There are 2 steps. First, find provider of
         * this tweet with its ID. 2nd, retrieve the tweet from the provider. Assume
         * author data is also available on the provider. Get author data too.
         */
        async fetchTweet(tweetId: string): Promise<Tweet | undefined> {
            let cachedTweet = sessionStorage.getItem(tweetId)
            if (cachedTweet) {
                return JSON.parse(cachedTweet)
            }
            // Get IP address of the provider of this tweet
            let providerIp = await this.getProviderIp(tweetId)
            if (!providerIp) return
            let providerClient = this.lapi.getClient(providerIp)
            console.log("fetchTweet provider", providerIp)

            // Get tweet data from Mimei. Its definition is different from this app.
            let tweetInDB = await providerClient.RunMApp("get_tweet", {
                aid: this.lapi.appId,
                ver: "last",
                tweetid: tweetId,
                userid: GUEST_ID,  // just a placeholder
            })
            if (!tweetInDB) return

            // get author data of the tweet.
            let author = await this.getUser(tweetInDB.authorId)
            if (!author) return

            let tweet = {
                mid: tweetInDB.mid,
                timestamp: tweetInDB.timestamp,
                author: author,
                title: tweetInDB.title,
                content: tweetInDB.content,
                attachments: tweetInDB.attachments?.map((e: MimeiFileType) => {
                    e.mid = this.getMediaUrl(e.mid, "http://" + providerIp)
                    return e
                }),
                comments: [],
                originalTweetId: tweetInDB.originalTweetId,
                originalAuthorId: tweetInDB.originalAuthorId,
                provider: providerIp,
                likeCount: tweetInDB.likeCount,
                bookmarkCount: tweetInDB.bookmarkCount,
                commentCount: tweetInDB.commentCount
            }
            sessionStorage.setItem(tweetInDB.mid, JSON.stringify(tweet))
            return tweet
        },

        async getUser(userId: string): Promise<User | undefined> {
            // check if the user has been retrieved.
            if (this.loginUser && this.loginUser.mid == userId)
                return this.loginUser
            if (this.users.get(userId))
                return this.users.get(userId)

            let providerIp = await this.getProviderIp(userId)
            if (!providerIp)
                return
            let providerClient = this.lapi.getClient(providerIp)
            console.log("getUser() provider", providerIp)
            let user = await providerClient.RunMApp("get_user_core_data", {
                aid: this.appId,
                ver: "last",
                userid: userId,
            })
            // cache the user data
            if (user) {
                user.providerIp = providerIp
                // user.avatar = this.getMediaUrl(user.avatar, "http://" + providerIp)
                sessionStorage.setItem(userId, JSON.stringify(user))
                user.client = providerClient
                delete user.baseUrl
                delete user.writableUrl
                this.users.set(userId, user)
            }
            return user
        },

        // Given a mimie Id, find IP of its best provider
        async getProviderIp(mid: string): Promise<string | null> {
            let IPs = await this.lapi.client.RunMApp("get_provider", {
                aid: this.lapi.appId,
                ver: "last",
                mid: mid,
            })
            // return import.meta.env.VITE_LEITHER_NODE
            let ip = await this.findFirstAccessibleIP(IPs,  this.lapi.appId)
            return ip
        },

        async loadComments(tweet: Tweet) {
            if (!tweet || !tweet.provider) return

            let client = this.lapi.getClient(tweet.provider)
            let comments = await client.RunMApp("get_comments", {
                aid: this.lapi.appId,
                ver: "last",
                tweetid: tweet.mid,
                userid: GUEST_ID,
            }) as any[]
            
            // comment type is a different Tweet type from the definition in this app
            comments.sort((a, b) => b.timestamp - a.timestamp)
            comments.forEach(async e => {
                let author = await this.getUser(e.authorId)
                if (author) {
                    tweet.comments?.push({
                        mid: e.mid,
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

        logout() {
            sessionStorage.clear()
            this.$reset
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
         * 
         * @param cid IPFS id of the install package
         * @returns Mimei id of the install package
         */
        async uploadPackage(cid: string) {
            let mid = await this.lapi.client.RunMApp("upload_package", {
                aid: this.lapi.appId, ver: "last", cid: cid
            })
            return mid
        },
        async uploadAttachment(cid: string, filename: string) {
            let mid = await this.lapi.client.RunMApp("upload_attachment", {
                aid: this.lapi.appId, ver: "last", cid: cid,
                userid: this.followings[0], filename: filename
            })
            return mid
        },
        async downloadApk() {
            let mid = await this.lapi.client.RunMApp("download_upgrade", {
                aid: this.lapi.appId, ver: "last"
            }
            )
            if (!mid) return
            let ip = await this.getProviderIp(mid)
            if (!ip) return
            let url = mid.length > 27 ? "http://" + ip + "/ipfs/" + mid : "http://" + ip + "/mm/" + mid
            console.log(url)
            fetch(url)
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
            const fetchWithTimeout = (url: string, timeout = 1000) => {
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

