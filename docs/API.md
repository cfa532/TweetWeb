# API Documentation

Complete API reference for TweetWeb backend services.

## Table of Contents

- [Base URL](#base-url)
- [Authentication](#authentication)
- [Video Conversion API](#video-conversion-api)
- [ZIP Processing API](#zip-processing-api)
- [File Upload API](#file-upload-api)
- [Tar Extraction API](#tar-extraction-api)
- [Network Disk API](#network-disk-api)
- [Error Handling](#error-handling)
- [Rate Limiting](#rate-limiting)
- [Examples](#examples)

## Base URL

```
Development: http://localhost:3000
Production: http://your-domain.com/api
```

## Authentication

Most endpoints do not require authentication. Endpoints that require authorization need the `AUTHORIZED_USERNAME` parameter.

### Public Endpoints (No Auth Required)

- `/normalize-video` - Video normalization (for <50MB videos)
- `/convert-video` - Video conversion (for >50MB videos)
- `/convert-video/status/:jobId` - Video conversion status
- `/process-zip` - ZIP processing
- `/process-zip/status/:jobId` - ZIP status
- `/extract-tar` - Tar extraction
- `/files/register` - File registration
- `/netd/*` - Network disk file access

### Protected Endpoints

Provide authorization via query params, body, or headers:

```javascript
// Query parameter
?username=admin

// Request body
{ "username": "admin" }

// Header
Authorization: Bearer <username>
```

---

## Video Normalization API

Normalize small video files (<50MB) to MP4 format with automatic resolution scaling and IPFS upload.

### POST /normalize-video

Normalize a small video file to MP4 format and upload to IPFS.

#### Request

**Content-Type**: `multipart/form-data`

**Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `videoFile` | File | Yes | Video file to normalize (must be <50MB) |
| `filename` | String | No | Original filename |
| `filesize` | Number | No | File size in bytes |
| `contentType` | String | No | MIME type of the file |

**Supported Video Formats**:
- MP4 (.mp4)
- AVI (.avi)
- MOV (.mov)
- MKV (.mkv)
- WebM (.webm)
- WMV (.wmv)
- FLV (.flv)
- M4V (.m4v)
- 3GP (.3gp)
- OGV (.ogv)

**File Size Limit**: 50MB (strict limit)

#### Response

**Success** (200):
```json
{
  "success": true,
  "cid": "QmXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
  "originalSize": 45234123,
  "normalizedSize": 38912345,
  "originalDimensions": "1920x1080",
  "normalizedDimensions": "1280x720",
  "message": "Video normalized and added to IPFS successfully"
}
```

**Fields**:
- `cid`: IPFS Content Identifier (CID) of the normalized video
- `originalSize`: Original file size in bytes
- `normalizedSize`: Normalized file size in bytes
- `originalDimensions`: Original video dimensions (width x height)
- `normalizedDimensions`: Final normalized dimensions (width x height)
- `message`: Success message

**Error Responses**:

**File Too Large** (400):
```json
{
  "success": false,
  "message": "File size 55.23MB exceeds the maximum allowed size of 50MB for normalization."
}
```

**No File Uploaded** (400):
```json
{
  "success": false,
  "message": "No video file uploaded. Please use the 'videoFile' field name."
}
```

**Processing Failed** (500):
```json
{
  "success": false,
  "message": "Video normalization failed: [error details]"
}
```

#### Behavior

- **Resolution > 720p**: Automatically scales down to max 720p while preserving aspect ratio
- **Resolution ≤ 720p**: Keeps original resolution
- **Format**: Always outputs MP4 with H.264 video and AAC audio
- **IPFS**: Uploads normalized file directly to IPFS using Leither

#### Example

```bash
curl -X POST http://localhost:3000/normalize-video \
  -F "videoFile=@small-video.mp4" \
  -F "filename=small-video.mp4" \
  -F "filesize=45234123" \
  -F "contentType=video/mp4"
```

For detailed documentation, see [Video Normalization Guide](VIDEO_NORMALIZATION.md).

---

## Video Conversion API

Convert video files to HLS format with adaptive bitrate streaming and IPFS upload.

### POST /convert-video

Upload and convert a video file to HLS format.

#### Request

**Content-Type**: `multipart/form-data`

**Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `videoFile` | File | Yes | Video file to convert |
| `noResample` | Boolean | No | Skip conversion, use copy mode (default: false) |

**Supported Video Formats**:
- MP4 (.mp4)
- AVI (.avi)
- MOV (.mov)
- MKV (.mkv)
- WebM (.webm)
- WMV (.wmv)
- FLV (.flv)
- M4V (.m4v)
- 3GP (.3gp)
- OGV (.ogv)

**File Size Limit**: 4GB

#### Response (Immediate)

```json
{
  "success": true,
  "message": "Video upload started",
  "jobId": "abc123def"
}
```

**Status**: 200 OK

#### Error Responses

**No File Uploaded** (400):
```json
{
  "success": false,
  "message": "No video file uploaded. Please use the 'videoFile' field name."
}
```

**File Too Large** (400):
```json
{
  "success": false,
  "message": "File size 4500.00MB exceeds the maximum allowed size of 4GB."
}
```

**Invalid File Type** (400):
```json
{
  "success": false,
  "message": "Invalid video type. Allowed types are: video/mp4, video/avi, ..."
}
```

### GET /convert-video/status/:jobId

Check the status of a video conversion job.

#### Request

**URL Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `jobId` | String | Yes | Job ID returned from /convert-video |

#### Response

**Processing** (200):
```json
{
  "success": true,
  "jobId": "abc123def",
  "status": "processing",
  "progress": 45,
  "message": "Converting video to 720p HLS...",
  "startTime": 1642123456789
}
```

**Completed** (200):
```json
{
  "success": true,
  "jobId": "abc123def",
  "status": "completed",
  "progress": 100,
  "message": "Video processing completed successfully",
  "cid": "QmXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
  "tempDir": "/tmp/hls-convert-1234567890-abc123",
  "startTime": 1642123456789,
  "endTime": 1642124456789
}
```

**Failed** (200):
```json
{
  "success": true,
  "jobId": "abc123def",
  "status": "failed",
  "progress": 0,
  "message": "Video processing failed",
  "error": "FFmpeg conversion error: ...",
  "startTime": 1642123456789,
  "endTime": 1642124456789
}
```

**Job Not Found** (404):
```json
{
  "success": false,
  "message": "Job not found"
}
```

#### Status Values

| Status | Description |
|--------|-------------|
| `uploading` | File is being uploaded |
| `processing` | Video is being converted |
| `completed` | Conversion completed successfully |
| `failed` | Conversion failed |

#### Progress Values

- `0-20`: Upload phase
- `20-40`: Video analysis
- `40-60`: HLS conversion
- `60-95`: IPFS upload
- `95-100`: Finalization
- `100`: Complete

---

## ZIP Processing API

Process ZIP files containing pre-converted HLS content and upload to IPFS.

### POST /process-zip

Upload and process a ZIP file containing HLS content.

#### Request

**Content-Type**: `multipart/form-data`

**Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `zipFile` | File | Yes | ZIP file containing HLS content |

**File Size Limit**: 500MB

**Required ZIP Structure**:
```
hls-content.zip
├── master.m3u8 (or)
├── 720p/
│   ├── playlist.m3u8
│   └── *.ts files
└── 480p/
    ├── playlist.m3u8
    └── *.ts files
```

#### Response (Immediate)

```json
{
  "success": true,
  "message": "ZIP upload started",
  "jobId": "xyz789abc"
}
```

**Status**: 200 OK

#### Error Responses

**No File Uploaded** (400):
```json
{
  "success": false,
  "message": "No ZIP file uploaded. Please use the 'zipFile' field name."
}
```

**File Too Large** (400):
```json
{
  "success": false,
  "message": "File size 600.00MB exceeds the maximum allowed size of 500MB."
}
```

**Invalid ZIP File** (400):
```json
{
  "success": false,
  "message": "Invalid ZIP file or extraction failed"
}
```

**Invalid HLS Structure** (400):
```json
{
  "success": false,
  "message": "No valid HLS playlists found in ZIP file"
}
```

### GET /process-zip/status/:jobId

Check the status of a ZIP processing job.

#### Request

**URL Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `jobId` | String | Yes | Job ID returned from /process-zip |

#### Response Format

Same as video conversion status endpoint (see above).

---

## File Upload API

### POST /files/upload

Upload files using TUS resumable upload protocol.

#### Request

Follow TUS protocol specifications:
- https://tus.io/protocols/resumable-upload.html

**Supported Features**:
- Resumable uploads
- Chunked uploads
- Upload progress tracking

#### Response

Follow TUS protocol response format.

### POST /files/register

Register an uploaded file after TUS upload completes.

#### Request

**Content-Type**: `application/json`

**Body**:
```json
{
  "uploadUrl": "http://localhost:3000/files/abc123",
  "filename": "example.txt",
  "filetype": "text/plain"
}
```

#### Response

```json
{
  "success": true,
  "id": "file_abc123",
  "filename": "example.txt",
  "filetype": "text/plain",
  "uploadedAt": "2024-01-01T12:00:00.000Z"
}
```

---

## Tar Extraction API

### POST /extract-tar

Extract tar or tar.gz files to a temporary directory.

#### Request

**Content-Type**: `multipart/form-data`

**Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `tarFile` | File | Yes | Tar or tar.gz file to extract |

**File Size Limit**: 50MB

**Supported Formats**:
- `.tar` - Standard tar files
- `.tar.gz` - Gzipped tar files
- `.tgz` - Gzipped tar files (alternative extension)

#### Response

**Success** (200):
```json
{
  "success": true,
  "message": "Tar file extracted successfully",
  "extractedPath": "/tmp/tar-extract-1234567890-abc123def",
  "originalFileName": "example.tar.gz",
  "extractedSize": 1024000,
  "extractedAt": "2024-01-01T12:00:00.000Z"
}
```

#### Error Responses

**No File Uploaded** (400):
```json
{
  "success": false,
  "message": "No tar file uploaded"
}
```

**Invalid File Type** (400):
```json
{
  "success": false,
  "message": "Invalid file type. Only tar and tar.gz files are supported."
}
```

**Extraction Failed** (500):
```json
{
  "success": false,
  "message": "Failed to extract tar file",
  "error": "Detailed error message"
}
```

---

## Network Disk API

### GET /netd/*

Access files stored in the configured network disk directory.

#### Request

**URL Pattern**: `/netd/<filepath>`

**Example**: `/netd/documents/report.pdf`

#### Response

Returns the requested file with appropriate `Content-Type` header.

#### Error Responses

**File Not Found** (404):
```json
{
  "success": false,
  "message": "File not found"
}
```

**Access Denied** (403):
```json
{
  "success": false,
  "message": "Access denied"
}
```

---

## Error Handling

### Standard Error Response Format

```json
{
  "success": false,
  "message": "Human-readable error message",
  "error": "Detailed technical error (optional)",
  "code": "ERROR_CODE (optional)"
}
```

### HTTP Status Codes

| Code | Description |
|------|-------------|
| 200 | Success |
| 400 | Bad Request (invalid input) |
| 401 | Unauthorized (missing/invalid auth) |
| 403 | Forbidden (access denied) |
| 404 | Not Found (resource doesn't exist) |
| 413 | Payload Too Large (file size exceeded) |
| 500 | Internal Server Error |
| 503 | Service Unavailable (queue full) |

### Common Error Codes

| Code | Description |
|------|-------------|
| `FILE_TOO_LARGE` | Uploaded file exceeds size limit |
| `INVALID_FILE_TYPE` | File type not supported |
| `CONVERSION_FAILED` | Video conversion failed |
| `IPFS_UPLOAD_FAILED` | IPFS upload failed |
| `LEITHER_CONNECTION_ERROR` | Leither service unavailable |
| `QUEUE_FULL` | Too many concurrent operations |
| `TIMEOUT` | Operation timed out |

---

## Rate Limiting

### Concurrency Limits

- **Video Conversions**: Maximum 3 concurrent conversions
- **File Uploads**: Based on TUS protocol limits
- **General API**: No hard limits, but recommended to stay under 100 req/min

### Queue Behavior

When concurrency limit is reached:
1. New requests are queued
2. Processed in FIFO order
3. Maximum queue size: 10 requests
4. Queue overflow returns 503 Service Unavailable

---

## Examples

### Video Upload with Status Polling (JavaScript)

```javascript
// Upload video
async function uploadVideo(videoFile) {
  const formData = new FormData();
  formData.append('videoFile', videoFile);
  formData.append('noResample', 'false');

  const response = await fetch('http://localhost:3000/convert-video', {
    method: 'POST',
    body: formData
  });

  const { jobId } = await response.json();
  
  // Poll for status
  return new Promise((resolve, reject) => {
    const pollInterval = setInterval(async () => {
      try {
        const statusRes = await fetch(
          `http://localhost:3000/convert-video/status/${jobId}`
        );
        const status = await statusRes.json();
        
        console.log(`Progress: ${status.progress}%`);
        
        if (status.status === 'completed') {
          clearInterval(pollInterval);
          resolve(status.cid);
        } else if (status.status === 'failed') {
          clearInterval(pollInterval);
          reject(new Error(status.message));
        }
      } catch (error) {
        clearInterval(pollInterval);
        reject(error);
      }
    }, 2000); // Poll every 2 seconds
    
    // Timeout after 2 hours
    setTimeout(() => {
      clearInterval(pollInterval);
      reject(new Error('Timeout'));
    }, 2 * 60 * 60 * 1000);
  });
}

// Usage
const videoInput = document.querySelector('#video-input');
const cid = await uploadVideo(videoInput.files[0]);
console.log('Video CID:', cid);
```

### ZIP Processing (cURL)

```bash
# Upload ZIP file
curl -X POST http://localhost:3000/process-zip \
  -F "zipFile=@hls-content.zip"

# Response: {"success":true,"message":"ZIP upload started","jobId":"xyz789"}

# Check status
curl http://localhost:3000/process-zip/status/xyz789

# Poll until completed
while true; do
  STATUS=$(curl -s http://localhost:3000/process-zip/status/xyz789 | jq -r '.status')
  if [ "$STATUS" == "completed" ]; then
    echo "Processing complete!"
    break
  elif [ "$STATUS" == "failed" ]; then
    echo "Processing failed!"
    break
  fi
  sleep 2
done
```

### Tar Extraction (Python)

```python
import requests

# Upload tar file
with open('archive.tar.gz', 'rb') as f:
    files = {'tarFile': f}
    response = requests.post(
        'http://localhost:3000/extract-tar',
        files=files
    )

result = response.json()
if result['success']:
    print(f"Extracted to: {result['extractedPath']}")
    print(f"Size: {result['extractedSize']} bytes")
else:
    print(f"Error: {result['message']}")
```

### TUS Resumable Upload (JavaScript with tus-js-client)

```javascript
import * as tus from 'tus-js-client';

const file = document.querySelector('#file-input').files[0];

const upload = new tus.Upload(file, {
  endpoint: 'http://localhost:3000/files/',
  retryDelays: [0, 3000, 5000, 10000, 20000],
  metadata: {
    filename: file.name,
    filetype: file.type
  },
  onError: (error) => {
    console.error('Upload failed:', error);
  },
  onProgress: (bytesUploaded, bytesTotal) => {
    const percentage = ((bytesUploaded / bytesTotal) * 100).toFixed(2);
    console.log(`Progress: ${percentage}%`);
  },
  onSuccess: async () => {
    console.log('Upload completed');
    
    // Register the file
    const registerRes = await fetch('http://localhost:3000/files/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        uploadUrl: upload.url,
        filename: file.name,
        filetype: file.type
      })
    });
    
    const result = await registerRes.json();
    console.log('File registered:', result.id);
  }
});

// Start upload
upload.start();

// Pause upload
// upload.abort();

// Resume upload
// upload.start();
```

### Error Handling Example

```javascript
async function safeVideoUpload(videoFile) {
  try {
    const formData = new FormData();
    formData.append('videoFile', videoFile);

    const response = await fetch('http://localhost:3000/convert-video', {
      method: 'POST',
      body: formData
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.message || 'Upload failed');
    }

    const { jobId } = await response.json();
    return jobId;
    
  } catch (error) {
    if (error.message.includes('4GB')) {
      alert('File too large! Maximum size is 4GB');
    } else if (error.message.includes('Invalid')) {
      alert('Unsupported file format');
    } else if (error.message.includes('network')) {
      alert('Network error. Check your connection');
    } else {
      alert('Upload failed: ' + error.message);
    }
    throw error;
  }
}
```

---

## Webhooks (Future Feature)

Webhook support is planned for future releases to notify clients of job completion without polling.

**Planned Endpoint**: `POST /webhooks/register`

Stay tuned for updates!

---

## API Changelog

### Version 1.0.0 (Current)

- Initial API release
- Video conversion with HLS output
- ZIP processing for HLS content
- File upload via TUS protocol
- Tar extraction
- Network disk access

### Upcoming Features

- Webhooks for job completion
- Batch video processing
- Video thumbnails generation
- Live streaming support
- Advanced video analytics

---

## Support

For API support:
- Check [Setup Guide](SETUP.md) for configuration
- Review [Video Conversion Guide](VIDEO_CONVERSION.md)
- Open an issue on GitHub
- Contact support through the application

## API Client Libraries

Official client libraries:
- JavaScript/TypeScript: Built into frontend (`src/utils/uploadUtils.ts`)
- Python: Coming soon
- Go: Coming soon

Community-contributed libraries welcome!

