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
- **Adaptive Bitrate**: Multiple quality levels (720p, 480p)
- **Hardware Acceleration**: Support for GPU-based encoding
- **Smart Encoding**: Intelligent encoder selection
- **Copy Optimization**: Stream copy for compatible videos
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
- **Segment Duration**: 10 seconds
- **Playlist Format**: M3U8

## Conversion Algorithm

The system uses a three-tier decision tree for optimal conversion:

### Decision Tree

```
1. Check noResample parameter
   ├─ YES: Use copy mode (-c:v copy -c:a copy)
   └─ NO: Continue to step 2

2. Check file size
   ├─ >256MB: Single quality conversion (720p)
   └─ ≤256MB: Multi-quality conversion (720p + 480p)

3. Encoder selection
   ├─ Copy encoder eligible? (see conditions below)
   │  ├─ YES & Single quality: Use copy encoder
   │  └─ NO or Multi-quality: Use hardware/software encoder
   └─ Hardware acceleration available?
      ├─ YES: Use hardware encoder (NVIDIA/Intel/Apple/AMD)
      └─ NO: Use software encoder (libx264)
```

### 1. No Resample Mode

When `noResample=true`:

```javascript
// Direct stream copy - fastest, no quality change
-c:v copy -c:a copy
-f hls -hls_time 10 -hls_list_size 0
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

### 2. Large Files (>256MB)

Single quality 720p conversion:

**Rationale**: Large files take longer to process and consume more memory. Single quality conversion:
- Reduces processing time (50% faster)
- Uses less memory (50% reduction)
- Maintains good quality
- Faster IPFS upload

**Quality**: 720p at 2000 kbps

### 3. Regular Files (≤256MB)

Multi-quality conversion with master playlist:

**Qualities**:
- 720p at 2000 kbps
- 480p at 1000 kbps

**Benefits**:
- Adaptive bitrate streaming
- Better user experience
- Bandwidth optimization
- Quality selection for users

## Encoder Selection

### Copy Encoder (Stream Copy)

The copy encoder is the **fastest** option but has strict requirements.

#### Conditions for Copy Encoder

ALL of the following must be true:

1. **Resolution Requirement**:
   - Landscape: Width ≤ 1280 pixels
   - Portrait: Height ≤ 1280 pixels

2. **Codec Compatibility**:
   - ✅ H.264 (avc, h264)
   - ✅ H.265 (hevc)
   - ❌ MPEG-4 (mpeg4, divx, xvid)
   - ❌ Other incompatible codecs

3. **Quality Mode**:
   - ✅ Single quality mode
   - ❌ Multi-quality mode (cannot scale)

4. **File Size**:
   - Typically used for files >256MB in single quality mode

#### Why No Copy for Multi-Quality?

**Problem**: Copy encoder cannot scale video.

```bash
# This would create IDENTICAL streams
# 720p output: 1920x1080 (original)
# 480p output: 1920x1080 (NOT scaled!)
ffmpeg -i input.mp4 -c:v copy 720p/output.m3u8
ffmpeg -i input.mp4 -c:v copy 480p/output.m3u8
```

**Solution**: System automatically overrides copy encoder for multi-quality:

```javascript
if (encoderConfig.useCopy && isMultiQuality) {
  console.log('[HLS-CONVERSION] Multi-quality conversion detected - overriding COPY encoder');
  encoderConfig.useCopy = false;
  encoderConfig.encoder = hardwareEncoder || 'libx264';
}
```

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

## Quality Profiles

### 720p Stream

**Video**:
- Resolution: 1280x720 (landscape) or scaled proportionally
- Bitrate: 2000 kbps
- Max Bitrate: 2000 kbps
- Buffer Size: 2000 kbps
- GOP Size: 30 frames
- Keyframe Interval: 30 frames

**Audio**:
- Codec: AAC
- Bitrate: 128 kbps
- Channels: Stereo

**Scaling**:
```bash
-vf "scale=1280:720:flags=lanczos:force_original_aspect_ratio=decrease:force_divisible_by=2"
```

### 480p Stream

**Video**:
- Resolution: 854x480 (landscape) or scaled proportionally
- Bitrate: 1000 kbps
- Max Bitrate: 1000 kbps
- Buffer Size: 1000 kbps
- GOP Size: 30 frames
- Keyframe Interval: 30 frames

**Audio**:
- Codec: AAC
- Bitrate: 128 kbps
- Channels: Stereo

**Scaling**:
```bash
-vf "scale=854:480:flags=lanczos:force_original_aspect_ratio=decrease:force_divisible_by=2"
```

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

#### 4. HLS Conversion (40-60%)

**Single Quality**:
```bash
ffmpeg -i input.mp4 \
  -c:v h264_nvenc -rc vbr -cq 23 \
  -c:a aac -b:a 128k \
  -vf "scale=1280:720:flags=lanczos" \
  -b:v 2000k -maxrate 2000k -bufsize 2000k \
  -g 30 -keyint_min 30 -sc_threshold 0 \
  -f hls -hls_time 10 -hls_list_size 0 \
  -hls_segment_filename 'segment%03d.ts' \
  playlist.m3u8
```

**Multi-Quality** (parallel execution):
```bash
# 720p stream
ffmpeg -i input.mp4 ... 720p/playlist.m3u8 &

# 480p stream
ffmpeg -i input.mp4 ... 480p/playlist.m3u8 &

# Wait for both to complete
wait

# Create master playlist
cat > master.m3u8 << EOF
#EXTM3U
#EXT-X-VERSION:3
#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720
720p/playlist.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=854x480
480p/playlist.m3u8
EOF
```

#### 5. IPFS Upload (60-95%)

```javascript
// Connect to Leither service
const leitherClient = await getLeitherConnection();

// Login
const ppt = await leitherClient.GetVarByContext("", "context_ppt", []);
const api = await leitherClient.Login(ppt);

// Upload to IPFS
const cid = await leitherClient.IpfsAdd(api.sid, tempDir);

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
-hls_time 10                    # 10-second segments
-hls_list_size 0                # Unlimited playlist
-hls_segment_filename 'seg%03d.ts'  # Segment naming
-hls_flags delete_segments+independent_segments+discont_start
```

**Flags Explained**:
- `delete_segments`: Delete old segments
- `independent_segments`: Each segment is independently decodable
- `discont_start`: Mark discontinuity at start

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

# Force segment duration
-hls_time 10 -hls_flags split_by_time

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

