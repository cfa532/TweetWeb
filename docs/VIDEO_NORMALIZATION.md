# Video Normalization Guide

Complete guide to video normalization feature for small videos (<50MB) in TweetWeb.

## Table of Contents

- [Overview](#overview)
- [When to Use](#when-to-use)
- [How It Works](#how-it-works)
- [API Reference](#api-reference)
- [Processing Flow](#processing-flow)
- [Resolution Handling](#resolution-handling)
- [File Format Normalization](#file-format-normalization)
- [IPFS Integration](#ipfs-integration)
- [Client Integration](#client-integration)
- [Error Handling](#error-handling)
- [Performance](#performance)
- [Troubleshooting](#troubleshooting)

## Overview

Video normalization is an optimized processing pipeline for small videos (under 50MB) that:

- **Normalizes to MP4 format**: Ensures consistent, widely-supported video format
- **Smart resolution scaling**: Automatically scales videos >720p down to max 720p while preserving aspect ratio
- **Preserves quality**: Keeps original resolution for videos ≤720p
- **Direct IPFS upload**: Uses Leither shell command to add normalized video directly to IPFS
- **Fast processing**: Optimized for quick turnaround on small files

### Key Benefits

- **Consistent format**: All normalized videos are in MP4 format with H.264 video and AAC audio
- **Optimal file size**: Resolution scaling reduces file size for high-resolution videos
- **Browser compatibility**: MP4 format ensures maximum browser/device support
- **Quick processing**: Faster than full HLS conversion for small files
- **IPFS-ready**: Direct upload to IPFS without intermediate storage

## When to Use

### Automatic Selection

The system **automatically** uses normalization for videos when:

- Video file size is **≤ 50MB**
- Backend service is available (cloudDrivePort configured)
- Service health check passes

### Manual Override

Videos >50MB are automatically routed to the [HLS conversion endpoint](VIDEO_CONVERSION.md) for adaptive bitrate streaming.

### Fallback Behavior

If normalization service is unavailable, the system falls back to:
- Direct IPFS upload (same as other file types)
- User receives warning notification about fallback

## How It Works

### Process Flow

```
1. Client detects video <50MB
   ↓
2. Upload to /normalize-video endpoint
   ↓
3. Server analyzes video (ffprobe)
   ↓
4. Normalize to MP4:
   ├─ Resolution >720p? → Scale to max 720p
   └─ Resolution ≤720p? → Keep original
   ↓
5. Save normalized file to temp disk
   ↓
6. Upload to IPFS via Leither shell command
   ↓
7. Return CID to client
```

### Decision Tree

```
Video Size ≤ 50MB?
├─ YES → Use normalization endpoint
│   ├─ Resolution >720p? → Scale to 720p max
│   └─ Resolution ≤720p? → Keep original
└─ NO → Use HLS conversion endpoint
```

## API Reference

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

**Supported Formats**:
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

**File Size Limit**: 50MB (strict limit for normalization)

#### Response

**Success (200 OK)**:

```json
{
  "success": true,
  "cid": "QmXxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
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

**Error (400/500)**:

```json
{
  "success": false,
  "message": "Error message describing the failure"
}
```

#### Example Request

```bash
curl -X POST http://localhost:3000/normalize-video \
  -F "videoFile=@small-video.mp4" \
  -F "filename=small-video.mp4" \
  -F "filesize=45234123" \
  -F "contentType=video/mp4"
```

#### Example JavaScript

```javascript
const formData = new FormData();
formData.append('videoFile', file);
formData.append('filename', file.name);
formData.append('filesize', file.size.toString());
formData.append('contentType', file.type);

const response = await fetch('http://localhost:3000/normalize-video', {
  method: 'POST',
  body: formData
});

const result = await response.json();
if (result.success) {
  console.log('Normalized video CID:', result.cid);
  console.log('Original dimensions:', result.originalDimensions);
  console.log('Normalized dimensions:', result.normalizedDimensions);
}
```

## Processing Flow

### Step 1: Upload & Validation (0-10%)

```javascript
// Validate file size (strict 50MB limit)
if (file.size > 50 * 1024 * 1024) {
  throw new Error('File exceeds 50MB limit for normalization');
}

// Validate file type
const allowedTypes = ['video/mp4', 'video/avi', ...];
if (!allowedTypes.includes(file.mimetype)) {
  throw new Error('Unsupported video format');
}
```

### Step 2: Video Analysis (10-30%)

```bash
# Extract video metadata using ffprobe
ffprobe -v quiet -print_format json \
  -show_format -show_streams input.mp4
```

**Extracted Information**:
- Dimensions (width × height)
- Display dimensions (after rotation correction)
- Codec (h264, hevc, mpeg4, etc.)
- Rotation metadata
- Pixel format

### Step 3: Resolution Decision (30%)

```javascript
const maxDimension = Math.max(displayWidth, displayHeight);
const shouldScale = maxDimension > 720;

if (shouldScale) {
  // Scale down to max 720p while preserving aspect ratio
  const dim720 = calculateSingleQualityDimensions(videoInfo, 720);
  // Result: maintains aspect ratio, max dimension = 720
}
```

### Step 4: MP4 Normalization (30-80%)

#### If Resolution > 720p (Scaling Required)

```bash
ffmpeg -i input.mp4 \
  -c:v libx264 \
  -preset medium \
  -crf 23 \
  -c:a aac \
  -b:a 128k \
  -vf "scale=1280:720:flags=lanczos:force_original_aspect_ratio=decrease:force_divisible_by=2" \
  -movflags +faststart \
  output.mp4
```

**Parameters**:
- `-c:v libx264`: H.264 video codec (software encoder)
- `-preset medium`: Balanced speed/quality
- `-crf 23`: Constant Rate Factor (lower = better quality, 18-28 is typical range)
- `-c:a aac`: AAC audio codec
- `-b:a 128k`: Audio bitrate
- `-vf scale=...`: Scale filter with aspect ratio preservation
- `-movflags +faststart`: Enable fast start for web streaming

#### If Resolution ≤ 720p (Keep Original)

**If codec is already H.264**:
```bash
# Use copy mode for fastest processing
ffmpeg -i input.mp4 \
  -c:v copy \
  -c:a aac \
  -b:a 128k \
  -movflags +faststart \
  output.mp4
```

**If codec is not H.264**:
```bash
# Re-encode to H.264
ffmpeg -i input.mp4 \
  -c:v libx264 \
  -preset medium \
  -crf 23 \
  -c:a aac \
  -b:a 128k \
  -movflags +faststart \
  output.mp4
```

### Step 5: IPFS Upload (80-95%)

```bash
# Use Leither shell command directly
Leither ipfs add /path/to/normalized.mp4
```

**Output Format**:
```
ipfs add ok  QmXxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

**CID Extraction**:
```javascript
const match = output.match(/ipfs\s+add\s+ok\s+(Qm[a-zA-Z0-9]{44}|baf[a-z0-9]{56,})/i);
const cid = match ? match[1] : null;
```

### Step 6: Cleanup (95-100%)

```javascript
// Remove temporary directory and files
fs.rmSync(tempDir, { recursive: true, force: true });
```

## Resolution Handling

### Scaling Algorithm

The system uses the `calculateSingleQualityDimensions` function to preserve aspect ratio:

```javascript
function calculateSingleQualityDimensions(videoInfo, targetDimension = 720) {
  const displayWidth = videoInfo.displayWidth;
  const displayHeight = videoInfo.displayHeight;
  
  let targetWidth, targetHeight;
  
  if (displayHeight > displayWidth) {
    // Portrait video - maintain height, calculate width
    targetHeight = targetDimension; // 720
    targetWidth = Math.round((targetHeight * displayWidth) / displayHeight);
  } else {
    // Landscape video - maintain width, calculate height
    targetWidth = targetDimension; // 720
    targetHeight = Math.round((targetWidth * displayHeight) / displayWidth);
  }
  
  // Ensure even dimensions (H.264 requirement)
  return {
    width: targetWidth % 2 === 0 ? targetWidth : targetWidth - 1,
    height: targetHeight % 2 === 0 ? targetHeight : targetHeight - 1
  };
}
```

### Examples

#### Landscape 1920×1080 → 1280×720
```
Original: 1920×1080 (16:9 aspect ratio)
Max dimension: 1920 > 720 → Scale required
Target: 1280×720 (maintains 16:9 ratio)
```

#### Portrait 1080×1920 → 405×720
```
Original: 1080×1920 (9:16 aspect ratio)
Max dimension: 1920 > 720 → Scale required
Target: 405×720 (maintains 9:16 ratio)
```

#### Square 1024×1024 → 720×720
```
Original: 1024×1024 (1:1 aspect ratio)
Max dimension: 1024 > 720 → Scale required
Target: 720×720 (maintains 1:1 ratio)
```

#### Already Small 640×480 → 640×480
```
Original: 640×480 (4:3 aspect ratio)
Max dimension: 640 ≤ 720 → Keep original
Target: 640×480 (no scaling)
```

### Rotation Handling

The system correctly handles rotated videos:

```javascript
// Extract rotation from metadata
if (videoStream.side_data_list) {
  for (const sideData of videoStream.side_data_list) {
    if (sideData.side_data_type === 'Display Matrix') {
      rotation = sideData.rotation; // -90, 90, 180
      break;
    }
  }
}

// Adjust display dimensions for rotation
if (rotation === 90 || rotation === -90) {
  displayWidth = videoStream.height;
  displayHeight = videoStream.width;
}
```

## File Format Normalization

### Target Format

All normalized videos are output as:

- **Container**: MP4 (ISO Base Media File Format)
- **Video Codec**: H.264 (AVC)
- **Audio Codec**: AAC
- **Fast Start**: Enabled (`-movflags +faststart`)

### Codec Selection

**Video Codec**:
- Always H.264 for maximum compatibility
- Software encoder (libx264) for reliability
- CRF 23 for good quality/size balance

**Audio Codec**:
- Always AAC for maximum compatibility
- 128 kbps bitrate for good quality

### Fast Start

The `-movflags +faststart` flag:
- Moves metadata to the beginning of the file
- Enables progressive download/streaming
- Allows video playback to start before full download
- Essential for web streaming

## IPFS Integration

### Leither Command

The normalized file is uploaded to IPFS using Leither shell command:

```bash
Leither ipfs add /path/to/normalized.mp4
```

**Why Shell Command?**:
- Consistent with other endpoints (convert-video, process-zip)
- Direct communication with IPFS network
- Simple and reliable
- No need for intermediate storage

### CID Format

The system supports both:
- **CIDv0**: `Qm...` (44 characters)
- **CIDv1**: `baf...` (56+ characters)

### Error Handling

```javascript
try {
  const cidOutput = await executeLeitherCommand(`ipfs add ${filePath}`, requestId);
  const cid = extractCID(cidOutput);
  if (!cid) {
    throw new Error('Failed to extract CID from Leither output');
  }
  return cid;
} catch (error) {
  throw new Error(`IPFS upload failed: ${error.message}`);
}
```

## Client Integration

### Using normalizeVideo Function

```typescript
import { normalizeVideo } from '@/utils/uploadUtils';

async function uploadSmallVideo(file: File) {
  try {
    const cid = await normalizeVideo(
      file,
      baseUrl,
      cloudDrivePort,
      (progress) => {
        console.log(`Progress: ${progress}%`);
        // Update UI progress bar
      }
    );
    console.log('Video normalized, CID:', cid);
    return cid;
  } catch (error) {
    console.error('Normalization failed:', error);
    // Handle error or fallback
  }
}
```

### Automatic Selection in EditorModal

The client automatically selects normalization for videos <50MB:

```typescript
if (file.size <= SMALL_VIDEO_THRESHOLD_BYTES) {
  // Use normalization endpoint
  cid = await normalizeVideo(file, baseUrl, cloudDrivePort, onProgress);
} else {
  // Use HLS conversion endpoint
  cid = await uploadVideo(file, baseUrl, cloudDrivePort, onProgress);
}
```

### Progress Tracking

Progress is tracked through different stages:

```typescript
// 0-10%: Initial upload
// 10-30%: Video analysis
// 30-80%: MP4 normalization
// 80-95%: IPFS upload
// 95-100%: Complete
```

## Error Handling

### Common Errors

#### File Too Large

```json
{
  "success": false,
  "message": "File size 55.23MB exceeds the maximum allowed size of 50MB for normalization."
}
```

**Solution**: Use the HLS conversion endpoint for videos >50MB.

#### Invalid Video Format

```json
{
  "success": false,
  "message": "No video stream found"
}
```

**Solution**: Ensure the file is a valid video format.

#### FFmpeg Conversion Failed

```json
{
  "success": false,
  "message": "Video normalization failed: FFmpeg conversion error"
}
```

**Solutions**:
- Check video file integrity
- Verify FFmpeg installation
- Check system resources (disk space, memory)

#### IPFS Upload Failed

```json
{
  "success": false,
  "message": "Failed to extract CID from Leither output"
}
```

**Solutions**:
- Verify Leither service is running
- Check LEITHER_PATH environment variable
- Verify network connectivity to IPFS

### Fallback Strategy

If normalization fails, the client automatically falls back to:

```typescript
// Direct IPFS upload (same as other file types)
const fsid = await tweetStore.openTempFile();
const cid = await readFileSlice(fsid, await file.arrayBuffer(), 0, index);
```

## Performance

### Processing Time

Typical processing times for normalized videos:

| Video Size | Resolution | Processing Time |
|------------|------------|-----------------|
| 5MB | 720p | 5-10 seconds |
| 20MB | 720p | 15-30 seconds |
| 50MB | 1080p→720p | 30-60 seconds |

**Factors**:
- Original resolution (scaling takes more time)
- Codec (copy mode is faster than re-encoding)
- System resources (CPU, disk I/O)
- IPFS network speed

### Optimization Tips

1. **Use copy mode when possible**: If source is already H.264, copy mode is much faster
2. **Lower resolution**: Videos already ≤720p don't need scaling
3. **Fast storage**: Use SSD for temporary files
4. **Network speed**: Faster IPFS network = faster upload

## Troubleshooting

### Issue: Normalization Takes Too Long

**Symptoms**: Processing takes >2 minutes for 50MB file

**Solutions**:
- Check CPU usage: `top` or `htop`
- Verify disk space: `df -h`
- Check FFmpeg process: `ps aux | grep ffmpeg`
- Monitor system resources during processing

### Issue: Output Quality is Poor

**Symptoms**: Normalized video looks worse than original

**Solutions**:
- Lower CRF value (e.g., 20 instead of 23) for better quality
- Check source video quality
- Avoid unnecessary re-encoding (use copy mode when possible)

### Issue: Aspect Ratio is Wrong

**Symptoms**: Normalized video appears stretched or squished

**Solutions**:
- Verify rotation metadata is correctly read
- Check original video dimensions
- Ensure `force_original_aspect_ratio=decrease` is used

### Issue: CID is Invalid

**Symptoms**: CID returned but cannot access video on IPFS

**Solutions**:
- Verify CID format (Qm... or baf...)
- Check IPFS network connectivity
- Verify Leither service is properly configured
- Test with known working CID

## Comparison with HLS Conversion

### When to Use Normalization

- ✅ Video ≤ 50MB
- ✅ Simple MP4 format is sufficient
- ✅ Fast processing is priority
- ✅ Direct IPFS storage needed

### When to Use HLS Conversion

- ✅ Video > 50MB
- ✅ Adaptive bitrate streaming needed
- ✅ Multiple quality levels desired
- ✅ Long-form content
- ✅ Better streaming performance needed

### Feature Comparison

| Feature | Normalization | HLS Conversion |
|---------|--------------|----------------|
| **File Size Limit** | 50MB | 4GB |
| **Output Format** | MP4 | HLS (M3U8 + TS) |
| **Quality Levels** | Single | Multiple (720p, 480p) |
| **Processing Time** | Fast (seconds) | Slower (minutes) |
| **Adaptive Streaming** | ❌ | ✅ |
| **Browser Support** | ✅ Excellent | ✅ Excellent |
| **File Size** | Optimized | Larger (multiple streams) |

## Best Practices

1. **File Size Check**: Always check file size before selecting endpoint
2. **Error Handling**: Implement fallback to direct IPFS upload
3. **Progress Feedback**: Show progress to users during processing
4. **Timeout Handling**: Set appropriate timeouts (10 minutes for normalization)
5. **Cleanup**: Always cleanup temporary files after processing
6. **Logging**: Log all normalization steps for debugging
7. **Testing**: Test with various video formats and resolutions
8. **Monitoring**: Monitor normalization success rate and processing times

## Further Reading

- [Video Conversion Guide](VIDEO_CONVERSION.md) - HLS conversion for large videos
- [API Documentation](API.md) - Complete API reference
- [Architecture Overview](ARCHITECTURE.md) - System architecture
- [FFmpeg Documentation](https://ffmpeg.org/documentation.html) - FFmpeg reference

