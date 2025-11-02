# HLS Video CORS Requirements

## Overview

When HLS videos are served from IPFS, the IPFS gateway must send proper CORS (Cross-Origin Resource Sharing) headers to allow video players to load segments from a different origin.

## CORB Error

If you encounter the error:
```
Cross-Origin Read Blocking (CORB) blocked a cross-origin response. segment000.ts
```

This indicates that the IPFS gateway server is not sending the required CORS headers.

## Required CORS Headers

The IPFS gateway server (e.g., running on port 8080) must send the following headers for HLS segments:

```
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET, HEAD, OPTIONS
Access-Control-Allow-Headers: Range, Content-Type
Access-Control-Expose-Headers: Content-Range, Content-Length, Accept-Ranges
```

### For Video Segments (.ts files):
- `Access-Control-Allow-Origin: *` (or specific origin)
- `Access-Control-Allow-Methods: GET, HEAD, OPTIONS`
- `Access-Control-Allow-Headers: Range` (critical for HTTP range requests)

### For Playlists (.m3u8 files):
- Same headers as segments
- Additional: `Content-Type: application/vnd.apple.mpegurl` or `application/x-mpegURL`

## Gateway Configuration

### If using IPFS Gateway directly:

Configure your IPFS gateway to send CORS headers. For example, if using `go-ipfs`:

1. Set CORS headers in the gateway configuration
2. Or use a reverse proxy (nginx, caddy) to add CORS headers

### Nginx Reverse Proxy Example

```nginx
location /ipfs/ {
    proxy_pass http://localhost:8080/ipfs/;
    
    # CORS headers for HLS
    add_header 'Access-Control-Allow-Origin' '*' always;
    add_header 'Access-Control-Allow-Methods' 'GET, HEAD, OPTIONS' always;
    add_header 'Access-Control-Allow-Headers' 'Range, Content-Type' always;
    add_header 'Access-Control-Expose-Headers' 'Content-Range, Content-Length, Accept-Ranges' always;
    
    # Handle OPTIONS preflight
    if ($request_method = 'OPTIONS') {
        add_header 'Access-Control-Allow-Origin' '*';
        add_header 'Access-Control-Allow-Methods' 'GET, HEAD, OPTIONS';
        add_header 'Access-Control-Allow-Headers' 'Range, Content-Type';
        add_header 'Access-Length' 0;
        add_header 'Content-Type' 'text/plain';
        return 204;
    }
}
```

### Caddy Reverse Proxy Example

```
handle /ipfs/* {
    reverse_proxy localhost:8080 {
        header_up Host {host}
        header_up X-Real-IP {remote}
    }
    
    header Access-Control-Allow-Origin "*"
    header Access-Control-Allow-Methods "GET, HEAD, OPTIONS"
    header Access-Control-Allow-Headers "Range, Content-Type"
    header Access-Control-Expose-Headers "Content-Range, Content-Length, Accept-Ranges"
}
```

## Testing CORS Headers

You can test if CORS headers are being sent using curl:

```bash
curl -I -H "Origin: http://your-frontend-domain.com" \
     http://125.229.161.122:8080/ipfs/QmVD5gvRmmz4C3hS7Wnztei3bPYph4CXdcowEbrpoMSMZ1/segment000.ts
```

Look for `Access-Control-Allow-Origin` in the response headers.

## Alternative Solution

If you cannot configure the IPFS gateway CORS headers, you can:

1. **Use a proxy**: Serve IPFS content through your own Express server with CORS middleware
2. **Same-origin serving**: Serve HLS content from the same origin as your frontend
3. **Use a CORS-enabled IPFS gateway**: Use a public gateway that already supports CORS (like `ipfs.io` or `gateway.pinata.cloud`)

## Notes

- The CORS configuration must be on the **server serving the IPFS content** (port 8080 in your case), not on the Node.js application server (port 3000)
- HTTP Range requests are essential for video streaming - ensure `Range` is in `Access-Control-Allow-Headers`
- Some browsers may cache CORS responses - clear browser cache if headers were recently added

