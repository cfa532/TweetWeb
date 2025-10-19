# ZIP Processing Endpoint

This document describes the new `/process-zip` endpoint that allows uploading ZIP files containing HLS content and converting them to IPFS files.

## Overview

The ZIP processing endpoint takes a ZIP file containing HLS (HTTP Live Streaming) content, extracts it, validates the HLS structure, and then uploads the extracted content to IPFS using the Leither service. This is similar to the video conversion endpoint but without the video conversion step - it directly processes pre-converted HLS content.

## Endpoint Details

- **Upload URL**: `POST /process-zip`
- **Status URL**: `GET /process-zip/status/:jobId`
- **Content-Type**: `multipart/form-data`
- **File Field**: `zipFile`
- **Max File Size**: 500MB
- **Processing Mode**: Asynchronous with status polling

## Request Format

### 1. Upload ZIP File

```bash
curl -X POST http://localhost:3000/process-zip \
  -F "zipFile=@your-hls-content.zip"
```

**Immediate Response:**
```json
{
  "success": true,
  "message": "ZIP upload started",
  "jobId": "abc123def"
}
```

### 2. Check Processing Status

```bash
curl http://localhost:3000/process-zip/status/abc123def
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

### Upload Response (Immediate)

```json
{
  "success": true,
  "message": "ZIP upload started",
  "jobId": "abc123def"
}
```

### Status Response

#### Processing (In Progress)
```json
{
  "success": true,
  "jobId": "abc123def",
  "status": "processing",
  "progress": 45,
  "message": "Adding to IPFS...",
  "startTime": 1642123456789
}
```

#### Completed Successfully
```json
{
  "success": true,
  "jobId": "abc123def",
  "status": "completed",
  "progress": 100,
  "message": "ZIP processing completed successfully",
  "cid": "QmXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
  "tempDir": "/tmp/hls-zip-1234567890-abc123/extracted",
  "startTime": 1642123456789,
  "endTime": 1642124456789
}
```

#### Failed
```json
{
  "success": true,
  "jobId": "abc123def",
  "status": "failed",
  "progress": 0,
  "message": "ZIP processing failed",
  "error": "Detailed error information",
  "startTime": 1642123456789,
  "endTime": 1642124456789
}
```

## Response Fields

| Field | Type | Description |
|-------|------|-------------|
| `success` | boolean | Whether the operation was successful |
| `jobId` | string | Unique job identifier for status polling |
| `status` | string | Job status: `uploading`, `processing`, `completed`, `failed` |
| `progress` | number | Processing progress percentage (0-100) |
| `message` | string | Human-readable status message |
| `cid` | string | IPFS Content Identifier (only when completed) |
| `tempDir` | string | Path to extracted files (for debugging) |
| `error` | string | Detailed error information (only when failed) |
| `startTime` | number | Job start timestamp |
| `endTime` | number | Job end timestamp (only when completed/failed) |

## Error Handling

The endpoint handles various error scenarios:

1. **No file uploaded**: Returns 400 with message about missing `zipFile`
2. **File too large**: Returns 400 if file exceeds 500MB limit
3. **Invalid file type**: Returns 400 for non-ZIP files
4. **ZIP extraction failed**: Returns 400 if ZIP is corrupted or invalid
5. **Invalid HLS structure**: Returns 400 if no valid playlists found
6. **Leither service errors**: Returns detailed error messages for IPFS upload failures

## Processing Steps

1. **Upload**: Receive ZIP file and generate unique job ID
2. **Immediate Response**: Return job ID to client for status polling
3. **Background Processing**:
   - **Validation**: Check file type and size
   - **Extraction**: Extract ZIP contents to temporary directory
   - **HLS Validation**: Verify HLS structure contains valid playlists
   - **Content Discovery**: Find actual HLS content directory
   - **Leither Connection**: Connect to Leither service for IPFS operations
   - **IPFS Upload**: Upload extracted HLS content to IPFS
   - **Cleanup**: Remove temporary files
4. **Status Updates**: Client polls status endpoint for progress updates

## Concurrency and Performance

- Maximum concurrent uploads: 3
- Queue system for handling multiple requests
- **Centralized Leither Connection Pool**: Shared with video processing service
- **Startup Initialization**: Leither port detected once at startup, cached in memory
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
- **Shares centralized Leither connection pool** with video processing
- **Uses cached Leither port** from startup initialization for better performance
