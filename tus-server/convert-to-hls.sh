#!/bin/bash

# Script to convert a video file to HLS format (similar to videoRoutes.js)
# Usage: ./convert-to-hls.sh <video_file> [--no-resample]

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check if video file is provided
if [ $# -eq 0 ]; then
    echo -e "${RED}Error: No video file specified${NC}"
    echo "Usage: $0 <video_file> [--no-resample]"
    exit 1
fi

INPUT_FILE="$1"
NO_RESAMPLE=false

# Check for --no-resample flag
if [ "$2" = "--no-resample" ]; then
    NO_RESAMPLE=true
fi

# Check if input file exists
if [ ! -f "$INPUT_FILE" ]; then
    echo -e "${RED}Error: File not found: $INPUT_FILE${NC}"
    exit 1
fi

# Check if ffmpeg and ffprobe are available
if ! command -v ffmpeg &> /dev/null; then
    echo -e "${RED}Error: ffmpeg is not installed${NC}"
    exit 1
fi

if ! command -v ffprobe &> /dev/null; then
    echo -e "${RED}Error: ffprobe is not installed${NC}"
    exit 1
fi

# Function to escape shell arguments
escape_shell_arg() {
    printf '%s' "$1" | sed "s/'/'\"'\"'/g"
}

# Function to ensure even dimensions
ensure_even_dimensions() {
    local width=$1
    local height=$2
    if [ $((width % 2)) -ne 0 ]; then
        width=$((width - 1))
    fi
    if [ $((height % 2)) -ne 0 ]; then
        height=$((height - 1))
    fi
    echo "$width $height"
}

# Function to calculate optimal segment duration
calculate_segment_duration() {
    local resolution=$1
    local bitrate=$2
    local duration=6
    
    # Adjust based on resolution
    if [ $resolution -ge $((1920 * 1080)) ]; then
        duration=12
    elif [ $resolution -ge $((1280 * 720)) ]; then
        duration=10
    elif [ $resolution -ge $((854 * 480)) ]; then
        duration=8
    fi
    
    # Adjust based on bitrate
    if [ $bitrate -gt 2000 ]; then
        duration=$((duration + 2))
        if [ $duration -gt 15 ]; then
            duration=15
        fi
    elif [ $bitrate -lt 500 ]; then
        duration=$((duration - 2))
        if [ $duration -lt 4 ]; then
            duration=4
        fi
    fi
    
    echo $duration
}

# Create temporary directory
TEMP_DIR=$(mktemp -d -t hls-convert-XXXXXX)
echo -e "${GREEN}[INFO] Created temporary directory: $TEMP_DIR${NC}"

# Get file size in bytes
FILE_SIZE=$(stat -f%z "$INPUT_FILE" 2>/dev/null || stat -c%s "$INPUT_FILE" 2>/dev/null)
FILE_SIZE_MB=$(awk "BEGIN {printf \"%.2f\", $FILE_SIZE / 1048576}")
echo -e "${GREEN}[INFO] File size: ${FILE_SIZE_MB}MB${NC}"

if [ "$NO_RESAMPLE" = true ]; then
    echo -e "${YELLOW}[INFO] Using no-resample mode (copy codec)${NC}"
    
    # Simple HLS conversion without resampling
    ESCAPED_INPUT=$(escape_shell_arg "$INPUT_FILE")
    PLAYLIST_PATH=$(escape_shell_arg "$TEMP_DIR/playlist.m3u8")
    SEGMENT_PATH=$(escape_shell_arg "$TEMP_DIR/segment%03d.ts")
    
    ffmpeg -i "$INPUT_FILE" -c:v copy -c:a copy -f hls -hls_time 6 -hls_list_size 0 \
        -hls_segment_filename "$TEMP_DIR/segment%03d.ts" \
        "$TEMP_DIR/playlist.m3u8" -y
    
    echo -e "${GREEN}[SUCCESS] HLS conversion completed${NC}"
    echo "$TEMP_DIR"
    exit 0
fi

# Get video information using ffprobe
echo -e "${GREEN}[INFO] Analyzing video...${NC}"
VIDEO_INFO=$(ffprobe -v quiet -print_format json -show_format -show_streams "$INPUT_FILE")

# Extract video stream info
WIDTH=$(echo "$VIDEO_INFO" | grep -o '"width":[^,]*' | head -1 | cut -d: -f2 | tr -d ' "')
HEIGHT=$(echo "$VIDEO_INFO" | grep -o '"height":[^,]*' | head -1 | cut -d: -f2 | tr -d ' "')
ROTATION=0

# Check for rotation in side_data_list
if echo "$VIDEO_INFO" | grep -q "Display Matrix"; then
    ROTATION_VAL=$(echo "$VIDEO_INFO" | grep -A 5 "Display Matrix" | grep -o '"rotation":[^,}]*' | cut -d: -f2 | tr -d ' "')
    case "$ROTATION_VAL" in
        -90|90) ROTATION=90 ;;
        180) ROTATION=180 ;;
    esac
