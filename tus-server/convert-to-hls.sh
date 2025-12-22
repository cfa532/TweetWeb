#!/bin/bash

# Script to convert a video file to HLS format (similar to videoRoutes.js)
# Usage: ./convert-to-hls.sh <video_file> [--no-resample] [--leither-path /path/to/Leither] [--skip-ipfs]

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Parse arguments
INPUT_FILE=""
NO_RESAMPLE=false
LEITHER_PATH=""
SKIP_IPFS=false

while [[ $# -gt 0 ]]; do
    case $1 in
        --no-resample)
            NO_RESAMPLE=true
            shift
            ;;
        --leither-path)
            LEITHER_PATH="$2"
            shift 2
            ;;
        --skip-ipfs)
            SKIP_IPFS=true
            shift
            ;;
        -*)
            echo -e "${RED}Error: Unknown option: $1${NC}"
            echo "Usage: $0 <video_file> [--no-resample] [--leither-path /path/to/Leither] [--skip-ipfs]"
            exit 1
            ;;
        *)
            if [ -z "$INPUT_FILE" ]; then
                INPUT_FILE="$1"
            else
                echo -e "${RED}Error: Multiple input files specified${NC}"
                echo "Usage: $0 <video_file> [--no-resample] [--leither-path /path/to/Leither] [--skip-ipfs]"
                exit 1
            fi
            shift
            ;;
    esac
done

# Check if video file is provided
if [ -z "$INPUT_FILE" ]; then
    echo -e "${RED}Error: No video file specified${NC}"
    echo "Usage: $0 <video_file> [--no-resample] [--leither-path /path/to/Leither] [--skip-ipfs]"
    echo ""
    echo "Options:"
    echo "  --no-resample       Use codec copy (no re-encoding)"
    echo "  --leither-path PATH Path to Leither binary (or set LEITHER_PATH env var)"
    echo "  --skip-ipfs         Skip IPFS add operation"
    exit 1
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

# Function to find Leither binary
find_leither() {
    local leither_path="$1"
    
    # If path provided, check it first
    if [ -n "$leither_path" ]; then
        if [ -f "$leither_path" ] && [ -x "$leither_path" ]; then
            echo "$leither_path"
            return 0
        else
            echo -e "${YELLOW}[WARNING] Leither path specified but not found or not executable: $leither_path${NC}" >&2
        fi
    fi
    
    # Check environment variable (if not already set via argument)
    if [ -z "$leither_path" ] && [ -n "${LEITHER_PATH}" ]; then
        if [ -f "${LEITHER_PATH}" ] && [ -x "${LEITHER_PATH}" ]; then
            echo "${LEITHER_PATH}"
            return 0
        fi
    fi
    
    # Try to find in common locations
    local common_paths=(
        "$HOME/Leither"
        "$HOME/leither/Leither"
        "/usr/local/bin/Leither"
        "/usr/bin/Leither"
        "./Leither"
    )
    
    for path in "${common_paths[@]}"; do
        if [ -f "$path" ] && [ -x "$path" ]; then
            echo "$path"
            return 0
        fi
    done
    
    # Try command lookup
    if command -v Leither &> /dev/null; then
        command -v Leither
        return 0
    fi
    
    return 1
}

# Find Leither binary if not skipping IPFS
if [ "$SKIP_IPFS" = false ]; then
    # Use argument path if provided, otherwise check environment variable
    LEITHER_BIN=$(find_leither "$LEITHER_PATH" 2>/dev/null || echo "")
    if [ -z "$LEITHER_BIN" ]; then
        echo -e "${YELLOW}[WARNING] Leither binary not found. IPFS add will be skipped.${NC}"
        echo -e "${YELLOW}[INFO] You can specify the path with --leither-path or set LEITHER_PATH environment variable${NC}"
        SKIP_IPFS=true
    else
        echo -e "${GREEN}[INFO] Found Leither binary: $LEITHER_BIN${NC}"
    fi
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
        -hls_flags discont_start+split_by_time \
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

# Normalization logic: all videos are normalized to a single quality
# - Resolution >720p: normalize to 720p @ 1500k
# - Resolution =720p: normalize to 720p @ 1000k  
# - Resolution <720p: keep original resolution with proportional bitrate (no upscaling)

echo -e "${GREEN}[INFO] Normalizing video to optimized HLS format...${NC}"

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

# Determine target resolution and bitrate based on original resolution
# 720p reference: 1280x720 = 921,600 pixels
REFERENCE_720P_PIXELS=921600
REFERENCE_720P_BITRATE=1000

# Calculate original resolution in pixels
ORIG_RESOLUTION=$((DISPLAY_WIDTH * DISPLAY_HEIGHT))

# Determine if portrait or landscape, and get the reference dimension
if [ $DISPLAY_HEIGHT -gt $DISPLAY_WIDTH ]; then
    # Portrait video
    IS_PORTRAIT=true
    REFERENCE_DIM=$DISPLAY_WIDTH
