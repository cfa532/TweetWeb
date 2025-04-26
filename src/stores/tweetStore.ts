import { defineStore } from 'pinia';
import { useLeitherStore } from './leitherStore';
import { useAlertStore } from './alert.store';
const GUEST_ID = "000000000000000000000000000"
const TWEET_COUNT = 30

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
         * Otherwise load tweets from all the followings of login user.
         * @param authorId 
         */
        async loadTweets(
            authorId: string | undefined = undefined,
            startRank: number = 0,
            endRank: number = startRank + TWEET_COUNT
        ) {
            if (authorId) {
                // load author's tweets
                this.loadTweetsByRank(authorId)
            } else {
                if (this.loginUser) {
                    // load tweets from all the followings 
                    let tweetFeed = await this.getTweetFeed(this.loginUser, startRank, endRank)  
                    console.log("Tweets of user", this.loginUser, tweetFeed, startRank, endRank)
                    if (!tweetFeed)
                        return
                    this.fillTweet(tweetFeed)
                } else {
                    // load admin's tweets
                    this.loadTweetsByRank(this.followings[0])
                }
            }
        },
        async fillTweet(tweets: Tweet[]) {
            // Tweet may not have its author data yet.
            tweets?.forEach(async tweet => {
                // skip tweet that is in tweets already.
                if (this.tweets.find(e => e.mid == tweet.mid))
                    return
                let author = await this.getUser(tweet.authorId)
                if (!author)
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
                        size: e.size,
                        aspectRatio: e.aspectRatio
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
                this.tweets.push(tweet);
            })
        },
        async loadTweetsByRank(
            authorId: string | undefined = undefined,
            startRank: number = 0,
            count: number = 10
        ) {
            let followings = authorId? [authorId] : this.followings
            followings.forEach(async (uid: string) => {
                let author = await this.getUser(uid)
                if (!author)
                    return
                let tweetsByUser = await this.getTweetListByRank(author, startRank, count)  
                console.log("Tweets of user", tweetsByUser, startRank, count)
                if (!tweetsByUser)
                    return
                this.fillTweet(tweetsByUser)
            })
        },
        /**
         * @returns get MimeiId list of pinned tweets of the user, then load the tweets.
         */
        async loadPinnedTweets(userId: string) {
            let pinnedTweets = [] as Tweet[]
            let user = await this.getUser(userId)
            if (!user)
                return
            let pinned = await user.client.RunMApp("get_top_tweets", {aid: this.appId, ver: "last", userid: userId})
            console.log("Pinned tweets", pinned)
            pinned?.forEach(async (e: any) => {
                let tweet = this.tweets.find(t => t.mid == e.tweetId)
                if (tweet) {
                    tweet.timestamp = Number(e.timestamp)
                    pinnedTweets.push(tweet)
                } else {
                    let t = await this.getTweet(e.tweetId, userId)
                    if (t) {
                        this.tweets.push(t)
                        t.timestamp = Number(e.timestamp)
                        pinnedTweets.push(t)
                    }
                }
            })
            return pinnedTweets
        },
        /**
         * @param user is login user.
         * @param startRank 
         * @param endRank 
         * @returns tweets of app`user's followings' tweets
         */
        async getTweetFeed(
            user: User,
            startRank: number,
            endRank: number
        ): Promise<Tweet[] | undefined> {
            let tweets = await user.client.RunMApp("get_tweet_feed", {
                aid: this.appId,
                ver: "last",
                userid: user.mid,
                start: startRank,
                end: endRank,
                gid: this.loginUser?.mid ? this.loginUser?.mid : GUEST_ID,
            })
            return tweets
        },
        /**
         * @param user 
         * @param startRank 
         * @param count 
         * @returns tweets of the given user
         */
        async getTweetListByRank(
            user: User,
            startRank: number,
            count: number
        ): Promise<Tweet[] | undefined> {
            let tweets = await user.client.RunMApp("get_tweets_by_rank", {
                aid: this.appId,
                ver: "last",
                userid: user.mid,
                start: startRank,
                end: startRank + count,
                gid: this.loginUser?.mid ? this.loginUser?.mid : GUEST_ID,
            })
            return tweets
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
            console.log("Get tweet", tweet)
            if (!tweet ) {
                // Author node has not data, try to load the tweet by id alone from some other provider.
                tweet = await this.fetchTweet(tweetId)
                if (!tweet) return
            }

            if (tweet?.originalTweetId) {
                tweet.originalTweet = await this.fetchTweet(tweet.originalTweetId, tweet.originalAuthorId)
                if (!tweet.originalTweet) {
                    tweet.originalTweet = await this.fetchTweet(tweet.originalTweetId)
                    if (!tweet.originalTweet) { 
                        console.info("Missing originalTweet", tweet)
                        return
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
            let author, providerClient, providerIp, tweetInDB
            if (authorId) {
                author = await this.getUser(authorId)
                if (!author)
                    return
                providerIp = author?.providerIp
                providerClient = author?.client
                // With authodId, we can get most up to date tweet record.
                tweetInDB = await providerClient.RunMApp("refresh_tweet", {
                    aid: this.lapi.appId,
                    ver: "last",
                    tweetid: tweetId,
                    appuserid: this.loginUser?.mid ? this.loginUser?.mid : GUEST_ID,
                    hostid: author?.hostId,
                    userid: authorId,     // author of the tweet
                })
            } else {
                providerIp = await this.getProviderIp(tweetId)
                if (!providerIp)
                    return
                providerClient = this.lapi.getClient(providerIp)
                // Get tweet data from Tweet App Mimei. Its definition is different from this app.
                tweetInDB = await providerClient.RunMApp("get_tweet", {
                    aid: this.lapi.appId,
                    ver: "last",
                    tweetid: tweetId,
                    userid: this.loginUser?.mid ? this.loginUser?.mid : GUEST_ID
                })
            }
            console.log("Get tweet from db", tweetInDB, providerIp, author)
            if (!tweetInDB)
                return
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

        async getUser(userId: MimeiId): Promise<User | undefined> {
            // check if the user has been cached.
            if (this.loginUser && this.loginUser.mid == userId)
                return this.loginUser
            if (this.users.get(userId))
                return this.users.get(userId)

            let providerIp = await this.getProviderIp(userId)
            if (!providerIp) {
                console.error("No provider found for user", userId)
                return
            }
            let providerClient = this.lapi.getClient(providerIp)

            let user = await providerClient.RunMApp("get_user_core_data", {
                aid: this.appId, ver: "last", userid: userId,
            })
            // cache the user data
            if (user) {
                user.providerIp = providerIp
                user.hostId = user.hostIds[0]
                sessionStorage.setItem(userId, JSON.stringify(user))
                user.client = providerClient
                user.avatar = this.getMediaUrl(user.avatar, `http://${providerIp}`)
                delete user.baseUrl
                delete user.writableUrl
                this.users.set(userId, user)
            }
            return user
        },

        // Given a mimie Id, find IP of its best provider
        async getProviderIp(mid: string): Promise<string | null> {
            let IPs = await this.lapi.client.RunMApp("get_providers", {
                aid: this.lapi.appId,
                ver: "last",
                mid: mid,
            })
            if (!IPs) {
                console.error("No provider found for", mid)
                return null
            }
            let ip = await this.findFirstAccessibleIP(IPs, this.lapi.appId)
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
                            // comments on the same node as tweet.
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
                return import.meta.env.VITE_APP_LOGO
            }
            return mid.length > 27 ? url + "/ipfs/" + mid : url + "/mm/" + mid
        },

        async login(username: string, password: string) {
            // given username, get UserId
            let userId = await this.lapi.client.RunMApp("get_userid", {
                aid: this.appId, ver: "last", username: username
            })
            let user = await this.getUser(userId)
            if (!user) {
                console.error("Login failed", userId, user)
                return
            }
            let ret = await user.client.RunMApp("login", {
                aid: this.appId, ver: "last", username: username, password: password
            })
            if (!ret) {
                console.error("Login failed", userId)
                useAlertStore().error("Login failed")
                return
            }
            if (ret["status"] === 'success') {
                /**
                 * Now find the IP of a host where user has write permission
                 */
                if (user.hostId) {
                    let hostIps: String = await this.lapi.client.RunMApp("get_node_ip", {
                        aid: this.appId, ver: "last", nodeid: user.hostId
                    })
                    let ip = await this.findFirstAccessibleIPv4(hostIps.trim().split(','), this.lapi.appId)
                    console.log("Host IPs", hostIps, ip)
                    if (!ip) {
                        console.error("No writable host found for user", hostIps, user)
                        useAlertStore().error(`No writable host found for user. ${hostIps} ${JSON.stringify(user)}`)
                        return
                    }
                    user.providerIp = ip
                    sessionStorage.setItem("user", JSON.stringify(user))
                    user.client = this.lapi.getClient(ip)
                    this._user = user
                    this.addFollowing(userId)
                    return user
                }
            } else {
                console.error("Login failed", ret["reason"])
                useAlertStore().error(ret["reason"])
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
            let list = await user.client.RunMApp("get_followers_sorted", {aid: this.appId, ver: "last", userid: userId})
            return list.sort((a: any, b: any) => b["value"] - a["value"]).slice(0, 50).map((e: any) => e["field"])
        },
        async getFollowings(userId: MimeiId) {
            let user = await this.getUser(userId)
            if (!user)
                return []
            let list = await user.client.RunMApp("get_followings_sorted", {aid: this.appId, ver: "last", userid: userId})
            return list.sort((a: any, b: any) => b["value"] - a["value"]).slice(0, 50).map((e: any) => e["field"])
        },

        async deleteTweet(tweetId: MimeiId, authorId: MimeiId) {
            this.tweets.splice(this.tweets.findIndex(e=>e.mid==tweetId), 1)
            let user = await this.getUser(authorId)
            if (user) {
                await this.loginUser?.client.RunMApp("delete_tweet", {aid: this.appId, ver: "last",
                    tweetid: tweetId, authorid: authorId
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
         * 
         * @param tweet a Tweet object to be uploaded
         * @param tweetId if none, a new tweet is created, otherwise a comment added to the tweetId
         * @returns a mid of the uploaded object
         */
        async uploadTweet(tweet: any, tweetId: MimeiId) {
            console.log("Upload tweet", tweetId, tweet)
            tweet.authorId = this.loginUser?.mid
            if (tweetId) {
                await this.loginUser?.client.RunMApp("add_comment",
                    {aid: this.appId, ver: "last", tweetid: tweetId, comment: JSON.stringify(tweet)}
                )
            } else {
                let t = await this.loginUser?.client.RunMApp("add_tweet",
                    {aid: this.appId, ver: "last", tweet: JSON.stringify(tweet),
                        hostid: this.loginUser?.hostId}
                    )
                console.log("New tweet mid", t)
                return t
            }
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
         * 
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
            let ip0 = this.splitIpAndPort(ip)
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
            const cloudPort = sharingUser?.cloudDrivePort ? sharingUser?.cloudDrivePort : 8010
            file.url = `http://${ip0}:${cloudPort}`   // base url for the file
            console.log("Get shared file", file)
            return file
        },
        async toggleFavorite(tweetId: MimeiId) {
            var ret = await this.loginUser?.client.RunMApp("toggle_likes", {
                aid: this.appId, ver: "last", tweetid: tweetId, userid: this.loginUser?.mid
            })
            var tweet = this.tweets.find(e => e.mid == tweetId)
            tweet!.likeCount = ret["count"]
            localStorage.setItem(tweetId, JSON.stringify(tweet))
            return tweet
        },
        async toggleBookmark(tweetId: MimeiId) {
            var ret = await this.loginUser?.client.RunMApp("toggle_bookmark", {
                aid: this.appId, ver: "last", tweetid: tweetId, userid: this.loginUser?.mid
            })
            var tweet = this.tweets.find(e => e.mid == tweetId)
            tweet!.bookmarkCount = ret["count"]
            localStorage.setItem(tweetId, JSON.stringify(tweet))
            return tweet
        },

        /**
         * Download file and return the data blob to web client.
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

            const portRegex = /:(\d+)$/;
            const portMatch = ip.match(portRegex);

            if (portMatch) {
                const port = parseInt(portMatch[1], 10);
                if (port < 8000 || port > 9000) {
                    return true;
                }
            }

            return localPatterns.some(pattern => pattern.test(ip));
        },

        isEmptyString(str?: String) {
            return str == null || str == undefined || str.trim() == '';
        },

        async findFirstAccessibleIP(ipList: string[], mid: string, filterIPv6 = false): Promise<string | null> {
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
        
        // The IPv4-specific function now just calls the main function with the filter flag
        async findFirstAccessibleIPv4(ipList: string[], mid: string): Promise<string | null> {
            return await this.findFirstAccessibleIP(ipList, mid, true);
        },

        /**
         * @param nodeId 
         * @returns IP address list of a node, after removing local IPv4
         */
        async getNodeIp(nodeId: MimeiId) {
            let ips = await this.loginUser?.client.RunMApp("get_node_ip", {
                aid: this.lapi.appId,
                ver: "last",
                nodeid: nodeId
            })
            for (let ip of ips) {
                if (!this.isEmptyString(ip) && !this.isLocalIP(ip)) {
                    return ip
                }
            }
        },
        /**
         * @param address full ip address with port
         * @returns IP without port
         */
        splitIpAndPort(address: string) {
            const regex = /^(?:\[([0-9a-fA-F:]+)\]|([0-9.]+))(?::(\d+))?$/;
            const match = address.match(regex);
            if (match) {
                // If match[1] exists, it's IPv6, so return with brackets
                // If match[2] exists, it's IPv4, return as is
                let ip = match[1] ? `[${match[1]}]` : match[2];
                const port = match[3] ? parseInt(match[3], 10) : null; // Port number (or null if not present)
                return ip;
            }
        },
    },
});