fi

# Calculate display dimensions (swap if rotated 90/-90)
DISPLAY_WIDTH=$WIDTH
DISPLAY_HEIGHT=$HEIGHT
if [ "$ROTATION" = "90" ] || [ "$ROTATION" = "-90" ]; then
    DISPLAY_WIDTH=$HEIGHT
    DISPLAY_HEIGHT=$WIDTH
fi

# Extract bitrate
BITRATE=$(echo "$VIDEO_INFO" | grep -o '"bit_rate":"[^"]*"' | head -1 | cut -d'"' -f4)
if [ -z "$BITRATE" ]; then
    BITRATE=$(echo "$VIDEO_INFO" | grep -A 10 '"format"' | grep -o '"bit_rate":"[^"]*"' | head -1 | cut -d'"' -f4)
fi

if [ -n "$BITRATE" ]; then
    BITRATE_KBPS=$((BITRATE / 1000))
else
    BITRATE_KBPS=3000
fi

echo -e "${GREEN}[INFO] Video dimensions: ${WIDTH}x${HEIGHT}${NC}"
echo -e "${GREEN}[INFO] Display dimensions: ${DISPLAY_WIDTH}x${DISPLAY_HEIGHT}${NC}"
if [ "$ROTATION" != "0" ]; then
    echo -e "${GREEN}[INFO] Rotation: ${ROTATION}°${NC}"
fi
echo -e "${GREEN}[INFO] Bitrate: ${BITRATE_KBPS}k${NC}"

# Determine conversion strategy based on file size (>256MB = single quality)
USE_SINGLE_QUALITY=false
if [ "$FILE_SIZE" -gt $((256 * 1024 * 1024)) ]; then
    USE_SINGLE_QUALITY=true
    echo -e "${YELLOW}[INFO] Large file detected, using single-quality 720p conversion${NC}"
else
    echo -e "${GREEN}[INFO] Using multi-quality conversion (720p + 480p)${NC}"
fi

# Calculate aspect-ratio-preserving dimensions
calculate_dimensions() {
    local target_dim=$1
    local orig_width=$2
    local orig_height=$3
    
    local target_width
    local target_height
    
    if [ $orig_height -gt $orig_width ]; then
        # Portrait: maintain height, calculate width
        target_height=$target_dim
        target_width=$(awk "BEGIN {printf \"%.0f\", ($target_height * $orig_width) / $orig_height}")
    else
        # Landscape: maintain width, calculate height
        target_width=$target_dim
        target_height=$(awk "BEGIN {printf \"%.0f\", ($target_width * $orig_height) / $orig_width}")
    fi
    
    ensure_even_dimensions $target_width $target_height
}

ESCAPED_INPUT=$(escape_shell_arg "$INPUT_FILE")

if [ "$USE_SINGLE_QUALITY" = true ]; then
    # Single quality 720p conversion
    echo -e "${GREEN}[INFO] Converting to single quality 720p...${NC}"
    
    DIM720=$(calculate_dimensions 720 $DISPLAY_WIDTH $DISPLAY_HEIGHT)
    WIDTH720=$(echo $DIM720 | cut -d' ' -f1)
    HEIGHT720=$(echo $DIM720 | cut -d' ' -f2)
    
    # Calculate bitrate (cap at 3Mbps)
    MAX_STREAMING_BITRATE=3000
    BITRATE720=$BITRATE_KBPS
    if [ $BITRATE720 -gt $MAX_STREAMING_BITRATE ]; then
        BITRATE720=$MAX_STREAMING_BITRATE
    fi
    
    RESOLUTION=$((DISPLAY_WIDTH * DISPLAY_HEIGHT))
    SEGMENT_DURATION=$(calculate_segment_duration $RESOLUTION $BITRATE720)
    
    echo -e "${GREEN}[INFO] Target dimensions: ${WIDTH720}x${HEIGHT720}, Bitrate: ${BITRATE720}k, Segment duration: ${SEGMENT_DURATION}s${NC}"
    
    PLAYLIST_PATH=$(escape_shell_arg "$TEMP_DIR/playlist.m3u8")
    SEGMENT_PATH=$(escape_shell_arg "$TEMP_DIR/segment%03d.ts")
    
    ffmpeg -i "$INPUT_FILE" -c:v libx264 -c:a aac \
        -vf "scale=${WIDTH720}:${HEIGHT720}:flags=lanczos:force_original_aspect_ratio=decrease:force_divisible_by=2" \
        -b:v ${BITRATE720}k -b:a 128k -preset fast -tune zerolatency -threads 2 \
        -fflags +genpts+igndts+flush_packets -avoid_negative_ts make_zero -max_interleave_delta 0 \
        -f hls -hls_time ${SEGMENT_DURATION} -hls_list_size 0 \
        -hls_segment_filename "$TEMP_DIR/segment%03d.ts" \
        -hls_flags independent_segments+discont_start+split_by_time \
        "$TEMP_DIR/playlist.m3u8" -y
    
    echo -e "${GREEN}[SUCCESS] Single-quality HLS conversion completed${NC}"
