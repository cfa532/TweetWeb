# dTweet Community Notice

The dTweet community is supported by hardware and bandwidth contributed by its users. Every registered user can publish up to 5 original posts using shared community resources. To publish more, set up your own serving node to host your posts.

The following instructions describe how to set up a basic serving node.

1. Set up a server running Linux, macOS, or Windows.

2. Install the Leither service, which combines all participating servers into one cloud service:        https://github.com/cfa532/Leither/blob/main/README_EN.md
    Leither runs on port 4800 by default. The recommended port for dTweet community is any number above 8000.

3. Enter the Leither installation directory and run the following command to synchronize the dTweet server app to your server:
    ./Leither mimei sync heWgeGkeBX2gaENbIBS_Iy1mdTS

4. Get the `tus-server` code from https://github.com/cfa532/TweetWeb, upload it to your server, and run it as a service. In the `tus-server` `.env` file, the default setting is `port=8081`. Choose a suitable port and allow it through your firewall. This port is the `cloudDrivePort` of your user profile. After setup is complete, you can publish any number of posts hosted by your own hardware and bandwidth.