# dTweet 社区提示

dTweet 社区由用户贡献的硬件和带宽共同支持。每个注册用户都可以使用社区共享资源发布最多 5 条原创帖子。若要发布更多帖子，请搭建自己的服务节点来托管帖子。

以下说明介绍如何搭建一个基础服务节点。

1. 准备一台运行 Linux、macOS 或 Windows 的服务器。

2. 安装 Leither 服务。Leither 会将所有参与的服务器组合成一个云服务：
    https://github.com/cfa532/Leither/blob/main/README_EN.md
    Leither 默认使用 4800 端口。对于 dTweet 社区，建议使用 8000 以上的端口。

3. 进入 Leither 的安装目录，运行以下命令，将 dTweet 的服务端应用同步到你的服务器：  
    ./Leither mimei sync heWgeGkeBX2gaENbIBS_Iy1mdTS
 
4. 从 https://github.com/cfa532/TweetWeb 获取 `tus-server` 代码，上传到你的服务器并配置为系统服务。在 `tus-server` 的 `.env` 文件中，默认配置为 `port=8081`。请选择合适的端口并在防火墙中放行。该端口即你用户资料中的 `cloudDrivePort`。完成配置后，你就可以发布任意数量、由你自己的硬件和带宽托管的帖子。
