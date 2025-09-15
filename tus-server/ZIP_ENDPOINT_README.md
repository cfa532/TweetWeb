# ZIP Processing Endpoint

This document describes the new `/process-zip` endpoint that allows uploading ZIP files containing HLS content and converting them to IPFS files.

## Overview

The ZIP processing endpoint takes a ZIP file containing HLS (HTTP Live Streaming) content, extracts it, validates the HLS structure, and then uploads the extracted content to IPFS using the Leither service. This is similar to the video conversion endpoint but without the video conversion step - it directly processes pre-converted HLS content.

## Endpoint Details

- **URL**: `POST /process-zip`
- **Content-Type**: `multipart/form-data`
- **File Field**: `zipFile`
- **Max File Size**: 500MB
- **Timeout**: 6 hours

## Request Format

```bash
curl -X POST http://localhost:3000/process-zip \
  -F "zipFile=@your-hls-content.zip"
```

### Form Data Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `zipFile` | File | Yes | ZIP file containing HLS content |

## ZIP File Structure Requirements

The ZIP file must contain valid HLS content with at least one of the following:

1. **Master playlist**: `master.m3u8` file in the root
2. **Individual playlists**: `playlist.m3u8` files in subdirectories (e.g., `720p/playlist.m3u8`, `480p/playlist.m3u8`)

### Example ZIP Structure

```
hls-content.zip
├── master.m3u8
├── 720p/
│   ├── playlist.m3u8
│   ├── segment001.ts
│   ├── segment002.ts
│   └── ...
├── 480p/
│   ├── playlist.m3u8
│   ├── segment001.ts
│   ├── segment002.ts
│   └── ...
└── other-hls-files...
```

## Response Format

### Success Response

```json
{
  "success": true,
  "message": "ZIP file extracted and HLS content added to IPFS successfully",
  "cid": "QmXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
  "tempDir": "/tmp/hls-zip-1234567890-abc123/extracted"
}
```

### Error Response

```json
{
  "success": false,
  "message": "Error description",
  "error": "Detailed error information",
  "tempDir": "/tmp/hls-zip-1234567890-abc123"
}
```

## Response Fields

| Field | Type | Description |
|-------|------|-------------|
| `success` | boolean | Whether the operation was successful |
| `message` | string | Human-readable status message |
| `cid` | string | IPFS Content Identifier (only on success) |
| `tempDir` | string | Path to extracted files (for debugging) |
| `error` | string | Detailed error information (only on error) |

## Error Handling

The endpoint handles various error scenarios:

1. **No file uploaded**: Returns 400 with message about missing `zipFile`
2. **File too large**: Returns 400 if file exceeds 500MB limit
3. **Invalid file type**: Returns 400 for non-ZIP files
4. **ZIP extraction failed**: Returns 400 if ZIP is corrupted or invalid
5. **Invalid HLS structure**: Returns 400 if no valid playlists found
6. **Leither service errors**: Returns detailed error messages for IPFS upload failures

## Processing Steps

1. **Validation**: Check file type and size
2. **Extraction**: Extract ZIP contents to temporary directory
3. **HLS Validation**: Verify HLS structure contains valid playlists
4. **Leither Connection**: Connect to Leither service for IPFS operations
5. **IPFS Upload**: Upload extracted HLS content to IPFS
6. **Cleanup**: Remove temporary files and return CID

## Concurrency and Performance

- Maximum concurrent uploads: 3
- Queue system for handling multiple requests
- Connection pooling for Leither service
- Automatic cleanup of old temporary files

## Testing

Use the provided test script:

```bash
# Create a test ZIP file with HLS content and name it 'test-hls.zip'
node test-zip-endpoint.js
```

## Dependencies

- `adm-zip`: For ZIP file extraction
- `hprose`: For Leither service communication
- `express-fileupload`: For file upload handling

## Security Considerations

- File size limits prevent abuse
- Temporary files are cleaned up automatically
- Authorization is handled by the main application middleware
- Input validation prevents malicious ZIP files

## Monitoring and Logging

The endpoint provides comprehensive logging:

- Request tracking with unique IDs
- Progress monitoring for long-running operations
- Detailed error logging for troubleshooting
- Performance timing for optimization

## Integration with Existing System

This endpoint integrates seamlessly with the existing TUS server:

- Uses the same authorization middleware
- Follows the same error handling patterns
- Compatible with existing CORS configuration
- Shares Leither service connection pool with video processing
