# TUS Server with Video Conversion & File Processing

This server provides TUS (Tus Resumable Upload) functionality along with video conversion, ZIP processing, and tar file extraction features.

## Features

- **TUS Upload**: Resumable file uploads using the TUS protocol
- **Video Conversion**: Automatic video to HLS conversion with IPFS upload
- **File Browser**: Web interface for browsing uploaded files
- **Network Disk**: Access to files stored in a network disk directory
- **Tar Extraction**: Extract tar/tar.gz files to temporary directories
- **ZIP Processing**: Process pre-converted HLS content in ZIP files

## Setup

1. Install dependencies:
```bash
cd src/tus-server
npm install
```

2. Create a `.env` file with the following variables:
```env
PORT=3000
AUTHORIZED_USERNAME=your_username
NET_DISK=/path/to/your/network/disk
```

3. Start the server:
```bash
npm start
```

## API Endpoints

### Video Conversion

**POST** `/convert-video`

Converts video files to HLS format with adaptive bitrate streaming and uploads to IPFS. The endpoint uses an asynchronous processing model with status polling.

**Request:**
- Content-Type: `multipart/form-data`
- Body: Form data with field name `videoFile` containing the video file
- Optional parameter: `noResample=true` to skip conversion and use direct copy mode

**Response (Immediate):**
```json
{
  "success": true,
  "message": "Video upload started",
  "jobId": "abc123def"
}
```

**Status Endpoint:** `GET /convert-video/status/:jobId`

**Status Response:**
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

#### Video Conversion Algorithm

The server uses an intelligent encoder selection algorithm with the following decision tree:

1. **No Resample Mode** (`noResample=true`):
   - Uses `-c:v copy -c:a copy` (stream copy, fastest)
   - No quality conversion
   - Single HLS playlist

2. **Large Files (>256MB)**:
   - Single quality conversion (720p)
   - Encoder selection based on video properties

3. **Regular Files (≤256MB)**:
   - Multi-quality conversion (720p + 480p)
   - Master playlist with adaptive bitrate streaming

#### Encoder Selection Logic

**Copy Encoder (Stream Copy)**:
- **Conditions**: 
  - Video resolution ≤ 1280p (width or height depending on orientation)
  - AND video codec is HLS-compatible (h264, avc, hevc)
  - AND NOT mpeg4/divx/xvid (incompatible codecs)
  - AND single quality mode only
- **Usage**: `-c:v copy` (no re-encoding, fastest)
- **Important**: Copy encoder is **NEVER used for multi-quality conversion** as it cannot scale video

**Hardware Encoders** (priority order):
1. **NVIDIA**: `h264_nvenc` (if available and tested successfully)
2. **Intel**: `h264_qsv` (if available and tested successfully)
3. **Apple**: `h264_videotoolbox` (if available and tested successfully)
4. **AMD**: `h264_amf` (if available and tested successfully)

**Software Encoder** (fallback):
- **libx264** with preset `fast`, tune `zerolatency`, threads `2`

**Multi-Quality Override**:
- If copy encoder is selected but multi-quality conversion is needed, the system automatically overrides to use hardware encoder (if available) or libx264
- This prevents creating duplicate streams with identical quality

#### Quality Profiles

**720p Stream**:
- Bitrate: 2000k
- Audio: AAC 128k
- Scaling: Lanczos algorithm with aspect ratio preservation

**480p Stream**:
- Bitrate: 1000k
- Audio: AAC 128k
- Scaling: Lanczos algorithm with aspect ratio preservation

#### Processing Flow

1. **Upload & Validation**: Validate file type, size (max 4GB)
2. **Video Analysis**: Extract metadata (dimensions, codec, rotation, bit depth)
3. **Encoder Detection**: Detect and test available hardware encoders
4. **Encoder Selection**: Choose optimal encoder based on video properties
5. **HLS Conversion**: Convert to HLS format with selected encoder
6. **IPFS Upload**: Upload HLS content to IPFS via Leither service
7. **Cleanup**: Remove temporary files

#### Concurrency Management

- Maximum concurrent conversions: 3
- Queue system for handling multiple requests
- **Centralized Leither Connection Pool**: Shared across all services (max 2 connections)
- **Startup Initialization**: Leither port detected once at startup, cached in memory
- Automatic cleanup of temporary files older than 1 hour

#### Error Handling & Fallback

- **Copy encoder failures**: Automatic fallback to libx264 encoding
- **Hardware encoder failures**: Automatic fallback to software encoding
- **Leither service errors**: Detailed error messages with context
- **Timeout protection**: 6-hour maximum processing time

#### Example Usage

