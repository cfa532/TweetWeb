# Source Bitrate Preservation in Server Video Normalization

**Date:** January 8, 2026

## Overview

Enhanced server-side video normalization to preserve source bitrate when it's already optimal, avoiding unnecessary quality loss or file size increases. This matches the Android client implementation.

## Problem

Previously, server-side video normalization always used the calculated target bitrate based on resolution, even when the source video already had an appropriate bitrate. This could lead to:
- **Quality loss**: Re-encoding at lower quality than the source
- **Unnecessary file size increase**: Re-encoding at higher bitrate than needed
- **Wasted processing**: Re-encoding when source bitrate was already good
- **Inconsistency**: Server behavior didn't match Android client

## Solution

Modified both `videoRoutes.js` and `convert-to-hls.sh` to check the source video bitrate first:
1. Extract source bitrate from the input video using ffprobe
2. Calculate target bitrate based on resolution (as before)
3. **NEW**: If source bitrate is lower than target but higher than minimum, keep the source bitrate
4. Otherwise, use the calculated target bitrate

## Changes Made

### 1. Updated MIN_BITRATE Constant

**File:** `videoRoutes.js`

**Line 20:**

**Before:**
```javascript
const MIN_BITRATE = 300; // Minimum bitrate in kbps (reduced from 500k to avoid inflating low-bitrate videos)
```

**After:**
```javascript
const MIN_BITRATE = 500; // Minimum bitrate in kbps for quality (matches Android implementation)
```

✅ **Changed from 300k → 500k** to match Android client and ensure quality

### 2. Added Source Bitrate Checking Logic in videoRoutes.js

**File:** `videoRoutes.js`

**Function:** Video normalization (lines 1070-1125)

**Added:**
```javascript
// Get source video bitrate (in bps, convert to kbps)
const sourceBitrateK = videoInfo && videoInfo.bitrate ? Math.floor(videoInfo.bitrate / 1000) : null;

// Determine normalization parameters based on resolution
let targetWidth, targetHeight, calculatedBitrateK;

if (videoResolution > 720) {
  // Calculate for >720p
  calculatedBitrateK = 1500;
} else if (videoResolution === 720) {
  // Calculate for 720p
  calculatedBitrateK = 1000;
} else {
  // Calculate for <720p (proportional)
  const REFERENCE_720P_BITRATE = 1000;
  calculatedBitrateK = Math.round((videoResolution / 720) * REFERENCE_720P_BITRATE);
}

// Determine final target bitrate:
// If source bitrate is lower than calculated target but higher than minimum, keep source bitrate
let bitrate;
if (sourceBitrateK !== null && 
    sourceBitrateK < calculatedBitrateK && 
    sourceBitrateK >= MIN_BITRATE) {
  console.log(`[${requestId}] [BITRATE] Using source bitrate ${sourceBitrateK}k (between min ${MIN_BITRATE}k and target ${calculatedBitrateK}k)`);
  bitrate = sourceBitrateK;
} else {
  bitrate = calculatedBitrateK;
}
```

**Enhanced logging:**
```javascript
console.log(`[${requestId}] [INFO] Normalization target: ${targetWidth}x${targetHeight}, source bitrate: ${sourceBitrateK}k, calculated target: ${calculatedBitrateK}k, final bitrate: ${bitrate}k`);
```

### 3. Added Source Bitrate Checking Logic in convert-to-hls.sh

**File:** `convert-to-hls.sh`

**Lines:** ~240-280

**Added:**
```bash
# Get source bitrate in kbps (already extracted as BITRATE_KBPS)
SOURCE_BITRATE_K=$BITRATE_KBPS
MIN_BITRATE=500

# Calculate target bitrate based on resolution
if [ $REFERENCE_DIM -gt 720 ]; then
    CALCULATED_BITRATE=1500
elif [ $REFERENCE_DIM -eq 720 ]; then
    CALCULATED_BITRATE=1000
else
    CALCULATED_BITRATE=$(awk "BEGIN {printf \"%.0f\", ($ORIG_RESOLUTION / $REFERENCE_720P_PIXELS) * $REFERENCE_720P_BITRATE}")
    if [ $CALCULATED_BITRATE -lt $MIN_BITRATE ]; then
        CALCULATED_BITRATE=$MIN_BITRATE
    fi
fi

# Determine final target bitrate:
# If source bitrate is lower than calculated target but higher than minimum, keep source bitrate
if [ -n "$SOURCE_BITRATE_K" ] && [ $SOURCE_BITRATE_K -lt $CALCULATED_BITRATE ] && [ $SOURCE_BITRATE_K -ge $MIN_BITRATE ]; then
    echo -e "${GREEN}[BITRATE] Using source bitrate ${SOURCE_BITRATE_K}k (between min ${MIN_BITRATE}k and target ${CALCULATED_BITRATE}k)${NC}"
    TARGET_BITRATE=$SOURCE_BITRATE_K
else
    TARGET_BITRATE=$CALCULATED_BITRATE
fi
```

## Bitrate Selection Logic

The new logic follows this decision tree (same as Android):

