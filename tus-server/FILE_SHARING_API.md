# File Upload and Sharing Backend

This backend keeps the existing TUS upload flow and adds a file registry, IPFS conversion state, share links, and gated downloads.

## Flow

1. Client uploads bytes through `POST/PATCH /upload`.
2. Client calls `POST /files/register` with the final TUS upload URL.
3. Server renames the uploaded blob into a regular file under `tus-server/uploads`.
4. Server records the file in `.tweetweb-files.json`.
5. Server queues background IPFS conversion with `Leither ipfs add <file>`.
6. Client polls `GET /files/:id/status` until `file.ipfs.status` is `ready`.
7. Client creates a share link with `POST /files/:id/share`.
8. Downloader opens `/download?cid=<cid>&sid=<shareId>&mid=<optionalMid>`.

Uploads are resumable through the TUS protocol. IPFS conversion is processed by a bounded queue controlled with `IPFS_CONVERSION_CONCURRENCY` and unfinished queued/processing jobs are resumed when the server starts.

## Endpoints

### Register Uploaded File

`POST /files/register`

Body:

```json
{
  "uploadUrl": "http://host:3000/upload/<upload-id>",
  "filename": "video.mp4",
  "filetype": "video/mp4",
  "mid": "optional-user-mid",
  "sutro": "optional-share-metadata"
}
```

Response includes the local file id and initial IPFS status:

```json
{
  "id": "<upload-id>",
  "name": "video.mp4",
  "size": 12345,
  "type": "video/mp4",
  "url": "/files/<upload-id>.mp4",
  "ipfs": {
    "status": "queued",
    "cid": null,
    "error": null
  }
}
```

### File Status

`GET /files/:id/status`

Returns the persisted file record. `file.ipfs.status` is one of `queued`, `processing`, `ready`, or `failed`.

### Create Share From Registered File

`POST /files/:id/share`

Body:

```json
{
  "domain": "https://share.example.com",
  "password": "optional",
  "expiresAt": "2026-06-16T00:00:00.000Z",
  "expiresInSeconds": 86400,
  "maxDownloads": 10,
  "mid": "optional-user-mid",
  "sutro": "optional-share-metadata"
}
```

Response:

```json
{
  "success": true,
  "url": "https://share.example.com/download?cid=<cid>&sid=<shareId>&mid=<mid>",
  "share": {
    "id": "<shareId>",
    "cid": "<cid>",
    "passwordRequired": true,
    "expiresAt": "2026-06-16T00:00:00.000Z",
    "maxDownloads": 10,
    "downloadCount": 0
  }
}
```

### Create Share Directly From CID

`POST /shares`

Use this when the client already has an IPFS CID. The same password, expiration, download-limit, `mid`, and `sutro` options are supported.

### Public Share Metadata

`GET /shares/:id`

Returns public metadata without the password hash.

### Public Download

`GET /download?cid=<cid>&sid=<shareId>&mid=<optionalMid>&password=<optionalPassword>`

`HEAD /download?cid=<cid>&sid=<shareId>&mid=<optionalMid>`

The server validates the share rules and supports resumable downloads:

- `Range` and `If-Range` request headers are accepted.
- Local registered files are streamed directly from disk with `206 Partial Content`.
- Gateway fallback redirects by default, or proxies when `proxy=true` or `SHARE_GATEWAY_FALLBACK=proxy`.
- The first validated `GET` creates a download session, sets a `tw_dl_<shareId>` cookie, and returns `X-Download-Token`.
- Resume requests can use the cookie, `dt=<token>`, or `X-Download-Token`.
- A resume session does not increment `downloadCount` again.

If local content is not available and gateway proxying is disabled, the server redirects to:

```text
${IPFS_GATEWAY || "https://ipfs.io/ipfs"}/<cid>
```

Use `redirect=false` to receive JSON containing the resolved gateway URL instead of a redirect.

## Scalability Notes

- File bytes are never buffered in memory for upload or local download paths.
- TUS stores upload chunks/files on disk, so interrupted uploads can continue.
- Local downloads use streams and byte ranges.
- IPFS conversion concurrency is bounded by `IPFS_CONVERSION_CONCURRENCY`.
- JSON registries are enough for a single node or shared disk deployment. For multi-writer clusters, keep the route contract and replace `fileRegistry.js` with Redis, Postgres, or another shared metadata store that supports atomic counters and locks.