**Using curl:**
```bash
# Upload video
curl -X POST http://localhost:3000/convert-video \
  -F "videoFile=@my-video.mp4" \
  -F "noResample=false"

# Response: {"success":true,"message":"Video upload started","jobId":"abc123def"}

# Poll for status (every 2 seconds)
curl http://localhost:3000/convert-video/status/abc123def
```

**Using JavaScript/Fetch:**
```javascript
// Upload video
const formData = new FormData();
formData.append('videoFile', videoFile);
formData.append('noResample', 'false');

const uploadResponse = await fetch('/convert-video', {
  method: 'POST',
  body: formData
});

const { jobId } = await uploadResponse.json();

// Poll for status
const pollStatus = setInterval(async () => {
  const statusResponse = await fetch(`/convert-video/status/${jobId}`);
  const status = await statusResponse.json();
  
  console.log(`Progress: ${status.progress}%`);
  
  if (status.status === 'completed') {
    clearInterval(pollStatus);
    console.log('CID:', status.cid);
  } else if (status.status === 'failed') {
    clearInterval(pollStatus);
    console.error('Error:', status.message);
  }
}, 2000);
```

### Tar File Extraction

**POST** `/extract-tar`

Extracts a tar or tar.gz file to a temporary directory and returns the path.

**Request:**
- Content-Type: `multipart/form-data`
- Body: Form data with field name `tarFile` containing the tar file

**Response:**
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

**Error Response:**
```json
{
  "success": false,
  "message": "Error message",
  "error": "Detailed error information"
}
```

### Example Usage

Using curl:
```bash
curl -X POST \
  -F "tarFile=@/path/to/your/file.tar.gz" \
  http://localhost:3000/extract-tar
```

Using JavaScript/Fetch:
```javascript
const formData = new FormData();
formData.append('tarFile', fileInput.files[0]);

fetch('/extract-tar', {
  method: 'POST',
  body: formData
})
.then(response => response.json())
.then(data => {
  if (data.success) {
    console.log('Extracted to:', data.extractedPath);
  } else {
    console.error('Error:', data.message);
  }
});
```

## Security Notes

- **Video Conversion**: File size limited to 4GB, 6-hour processing timeout
- **Tar Extraction**: File size limited to 50MB by default
- **ZIP Processing**: File size limited to 500MB
- Temporary files are automatically cleaned up (1+ hour old)
- Only supported file types are accepted
- Authorization is required for most endpoints (except file access, tar extraction, and video conversion)

## File Types Supported

### Video Files (for /convert-video)
- `video/mp4` - MP4 video files
- `video/avi` - AVI video files
- `video/mov`, `video/quicktime` - MOV/QuickTime files
- `video/mkv`, `video/x-matroska` - Matroska files
- `video/webm` - WebM files
- `video/wmv`, `video/x-ms-wmv` - Windows Media Video
- `video/flv`, `video/x-flv` - Flash Video
- Extensions: `.mp4`, `.avi`, `.mov`, `.mkv`, `.wmv`, `.flv`, `.webm`, `.m4v`, `.3gp`, `.ogv`

### Archive Files
- `application/x-tar` - Standard tar files
- `application/gzip` - Gzipped files
- `application/x-gzip` - Alternative gzip MIME type
- `application/zip` - ZIP files (for HLS content)

## Authorization

The following endpoints do NOT require authorization:
- `/convert-video` - Video conversion to HLS
- `/convert-video/status/:jobId` - Video conversion status
- `/process-zip` - ZIP file processing
- `/process-zip/status/:jobId` - ZIP processing status
- `/extract-tar` - Tar file extraction
- `/netd/*` - File access paths
- `/files/register` - File registration

All other endpoints require the `AUTHORIZED_USERNAME` to be provided via query params, request body, or headers.

## Temporary Directory Cleanup

The server creates temporary directories in the system's temp directory (e.g., `/tmp` on Linux/macOS).

### Automatic Cleanup
- **Video Conversion**: Temporary directories older than 1 hour are automatically cleaned up when new conversions start
- **Uploaded Files**: Temporary uploaded files are deleted immediately after processing

### Manual Cleanup
- **Tar Extraction**: It's the client's responsibility to clean up extracted files when no longer needed
- The temporary directory path is returned in the response and can be used by the client to access or clean up the files

## Dependencies

### Required
- `express` - Web framework
- `express-fileupload` - File upload middleware
- `hprose` - Leither service communication
- `adm-zip` - ZIP file extraction

### FFmpeg
The video conversion endpoint requires FFmpeg to be installed on the system:
```bash
# macOS
brew install ffmpeg

# Ubuntu/Debian
sudo apt-get install ffmpeg

# CentOS/RHEL
sudo yum install ffmpeg
```

**Recommended**: Install FFmpeg with hardware acceleration support for better performance (h264_nvenc, h264_qsv, h264_videotoolbox, h264_amf) 