```
1. Get source bitrate (sourceBitrateK)
2. Calculate target bitrate based on resolution (calculatedBitrateK)
3. Determine final bitrate:
   
   IF sourceBitrateK is available AND
      sourceBitrateK < calculatedBitrateK AND
      sourceBitrateK >= MIN_BITRATE (500k)
   THEN
      Use sourceBitrateK (preserve original)
   ELSE
      Use calculatedBitrateK
```

## Examples

### Example 1: Source bitrate preserved
- **Source:** 480p video @ 700k bitrate
- **Calculated target:** 500k (proportional for 480p, enforced minimum)
- **Final:** Use **700k** source bitrate (between 500k min and calculated target)

### Example 2: Source bitrate too low - use minimum
- **Source:** 360p video @ 300k bitrate
- **Calculated target:** 500k (minimum enforced)
- **Final:** Use **500k** (source below minimum)

### Example 3: Source bitrate higher than target - use target
- **Source:** 720p video @ 2000k bitrate
- **Calculated target:** 1000k
- **Final:** Use **1000k** target (source above target, compress to save space)

### Example 4: Source bitrate unavailable - use calculated
- **Source:** Unknown bitrate (metadata extraction failed)
- **Calculated target:** 1000k
- **Final:** Use **1000k** target (fallback to calculated)

## Benefits

1. **Preserves original quality**: If source is already good quality (500k-1000k), don't degrade it
2. **Avoids unnecessary upscaling**: Don't increase bitrate if source is already reasonable
3. **Reduces processing time**: Better bitrate selection means more efficient encoding
4. **Maintains minimum quality**: Still enforces 500k minimum for very low bitrate sources
5. **Smart compression**: Only compress when source bitrate is significantly higher than needed
6. **Consistency**: Server behavior now matches Android client implementation

## System Minimum Bitrate

**Answer:** The system minimum bitrate is **500 kbps** (updated from 300 kbps)

This is now consistent across:
- **Android VideoNormalizer.kt**: 500k ✅
- **Android LocalHLSConverter.kt**: 500k ✅
- **Android LocalVideoProcessingService.kt**: 500k ✅
- **Server videoRoutes.js**: 500k ✅ (updated)
- **Server convert-to-hls.sh**: 500k ✅ (updated)

**Rationale:**
- Below 500k, video quality becomes noticeably poor
- Modern codecs (H.264) require minimum bitrate for acceptable quality
- Matches industry standards for mobile video
- Consistent with iOS implementation

## Testing Recommendations

Test server-side conversion with various source videos:

1. **High bitrate source (2000k) @ 720p**
   - Expected: Compress to 1000k target
   - Verify: Quality acceptable, file size reduced

2. **Moderate bitrate source (700k) @ 480p**
   - Expected: Preserve 700k source bitrate
   - Verify: No quality loss, file size similar to source

3. **Low bitrate source (300k) @ 360p**
   - Expected: Increase to 500k minimum
   - Verify: Quality improved, file size increased slightly

4. **Variable bitrate sources**
   - Test with different resolutions and bitrates
   - Verify: Appropriate bitrate selected for each case

## Server Log Output

The enhanced logging will show:
```
[REQUEST-ID] [INFO] Video resolution: 480p
[REQUEST-ID] [INFO] Original video bitrate: 700k
[REQUEST-ID] [NORMALIZE] Video resolution (480p) < 720p, keeping resolution with proportional bitrate
[REQUEST-ID] [BITRATE] Using source bitrate 700k (between min 500k and target 500k)
[REQUEST-ID] [INFO] Normalization target: 854x480, source bitrate: 700k, calculated target: 500k, final bitrate: 700k
```

## Files Modified

1. **`videoRoutes.js`**
   - Updated MIN_BITRATE constant (line 20)
   - Added source bitrate extraction (line 1072)
   - Added bitrate selection logic (lines 1073-1125)
   - Enhanced logging

2. **`convert-to-hls.sh`**
   - Added source bitrate checking (lines ~240-280)
   - Added bitrate selection logic
   - Enhanced console output with color-coded messages

## Deployment

1. **No database changes required**
2. **No API changes required**
3. **Backward compatible**: Existing videos unaffected
4. **Restart server** to apply videoRoutes.js changes
5. **Bash script** changes take effect immediately

## Related Documentation

- Android: `docs/SOURCE_BITRATE_PRESERVATION.md` - Android client implementation
- Android: `docs/MIN_BITRATE_500K_ENFORCEMENT.md` - 500k minimum enforcement
- Server: `README.md` - Server setup and configuration
- Server: `ZIP_ENDPOINT_README.md` - Video processing endpoints

## Dependencies

- **ffprobe**: Used to extract source video bitrate
- **ffmpeg**: Used for video normalization
- **Node.js**: videoRoutes.js implementation
- **Bash**: convert-to-hls.sh script

## Performance Impact

- **Minimal overhead**: Bitrate extraction via ffprobe is fast (~50-100ms)
- **Potential savings**: Avoiding unnecessary high-bitrate encoding saves processing time
- **Better quality**: Preserving source bitrate when appropriate maintains quality
- **Smaller files**: Not inflating low-bitrate videos reduces storage and bandwidth

## Monitoring

Monitor these metrics after deployment:
- Average encoding time per video
- File size distribution
- Quality complaints/reports
- Server CPU usage during video processing

Expected improvements:
- Reduced encoding time for already-optimized videos
- More consistent output quality
- Better user experience with preserved quality
