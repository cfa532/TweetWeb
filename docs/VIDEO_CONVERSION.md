# Video Conversion Guide

Complete guide to video conversion, encoding, and HLS streaming in TweetWeb.

## Table of Contents

- [Overview](#overview)
- [Conversion Algorithm](#conversion-algorithm)
- [Encoder Selection](#encoder-selection)
- [Quality Profiles](#quality-profiles)
- [Processing Flow](#processing-flow)
- [Hardware Acceleration](#hardware-acceleration)
- [FFmpeg Configuration](#ffmpeg-configuration)
- [Performance Optimization](#performance-optimization)
- [Troubleshooting](#troubleshooting)
- [Advanced Topics](#advanced-topics)

## Overview

TweetWeb automatically converts uploaded videos to HLS (HTTP Live Streaming) format with adaptive bitrate streaming. The system intelligently selects the best encoder and quality settings based on the input video properties.

### Key Features

- **Automatic HLS Conversion**: All videos converted to HLS format
- **Dual-Variant Streaming**: High quality + 480p adaptive bitrate
- **Intelligent Normalization**: Resolution-based quality optimization
- **No Upscaling**: Preserves original quality for sub-720p videos
- **Hardware Acceleration**: Support for GPU-based encoding
- **Smart Encoding**: Intelligent encoder selection
- **Proportional Bitrates**: Bitrate scales with resolution
- **Progress Tracking**: Real-time conversion progress
- **Concurrent Processing**: Up to 3 simultaneous conversions

### Supported Input Formats

- MP4 (H.264, H.265, MPEG-4)
- AVI (various codecs)
- MOV/QuickTime
- MKV (Matroska)
- WebM (VP8, VP9)
- WMV (Windows Media)
- FLV (Flash Video)
- M4V, 3GP, OGV

### Output Format

- **Container**: HLS (HTTP Live Streaming)
- **Video Codec**: H.264
- **Audio Codec**: AAC
- **Segment Duration**: Adaptive (4-15 seconds based on resolution/bitrate)
- **Playlist Format**: M3U8

## Conversion Algorithm

The system uses a streamlined normalization approach for all videos:

### Decision Tree

```
1. Check noResample parameter
   ├─ YES: Use copy mode (-c:v copy -c:a copy)
   └─ NO: Continue to normalization

2. Check source video resolution
   ├─ =480p: Single variant 480p @ 500k (like iOS singleVariant480p=true)
   ├─ ≤480p: Single variant original resolution @ 500k (optimization - avoids duplicates)
   └─ >480p: Continue to dual-variant logic

3. For dual variants: normalize video based on resolution
   ├─ Resolution >720p: High quality 720p @ 1500k + 480p @ 667k
   ├─ Resolution =720p: High quality 720p @ 1000k + 480p @ 667k
   └─ Resolution <720p & !=480p: High quality original @ proportional + 480p @ 667k
                        (No upscaling, bitrate = (pixels / 720p_pixels) * 1000k, min 500k)

4. Encoder selection
   └─ Hardware acceleration available?
      ├─ YES: Use hardware encoder (NVIDIA/Intel/Apple/AMD)
      └─ NO: Use software encoder (libx264)

5. Create master playlist for adaptive streaming
```

### 1. No Resample Mode

When `noResample=true`:

```javascript
// Direct stream copy - fastest, no quality change
-c:v copy -c:a copy
-f hls -hls_time 6 -hls_list_size 0
```

**Use Cases**:
- Video already in optimal format
- Quick preview generation
- Testing purposes
- Bandwidth-limited scenarios

**Limitations**:
- No quality adjustment
- No resolution scaling
- No bitrate control
- Single quality only

### 2. Dual-Variant HLS Output

All videos are converted to dual-variant HLS with adaptive bitrate streaming:

**High Quality Variant** (labeled as 720p):
- **Resolution >720p** (e.g., 1080p, 4K): Downscaled to 720p @ 1500 kbps
- **Resolution =720p**: Kept at 720p @ 1000 kbps
- **Resolution <720p** (e.g., 480p, 360p): Original resolution @ proportional bitrate
  - Formula: `(pixels / 921,600) * 1000k` (minimum 500k)
  - Example: 480p (409,920 pixels) = 445k

**480p Variant**:
- Fixed bitrate: 667 kbps (proportional to 720p @ 1000k)
- Resolution: Scaled to 480p (don't upscale if source is lower)
- Always included for network adaptability

**Master Playlist**:
- Enables automatic quality switching
- Adapts to network conditions
- Seamless transition between variants

**Benefits**:
- Adaptive bitrate streaming for all network conditions
- No upscaling artifacts
- Optimized bandwidth usage
- Better user experience across devices

## Normalization Bitrate Strategy

The system uses **intelligent bitrate normalization** based on video resolution to ensure optimal streaming performance.

### How It Works

1. **Analyzes Resolution**: Determines original video resolution
2. **Applies Normalization Rules**: Based on resolution category
3. **Calculates Proportional Bitrate**: For sub-720p videos

### Normalization Rules

| Original Resolution | Target Resolution | Bitrate | Calculation |
|---------------------|-------------------|---------|-------------|
| **>720p** (1080p, 4K, etc.) | 720p | 1500 kbps | Fixed at 1500k |
| **=720p** | 720p | 1000 kbps | Fixed at 1000k |
| **<720p** (480p, 360p, etc.) | Original (no upscaling) | Proportional | (pixels / 921,600) * 1000k, min 500k |

### Proportional Bitrate Calculation

For videos with resolution <720p:

```javascript
// 720p reference: 1280x720 = 921,600 pixels
// Base bitrate: 1000 kbps

bitrate = (original_width * original_height / 921600) * 1000
bitrate = Math.max(bitrate, 500) // Minimum 500 kbps
```

### Benefits

- **No Upscaling**: Lower resolution videos maintain original quality
- **Optimized for Streaming**: Higher resolution videos normalized to efficient streaming size
- **Proportional Quality**: Bitrate scales with pixel count
- **Consistent Performance**: Predictable bandwidth usage

### Examples

**Example 1: 4K Video (3840×2160)**
- Original: 3840×2160 pixels
- High quality variant: 1280×720 @ 1500 kbps
- 480p variant: 854×480 @ 667 kbps
- Result: Excellent streaming quality with adaptive bitrate

**Example 2: 720p Video (1280×720)**
- Original: 1280×720 pixels
- High quality variant: 1280×720 @ 1000 kbps (no rescaling)
- 480p variant: 854×480 @ 667 kbps
- Result: Optimized bitrate with fallback option

**Example 3: 480p Video (854×480)**
- Original: 854×480 = 409,920 pixels
- **Single variant mode** (like iOS): 854×480 @ 500k minimum bitrate
- Result: Optimized single quality for 480p content, no duplicate variants

**Example 4: 360p Video (640×360)**
- Original: 640×360 = 230,400 pixels
- **Single variant mode** (optimization): 640×360 @ 500k minimum bitrate
- **Simplified structure**: playlist.m3u8 and segments at root level (no subdirectories)
- Result: Efficient single quality - avoids creating duplicate identical variants

### HLS Directory Structure

#### Single Variant (≤480p videos):
```
hls/
├── master.m3u8        # Master playlist (redirects to playlist.m3u8)
├── playlist.m3u8      # Media playlist with segments
├── segment000.ts     # Video segments
├── segment001.ts
└── ...
```

#### Dual Variant (>480p videos):
```
hls/
├── master.m3u8        # Master playlist with 2 streams
├── 720p/
│   ├── playlist.m3u8
│   └── segment*.ts
└── 480p/
    ├── playlist.m3u8
    └── segment*.ts
```

**Example 4: 360p Video (640×360)**
- Original: 640×360 = 230,400 pixels  
- High quality variant: 640×360 @ 500 kbps (no upscaling)
  - Calculation: (230,400 / 921,600) * 1000 = 250k → 500k (minimum)
- 480p variant: 640×360 @ 500 kbps (no upscaling from 360p to 480p)
- Result: Minimum viable streaming quality, adaptive capabilities

### Algorithm Summary

The adaptive normalization algorithm provides:

✅ **Smart Variant Selection**: Single variant for ≤480p videos (480p like iOS, others optimization)
✅ **Adaptive Streaming**: Quality variants based on content resolution and network needs
✅ **No Upscaling**: Videos maintain original resolution when beneficial
✅ **Optimized Streaming**: >720p normalized to 720p @ 1500k, others proportional
✅ **Consistent Bitrates**: Predictable bandwidth (500-1500k range with minimums)
✅ **Quality Preservation**: Proportional bitrates prevent degradation
✅ **Efficiency Optimization**: Eliminates duplicate identical variants for low-res content
✅ **Cross-Platform Consistency**: Matches iOS app behavior with intelligent optimizations

**Performance Characteristics**:
- **Max Concurrent**: 3 simultaneous conversions
- **Hardware Acceleration**: 5-10x faster than software
- **Conversion Mode**: Parallel for dual variants, sequential for single variants
- **Typical Conversion Times**:
  - <10MB: ~10-30 seconds (single/dual variants)
  - 50-200MB: ~1-5 minutes (single/dual variants)
  - 500MB+: ~5-20 minutes (single/dual variants)
  - 4K videos: ~10-30 minutes (includes downscaling to 720p + 480p)

## Encoder Selection

### Copy Encoder (Stream Copy)

The copy encoder is the **fastest** option but is only used in `noResample` mode.

#### When Copy Encoder is Used

Copy encoder is **only** used when:

1. **noResample flag is set**: User explicitly requests no re-encoding
2. **Quick preview mode**: For testing or preview purposes

#### Normal Operation (Always Re-encodes)

In normal operation, the system **always re-encodes** to ensure:

1. **Consistent Quality**: All videos normalized to optimal streaming bitrates
2. **Resolution Optimization**: >720p videos downscaled to 720p
3. **Bitrate Control**: Precise bitrate management for streaming
4. **Format Compatibility**: Ensures H.264/AAC compatibility

```javascript
// Normal operation always uses encoder (hardware or software)
const encoder = detectHardwareEncoder() || 'libx264';
```

#### Copy Mode (noResample=true)

When `noResample=true`, performs fast stream copy:

```bash
ffmpeg -i input.mp4 -c:v copy -c:a copy \
  -f hls -hls_time 6 -hls_list_size 0 \
  -hls_segment_filename 'segment%03d.ts' \
  -hls_flags discont_start+split_by_time \
  playlist.m3u8
```

**Limitations**:
- No quality adjustment
- No resolution scaling
- No bitrate control
- Must be compatible codec (H.264/H.265)

### Hardware Encoders

#### Priority Order

1. **NVIDIA (h264_nvenc)**
   - Best performance
   - CUDA-based encoding
   - Supports 10-bit encoding
   - Quality: Excellent
   - Speed: Very Fast

2. **Intel (h264_qsv)**
   - QuickSync Video
   - CPU integrated graphics
   - Good performance
   - Quality: Very Good
   - Speed: Fast

3. **Apple (h264_videotoolbox)**
   - Apple Silicon (M1/M2/M3/M4)
   - VideoToolbox framework
   - Optimized for macOS
   - Quality: Excellent
   - Speed: Very Fast

4. **AMD (h264_amf)**
   - AMD GPUs
   - Good performance
   - Quality: Good
   - Speed: Fast

#### Encoder Testing

Before using a hardware encoder, the system tests it:

```bash
# Test command
ffmpeg -f lavfi -i testsrc=duration=1:size=320x240:rate=1 \
  -c:v h264_nvenc -f null - 2>&1
```

If test fails, fallback to next encoder in priority list.

### Software Encoder (libx264)

Fallback when no hardware acceleration available.

**Configuration**:
```bash
-c:v libx264
-preset fast         # Fast encoding
-tune zerolatency   # Low latency
-threads 2          # CPU threads
```

**Characteristics**:
- Universal compatibility
- Good quality
- Slower than hardware
- Higher CPU usage

## Adaptive Segment Duration

The system automatically calculates optimal HLS segment duration based on video characteristics:

### Segment Duration Algorithm

```javascript
function calculateOptimalSegmentDuration(videoInfo, bitrate) {
  const resolution = width * height;
  let segmentDuration = 6; // Default 6 seconds
  
  // Adjust based on resolution
  if (resolution >= 1920 * 1080) {
    segmentDuration = 12; // 1080p+: 12 seconds
  } else if (resolution >= 1280 * 720) {
    segmentDuration = 10; // 720p: 10 seconds
  } else if (resolution >= 854 * 480) {
    segmentDuration = 8;  // 480p: 8 seconds
  } else {
    segmentDuration = 6;  // Lower: 6 seconds
  }
  
  // Adjust based on bitrate
  if (bitrate > 2000) {
    segmentDuration = Math.min(segmentDuration + 2, 15); // Cap at 15s
  } else if (bitrate < 500) {
    segmentDuration = Math.max(segmentDuration - 2, 4);   // Cap at 4s
  }
  
  return segmentDuration;
}
```

### Segment Duration Table

| Resolution | Base Duration | High Bitrate (>2Mbps) | Low Bitrate (<500kbps) |
|------------|---------------|------------------------|-------------------------|
| **1080p+** | 12 seconds | 14 seconds | 10 seconds |
| **720p** | 10 seconds | 12 seconds | 8 seconds |
| **480p** | 8 seconds | 10 seconds | 6 seconds |
| **Lower** | 6 seconds | 8 seconds | 4 seconds |

### Benefits of Adaptive Segments

**Longer Segments (High Resolution)**:
- Better compression efficiency
- Fewer HTTP requests
- Reduced overhead
- Better for high-quality content

**Shorter Segments (Low Resolution)**:
- Faster initial loading
- Better for mobile networks
- More responsive seeking
- Better for low-bandwidth scenarios

## Quality Profile

### Single Normalized Stream

All videos are normalized to a single optimized quality:

**Video Encoding**:
- Resolution: Depends on original (see normalization rules)
- Bitrate: Resolution-dependent (500k - 1500k)
- Codec: H.264
- Profile: High
- Level: 4.1
- GOP Size: 30 frames
- Keyframe Interval: 30 frames

**Audio Encoding**:
- Codec: AAC
- Bitrate: 128 kbps
- Sample Rate: 48 kHz
- Channels: Stereo

**Scaling** (when needed):
```bash
-vf "scale=WIDTH:HEIGHT:flags=lanczos:force_original_aspect_ratio=decrease:force_divisible_by=2"
```

**HLS Parameters**:
- Segment Duration: Adaptive (4-15 seconds based on resolution/bitrate)
- Playlist Type: Single quality
- Container: MPEG-TS (.ts segments)
- Playlist Format: M3U8

### Aspect Ratio Preservation

The system preserves the original aspect ratio:

```javascript
// Portrait video (9:16)
if (displayHeight > displayWidth) {
  targetHeight = 720;
  targetWidth = Math.round((720 * displayWidth) / displayHeight);
  // Result: 405x720 (maintains 9:16 ratio)
}

// Landscape video (16:9)
else {
  targetWidth = 720;
  targetHeight = Math.round((720 * displayHeight) / displayWidth);
  // Result: 1280x720 (maintains 16:9 ratio)
}
```

### Even Dimension Enforcement

H.264 requires even dimensions:

```javascript
function ensureEvenDimensions(width, height) {
  return {
    width: width % 2 === 0 ? width : width - 1,
    height: height % 2 === 0 ? height : height - 1
  };
}
```

## Processing Flow

### Step-by-Step Process

#### 1. Upload & Validation (0-20%)

```javascript
// Validate file
if (!req.files || !req.files.videoFile) {
  return error('No video file uploaded');
}

// Check file size (max 4GB)
if (uploadedFile.size > 4 * 1024 * 1024 * 1024) {
  return error('File too large');
}

// Validate file type
const allowedTypes = ['video/mp4', 'video/avi', ...];
if (!allowedTypes.includes(uploadedFile.mimetype)) {
  return error('Invalid file type');
}
```

#### 2. Video Analysis (20-40%)

```bash
# Extract metadata using ffprobe
ffprobe -v quiet -print_format json -show_format -show_streams input.mp4
```

**Extracted Information**:
- Dimensions (width × height)
- Rotation metadata
- Codec (h264, hevc, etc.)
- Bit depth (8-bit, 10-bit)
- Duration
- Pixel format
- Profile (Main, High, etc.)

#### 3. Encoder Detection (40%)

```javascript
// Detect available encoders
const command = 'ffmpeg -hide_banner -encoders | grep h264';

// Test each encoder
const nvidiaWorks = await testHardwareEncoder('h264_nvenc');
const intelWorks = await testHardwareEncoder('h264_qsv');
// ...

// Select optimal encoder
const encoder = selectOptimalEncoder(availableEncoders, videoInfo);
```

#### 4. HLS Conversion (40-80%)

**Single Normalized Quality**:
```bash
# Example: 1080p video normalized to 720p @ 1500k
ffmpeg -i input.mp4 \
  -c:v h264_nvenc \
  -c:a aac -b:a 128k \
  -vf "scale=1280:720:flags=lanczos:force_original_aspect_ratio=decrease:force_divisible_by=2" \
  -b:v 1500k \
  -preset fast -tune zerolatency -threads 2 \
  -fflags +genpts+igndts+flush_packets \
  -avoid_negative_ts make_zero -max_interleave_delta 0 \
  -f hls -hls_time ${segmentDuration} -hls_list_size 0 \
  -hls_segment_filename 'segment%03d.ts' \
  -hls_flags discont_start+split_by_time \
  playlist.m3u8
```

**Examples by Resolution**:

```bash
# 4K video (3840×2160) → 720p @ 1500k
ffmpeg -i 4k_input.mp4 -vf "scale=1280:720" -b:v 1500k ... playlist.m3u8

# 720p video (1280×720) → 720p @ 1000k (no rescaling)
ffmpeg -i 720p_input.mp4 -vf "scale=1280:720" -b:v 1000k ... playlist.m3u8

# 480p video (854×480) → 480p @ ~445k (no upscaling)
ffmpeg -i 480p_input.mp4 -vf "scale=854:480" -b:v 445k ... playlist.m3u8
```

**Examples by Resolution**:

```bash
# 4K video (3840×2160) → 720p @ 1500k
ffmpeg -i 4k_input.mp4 -vf "scale=1280:720" -b:v 1500k ... playlist.m3u8

# 720p video (1280×720) → 720p @ 1000k (no rescaling)
ffmpeg -i 720p_input.mp4 -vf "scale=1280:720" -b:v 1000k ... playlist.m3u8

# 480p video (854×480) → 480p @ ~445k (no upscaling)
ffmpeg -i 480p_input.mp4 -vf "scale=854:480" -b:v 445k ... playlist.m3u8
```

#### 5. IPFS Upload (60-95%)

```javascript
// Connect to Leither service using centralized connection manager
const leitherClient = await global.getLeitherConnection();

// Login
const ppt = await leitherClient.GetVarByContext("", "context_ppt", []);
const api = await leitherClient.Login(ppt);

// Upload to IPFS
const cid = await leitherClient.IpfsAdd(api.sid, tempDir);

// Release connection back to pool
global.releaseLeitherConnection(leitherClient);

console.log('IPFS CID:', cid);
```

#### 6. Cleanup (95-100%)

```javascript
// Remove temporary uploaded file
fs.unlinkSync(uploadedFile.tempFilePath);

// Temporary HLS directory is preserved for debugging
// but will be cleaned up after 1 hour
```

## Hardware Acceleration

### NVIDIA NVENC

**Setup**:
```bash
# Check NVIDIA drivers
nvidia-smi

# Install CUDA toolkit
sudo apt install nvidia-cuda-toolkit

# Verify FFmpeg support
ffmpeg -encoders | grep nvenc
```

**Configuration**:
```bash
-c:v h264_nvenc
-rc vbr              # Variable bitrate
-cq 23               # Constant quality (0-51, lower = better)
-b:v 0               # Let CQ control bitrate
-maxrate 5M          # Maximum bitrate
-bufsize 10M         # Buffer size
```

### Intel QuickSync

**Setup**:
```bash
# Install drivers
sudo apt install intel-media-va-driver-non-free

# Verify FFmpeg support
ffmpeg -encoders | grep qsv
```

**Configuration**:
```bash
-c:v h264_qsv
-global_quality 23   # Quality (0-51)
-look_ahead 1        # Enable lookahead
```

### Apple VideoToolbox

**Setup**:
```bash
# Pre-installed on macOS
# Verify FFmpeg support
ffmpeg -encoders | grep videotoolbox
```

**Configuration**:
```bash
-c:v h264_videotoolbox
-allow_sw 1          # Allow software fallback
-q:v 65              # Quality (0-100, higher = better)
-realtime 0          # Prioritize quality over speed
-prio_speed 0        # Prioritize quality
```

### AMD AMF

**Setup**:
```bash
# Install drivers
sudo apt install mesa-va-drivers

# Verify FFmpeg support
ffmpeg -encoders | grep amf
```

**Configuration**:
```bash
-c:v h264_amf
-rc cqp              # Constant QP
-qp_i 23             # I-frame QP
-qp_p 23             # P-frame QP
```

## FFmpeg Configuration

### HLS Parameters

```bash
-f hls                          # HLS format
-hls_time ${segmentDuration}    # Adaptive segment duration (4-15s)
-hls_list_size 0                # Unlimited playlist
-hls_segment_filename 'seg%03d.ts'  # Segment naming
-hls_flags independent_segments+discont_start+split_by_time
```

**Flags Explained**:
- `independent_segments`: Each segment is independently decodable
- `discont_start`: Mark discontinuity at start
- `split_by_time`: Split segments at exact time boundaries

### Timing Parameters

```bash
-max_muxing_queue_size 1024     # Muxing queue size
-fflags +genpts+igndts          # Generate PTS, ignore DTS
-avoid_negative_ts make_zero    # Handle negative timestamps
-max_interleave_delta 0         # Interleaving delta
```

### Video Parameters

```bash
-g 30                           # GOP size (keyframe interval)
-keyint_min 30                  # Minimum keyframe interval
-sc_threshold 0                 # Disable scene change detection
-metadata:s:v:0 rotate=0        # Reset rotation metadata
```

### Scaling Filter

```bash
-vf "scale=1280:720:flags=lanczos:force_original_aspect_ratio=decrease:force_divisible_by=2"
```

**Parameters**:
- `flags=lanczos`: High-quality scaling algorithm
- `force_original_aspect_ratio=decrease`: Maintain aspect ratio
- `force_divisible_by=2`: Ensure even dimensions

## Performance Optimization

### Concurrency Management

```javascript
// Maximum concurrent conversions
const maxConcurrentUploads = 3;

// Queue system
const uploadQueue = [];
let activeUploads = 0;

function processUploadQueue() {
  while (uploadQueue.length > 0 && activeUploads < maxConcurrentUploads) {
    const job = uploadQueue.shift();
    activeUploads++;
    processVideoUpload(job);
  }
}
```

### Encoder Caching

```javascript
// Cache encoder detection for 5 minutes
let hardwareEncoderCache = null;
let hardwareEncoderCacheTime = 0;
const HARDWARE_CACHE_DURATION = 5 * 60 * 1000;

if (hardwareEncoderCache && (Date.now() - hardwareEncoderCacheTime) < HARDWARE_CACHE_DURATION) {
  return hardwareEncoderCache;
}
```

### Memory Management

```javascript
// Limit stderr buffer to prevent memory pressure
let stderrBuffer = '';
child.stderr.on('data', (chunk) => {
  if (stderrBuffer.length < 10000) {
    stderrBuffer += chunk.toString();
  }
});
```

### Cleanup

```javascript
// Clean up old temporary files (>1 hour old)
function cleanupOldTempFiles() {
  const files = fs.readdirSync(tempDir);
  const oneHourAgo = Date.now() - (60 * 60 * 1000);
  
  files.forEach(file => {
    if (file.startsWith('hls-convert-')) {
      const stats = fs.statSync(filePath);
      if (stats.mtime.getTime() < oneHourAgo) {
        fs.rmSync(filePath, { recursive: true, force: true });
      }
    }
  });
}
```

## Troubleshooting

### Common Issues

#### 1. FFmpeg Not Found

**Symptom**: `ffmpeg: command not found`

**Solution**:
```bash
# macOS
brew install ffmpeg

# Ubuntu
sudo apt install ffmpeg

# Verify
which ffmpeg
ffmpeg -version
```

#### 2. Hardware Encoder Fails

**Symptom**: Encoder test fails, fallback to software

**Solutions**:
- Update GPU drivers
- Check FFmpeg compilation flags: `ffmpeg -buildconf`
- Verify GPU supports H.264 encoding
- Check system logs for driver errors

#### 3. Slow Conversion

**Symptoms**: Conversion takes very long time

**Solutions**:
- Enable hardware acceleration
- Reduce concurrent conversions
- Use faster preset: `-preset ultrafast`
- Increase thread count: `-threads 4`
- Check CPU/GPU usage: `top` or `nvidia-smi`

#### 4. Quality Issues

**Symptoms**: Output video has artifacts or poor quality

**Solutions**:
- Increase bitrate: `-b:v 3000k`
- Use better preset: `-preset slow`
- Adjust CRF/CQ value: `-cq 20` (lower = better)
- Check source video quality
- Disable hardware encoding if quality is poor

#### 5. Audio Sync Issues

**Symptoms**: Audio out of sync with video

**Solutions**:
```bash
# Add timing parameters
-fflags +genpts+igndts
-avoid_negative_ts make_zero
-max_interleave_delta 0

# Force audio sync
-async 1

# Copy timing from source
-copyts
```

#### 6. Segmentation Errors

**Symptoms**: HLS segments are corrupted or missing

**Solutions**:
```bash
# Ensure keyframe alignment
-g 30 -keyint_min 30 -sc_threshold 0

# Force segment duration (adaptive)
-hls_time ${segmentDuration} -hls_flags split_by_time

# Fix timestamp issues
-fflags +genpts
```

### Debug Mode

Enable detailed logging:

```javascript
// Set environment variable
DEBUG=* npm start

// Or in code
console.log(`[${jobId}] [FFMPEG] Command: ${command}`);
console.log(`[${jobId}] [FFMPEG] Stderr: ${stderrBuffer}`);
```

### Log Analysis

```bash
# Check FFmpeg output
tail -f /tmp/ffmpeg-debug.log

# Monitor conversions
watch -n 1 'ls -lh /tmp/hls-convert-*'

# Check IPFS uploads
tail -f /tmp/leither-debug.log
```

## Advanced Topics

### Custom Presets

Create custom encoding presets:

```javascript
const customPresets = {
  'high-quality': {
    video: '-c:v libx264 -preset slow -crf 18',
    audio: '-c:a aac -b:a 192k'
  },
  'fast-encoding': {
    video: '-c:v h264_nvenc -preset fast -cq 25',
    audio: '-c:a aac -b:a 128k'
  },
  'low-bandwidth': {
    video: '-c:v libx264 -preset fast -b:v 500k',
    audio: '-c:a aac -b:a 64k'
  }
};
```

### 10-Bit Encoding

For HDR content:

```bash
# Software (x264)
-c:v libx264 -profile:v high10 -pix_fmt yuv420p10le

# Hardware (NVENC)
-c:v h264_nvenc -pix_fmt yuv420p10le -profile:v high
```

### Multi-Audio Tracks

Support for multiple audio languages:

```bash
# Map multiple audio streams
-map 0:v:0 -map 0:a:0 -map 0:a:1 \
-metadata:s:a:0 language=eng \
-metadata:s:a:1 language=spa
```

### Subtitle Support

Add subtitle tracks to HLS:

```bash
# WebVTT subtitles
-map 0:v:0 -map 0:a:0 -map 0:s:0 \
-c:s webvtt
```

### Live Streaming

Adapt for live streaming:

```bash
-f hls \
-hls_time 2 \              # Shorter segments for lower latency
-hls_list_size 10 \        # Sliding window
-hls_flags delete_segments+append_list
```

## Best Practices

1. **Always test encoders** before production use
2. **Monitor system resources** during conversion
3. **Set appropriate timeouts** for long videos
4. **Use hardware acceleration** when available
5. **Implement retry logic** for failed conversions
6. **Clean up temporary files** regularly
7. **Log detailed information** for debugging
8. **Test different quality profiles** for your use case
9. **Monitor IPFS upload success** rate
10. **Implement progress callbacks** for better UX

## Further Reading

- [FFmpeg Documentation](https://ffmpeg.org/documentation.html)
- [HLS Specification](https://tools.ietf.org/html/rfc8216)
- [NVENC Documentation](https://developer.nvidia.com/nvidia-video-codec-sdk)
- [VideoToolbox Guide](https://developer.apple.com/documentation/videotoolbox)
- [API Documentation](API.md)
- [Setup Guide](SETUP.md)