else
    # Landscape video
    IS_PORTRAIT=false
    REFERENCE_DIM=$DISPLAY_HEIGHT
fi

# Determine normalization strategy
if [ $REFERENCE_DIM -gt 720 ]; then
    # Resolution >720p: normalize to 720p @ 1500k
    echo -e "${YELLOW}[INFO] Video resolution >720p, normalizing to 720p @ 1500k${NC}"
    TARGET_DIM=720
    TARGET_BITRATE=1500
elif [ $REFERENCE_DIM -eq 720 ]; then
    # Resolution =720p: normalize to 720p @ 1000k
    echo -e "${YELLOW}[INFO] Video resolution =720p, normalizing @ 1000k${NC}"
    TARGET_DIM=720
    TARGET_BITRATE=1000
else
    # Resolution <720p: keep original resolution with proportional bitrate
    echo -e "${YELLOW}[INFO] Video resolution <720p, keeping original resolution with proportional bitrate${NC}"
    TARGET_DIM=$REFERENCE_DIM
    
    # Calculate proportional bitrate based on pixel count ratio to 720p
    # bitrate = (original_pixels / 720p_pixels) * 1000k
    TARGET_BITRATE=$(awk "BEGIN {printf \"%.0f\", ($ORIG_RESOLUTION / $REFERENCE_720P_PIXELS) * $REFERENCE_720P_BITRATE}")
    
    # Ensure minimum bitrate of 500k
    if [ $TARGET_BITRATE -lt 500 ]; then
        TARGET_BITRATE=500
    fi
fi

# Calculate target dimensions
DIMS=$(calculate_dimensions $TARGET_DIM $DISPLAY_WIDTH $DISPLAY_HEIGHT)
TARGET_WIDTH=$(echo $DIMS | cut -d' ' -f1)
TARGET_HEIGHT=$(echo $DIMS | cut -d' ' -f2)

# Calculate segment duration
TARGET_RESOLUTION=$((TARGET_WIDTH * TARGET_HEIGHT))
SEGMENT_DURATION=$(calculate_segment_duration $TARGET_RESOLUTION $TARGET_BITRATE)

echo -e "${GREEN}[INFO] Original: ${DISPLAY_WIDTH}x${DISPLAY_HEIGHT} (${ORIG_RESOLUTION} pixels)${NC}"
echo -e "${GREEN}[INFO] Target: ${TARGET_WIDTH}x${TARGET_HEIGHT}, Bitrate: ${TARGET_BITRATE}k, Segment: ${SEGMENT_DURATION}s${NC}"

PLAYLIST_PATH=$(escape_shell_arg "$TEMP_DIR/playlist.m3u8")
SEGMENT_PATH=$(escape_shell_arg "$TEMP_DIR/segment%03d.ts")

# Dual-variant HLS conversion (but script only does single for simplicity)
ffmpeg -i "$INPUT_FILE" -c:v libx264 -c:a aac \
    -vf "scale=${TARGET_WIDTH}:${TARGET_HEIGHT}:flags=lanczos:force_original_aspect_ratio=decrease:force_divisible_by=2" \
    -b:v ${TARGET_BITRATE}k -b:a 128k -preset fast -tune zerolatency -threads 2 \
    -fflags +genpts+igndts+flush_packets -avoid_negative_ts make_zero -max_interleave_delta 0 \
    -f hls -hls_time ${SEGMENT_DURATION} -hls_list_size 0 \
    -hls_segment_filename "$TEMP_DIR/segment%03d.ts" \
    -hls_flags discont_start+split_by_time \
    "$TEMP_DIR/playlist.m3u8" -y

echo -e "${GREEN}[SUCCESS] Normalized HLS conversion completed${NC}"

# Output the directory path
echo -e "${GREEN}[SUCCESS] HLS files created in: $TEMP_DIR${NC}"
echo "$TEMP_DIR"

# Add to IPFS using Leither
if [ "$SKIP_IPFS" = false ] && [ -n "$LEITHER_BIN" ]; then
    echo ""
    echo -e "${BLUE}========================================${NC}"
    echo -e "${BLUE}[IPFS] Adding HLS directory to IPFS...${NC}"
    echo -e "${BLUE}========================================${NC}"
    
    # Run Leither ipfs add command and capture output
    if "$LEITHER_BIN" ipfs add "$TEMP_DIR" 2>&1; then
        echo ""
        echo -e "${GREEN}[IPFS] Successfully added to IPFS${NC}"
    else
        EXIT_CODE=$?
        echo ""
        echo -e "${RED}[IPFS] Failed to add to IPFS (exit code: $EXIT_CODE)${NC}"
        echo -e "${YELLOW}[INFO] HLS files are still available in: $TEMP_DIR${NC}"
        # Don't exit on error - conversion was successful
    fi
    echo -e "${BLUE}========================================${NC}"
    echo ""
fi