else
    # Multi-quality conversion (720p + 480p)
    echo -e "${GREEN}[INFO] Converting to multi-quality (720p + 480p)...${NC}"
    
    mkdir -p "$TEMP_DIR/720p" "$TEMP_DIR/480p"
    
    DIM720=$(calculate_dimensions 720 $DISPLAY_WIDTH $DISPLAY_HEIGHT)
    WIDTH720=$(echo $DIM720 | cut -d' ' -f1)
    HEIGHT720=$(echo $DIM720 | cut -d' ' -f2)
    
    DIM480=$(calculate_dimensions 480 $DISPLAY_WIDTH $DISPLAY_HEIGHT)
    WIDTH480=$(echo $DIM480 | cut -d' ' -f1)
    HEIGHT480=$(echo $DIM480 | cut -d' ' -f2)
    
    # Calculate bitrates (cap at 3Mbps for 720p, 1.5Mbps for 480p)
    MAX_STREAMING_BITRATE720=3000
    MAX_STREAMING_BITRATE480=1500
    
    BITRATE720=$BITRATE_KBPS
    if [ $BITRATE720 -gt $MAX_STREAMING_BITRATE720 ]; then
        BITRATE720=$MAX_STREAMING_BITRATE720
    fi
    
    BITRATE480=$BITRATE_KBPS
    if [ $BITRATE480 -gt $MAX_STREAMING_BITRATE480 ]; then
        BITRATE480=$MAX_STREAMING_BITRATE480
    fi
    
    RESOLUTION=$((DISPLAY_WIDTH * DISPLAY_HEIGHT))
    SEGMENT_DURATION720=$(calculate_segment_duration $RESOLUTION $BITRATE720)
    SEGMENT_DURATION480=$(calculate_segment_duration $RESOLUTION $BITRATE480)
    
    echo -e "${GREEN}[INFO] 720p: ${WIDTH720}x${HEIGHT720}, Bitrate: ${BITRATE720}k, Segment: ${SEGMENT_DURATION720}s${NC}"
    echo -e "${GREEN}[INFO] 480p: ${WIDTH480}x${HEIGHT480}, Bitrate: ${BITRATE480}k, Segment: ${SEGMENT_DURATION480}s${NC}"
    
    # Convert to 720p
    echo -e "${GREEN}[INFO] Converting to 720p...${NC}"
    ffmpeg -i "$INPUT_FILE" -c:v libx264 -c:a aac \
        -vf "scale=${WIDTH720}:${HEIGHT720}:force_original_aspect_ratio=decrease:force_divisible_by=2" \
        -b:v ${BITRATE720}k -b:a 128k -preset fast -tune zerolatency -threads 2 \
        -fflags +genpts+igndts+flush_packets -avoid_negative_ts make_zero -max_interleave_delta 0 \
        -f hls -hls_time ${SEGMENT_DURATION720} -hls_list_size 0 \
        -hls_segment_filename "$TEMP_DIR/720p/segment%03d.ts" \
        -hls_flags independent_segments+discont_start+split_by_time \
        "$TEMP_DIR/720p/playlist.m3u8" -y
    
    # Convert to 480p
    echo -e "${GREEN}[INFO] Converting to 480p...${NC}"
    ffmpeg -i "$INPUT_FILE" -c:v libx264 -c:a aac \
        -vf "scale=${WIDTH480}:${HEIGHT480}:force_original_aspect_ratio=decrease:force_divisible_by=2" \
        -b:v ${BITRATE480}k -b:a 128k -preset fast -tune zerolatency -threads 2 \
        -fflags +genpts+igndts+flush_packets -avoid_negative_ts make_zero -max_interleave_delta 0 \
        -f hls -hls_time ${SEGMENT_DURATION480} -hls_list_size 0 \
        -hls_segment_filename "$TEMP_DIR/480p/segment%03d.ts" \
        -hls_flags independent_segments+discont_start+split_by_time \
        "$TEMP_DIR/480p/playlist.m3u8" -y
    
    # Create master playlist
    BANDWIDTH720=2000000
    BANDWIDTH480=1000000
    
    cat > "$TEMP_DIR/master.m3u8" <<EOF
#EXTM3U
#EXT-X-VERSION:3
#EXT-X-STREAM-INF:BANDWIDTH=${BANDWIDTH720},RESOLUTION=${WIDTH720}x${HEIGHT720}
720p/playlist.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=${BANDWIDTH480},RESOLUTION=${WIDTH480}x${HEIGHT480}
480p/playlist.m3u8
EOF
    
    echo -e "${GREEN}[SUCCESS] Multi-quality HLS conversion completed${NC}"
fi

# Output the directory path
echo -e "${GREEN}[SUCCESS] HLS files created in: $TEMP_DIR${NC}"
echo "$TEMP_DIR"

