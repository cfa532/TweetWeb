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
    elif [ $bitrate -lt $MIN_BITRATE ]; then
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
    
    ffmpeg -i "$INPUT_FILE" -c:v copy -c:a aac -b:a 128k \
        -f hls -hls_time 10 -hls_list_size 0 -hls_playlist_type vod -start_number 0 \
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

# Read the video stream bitrate explicitly. The previous JSON grep could pick
# the audio stream first, and its 3000k fallback could inflate low-bitrate video.
VIDEO_BITRATE=$(ffprobe -v error -select_streams v:0 -show_entries stream=bit_rate -of default=noprint_wrappers=1:nokey=1 "$INPUT_FILE" | head -1)
FORMAT_BITRATE=$(ffprobe -v error -show_entries format=bit_rate -of default=noprint_wrappers=1:nokey=1 "$INPUT_FILE" | head -1)
AUDIO_BITRATE=$(ffprobe -v error -select_streams a -show_entries stream=bit_rate -of default=noprint_wrappers=1:nokey=1 "$INPUT_FILE" | awk '/^[0-9]+$/ { total += $1 } END { print total + 0 }')
DURATION=$(ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "$INPUT_FILE" | head -1)

SOURCE_BITRATE_BPS=""
if [[ "$VIDEO_BITRATE" =~ ^[0-9]+$ ]] && [ "$VIDEO_BITRATE" -gt 0 ]; then
    SOURCE_BITRATE_BPS=$VIDEO_BITRATE
else
    if [[ "$FORMAT_BITRATE" =~ ^[0-9]+$ ]] && [ "$FORMAT_BITRATE" -gt "$AUDIO_BITRATE" ]; then
        SOURCE_BITRATE_BPS=$((FORMAT_BITRATE - AUDIO_BITRATE))
    fi

    if [[ "$DURATION" =~ ^[0-9]+([.][0-9]+)?$ ]] && awk "BEGIN {exit !($DURATION > 0)}"; then
        FILE_AVERAGE_BITRATE=$(awk "BEGIN {printf \"%.0f\", ($FILE_SIZE * 8) / $DURATION}")
        if [ "$FILE_AVERAGE_BITRATE" -gt "$AUDIO_BITRATE" ]; then
            FILE_VIDEO_BITRATE=$((FILE_AVERAGE_BITRATE - AUDIO_BITRATE))
            if [ -z "$SOURCE_BITRATE_BPS" ] || [ "$FILE_VIDEO_BITRATE" -lt "$SOURCE_BITRATE_BPS" ]; then
                SOURCE_BITRATE_BPS=$FILE_VIDEO_BITRATE
            fi
        fi
    fi
fi

if [ -n "$SOURCE_BITRATE_BPS" ] && [ "$SOURCE_BITRATE_BPS" -gt 0 ]; then
    BITRATE_KBPS=$((SOURCE_BITRATE_BPS / 1000))
else
    BITRATE_KBPS=""
fi

echo -e "${GREEN}[INFO] Video dimensions: ${WIDTH}x${HEIGHT}${NC}"
echo -e "${GREEN}[INFO] Display dimensions: ${DISPLAY_WIDTH}x${DISPLAY_HEIGHT}${NC}"
if [ "$ROTATION" != "0" ]; then
    echo -e "${GREEN}[INFO] Rotation: ${ROTATION}°${NC}"
fi
if [ -n "$BITRATE_KBPS" ]; then
    echo -e "${GREEN}[INFO] Source video bitrate: ${BITRATE_KBPS}k${NC}"
else
    echo -e "${YELLOW}[WARNING] Source video bitrate is unavailable; using the resolution-based target${NC}"
fi

# Normalization logic: all videos are normalized to a single quality
# - Resolution >720p: normalize to 720p using shared bitrate curve
# - Resolution =720p: normalize to 720p using shared bitrate curve
# - Resolution <720p: keep original resolution using shared bitrate curve (no upscaling)

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
# Preserve-quality bitrate policy shared with videoRoutes.js
REFERENCE_720P_BITRATE=2500
REFERENCE_720P_PIXELS=921600
MIN_BITRATE=600
HLS_SEGMENT_DURATION=10

calculate_video_bitrate() {
    local reference_resolution=$1
    local reference_width=$(awk "BEGIN {printf \"%.0f\", ($reference_resolution * 16) / 9}")
    local pixel_count=$((reference_width * reference_resolution))
    local calculated=$(awk "BEGIN {printf \"%.0f\", ($pixel_count / $REFERENCE_720P_PIXELS) * $REFERENCE_720P_BITRATE}")
    if [ $calculated -lt $MIN_BITRATE ]; then
        calculated=$MIN_BITRATE
    fi
    echo $calculated
}

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

# Get source bitrate in kbps (already extracted as BITRATE_KBPS)
SOURCE_BITRATE_K=$BITRATE_KBPS
# Calculate target bitrate based on resolution
if [ $REFERENCE_DIM -gt 720 ]; then
    echo -e "${YELLOW}[INFO] Video resolution >720p, normalizing to 720p using shared bitrate${NC}"
    TARGET_DIM=720
    CALCULATED_BITRATE=$(calculate_video_bitrate 720)
elif [ $REFERENCE_DIM -eq 720 ]; then
    echo -e "${YELLOW}[INFO] Video resolution =720p, normalizing using shared bitrate${NC}"
    TARGET_DIM=720
    CALCULATED_BITRATE=$(calculate_video_bitrate 720)
else
    echo -e "${YELLOW}[INFO] Video resolution <720p, keeping original resolution with shared bitrate${NC}"
    TARGET_DIM=$REFERENCE_DIM
    CALCULATED_BITRATE=$(calculate_video_bitrate $REFERENCE_DIM)
fi

# Determine final target bitrate: never raise bitrate above a readable source bitrate.
if [ -n "$SOURCE_BITRATE_K" ] && [ "$SOURCE_BITRATE_K" -gt 0 ] && [ "$SOURCE_BITRATE_K" -lt "$CALCULATED_BITRATE" ]; then
    echo -e "${GREEN}[BITRATE] Keeping lower source bitrate ${SOURCE_BITRATE_K}k instead of calculated target ${CALCULATED_BITRATE}k${NC}"
    TARGET_BITRATE=$SOURCE_BITRATE_K
else
    TARGET_BITRATE=$CALCULATED_BITRATE
fi

# Calculate target dimensions
DIMS=$(calculate_dimensions $TARGET_DIM $DISPLAY_WIDTH $DISPLAY_HEIGHT)
TARGET_WIDTH=$(echo $DIMS | cut -d' ' -f1)
TARGET_HEIGHT=$(echo $DIMS | cut -d' ' -f2)

# Match iOS HLS output cadence.
SEGMENT_DURATION=$HLS_SEGMENT_DURATION

echo -e "${GREEN}[INFO] Original: ${DISPLAY_WIDTH}x${DISPLAY_HEIGHT} (${ORIG_RESOLUTION} pixels)${NC}"
echo -e "${GREEN}[INFO] Target: ${TARGET_WIDTH}x${TARGET_HEIGHT}, Bitrate: ${TARGET_BITRATE}k, Segment: ${SEGMENT_DURATION}s${NC}"

PLAYLIST_PATH=$(escape_shell_arg "$TEMP_DIR/playlist.m3u8")
SEGMENT_PATH=$(escape_shell_arg "$TEMP_DIR/segment%03d.ts")

# Dual-variant HLS conversion (but script only does single for simplicity)
ffmpeg -i "$INPUT_FILE" -c:v libx264 -c:a aac \
    -profile:v main -level 4.0 -pix_fmt yuv420p \
    -vf "scale=${TARGET_WIDTH}:${TARGET_HEIGHT}:force_original_aspect_ratio=decrease:force_divisible_by=2" \
    -g 48 -b:v ${TARGET_BITRATE}k \
    -b:a 128k -preset fast -threads 2 \
    -f hls -hls_time ${SEGMENT_DURATION} -hls_list_size 0 -hls_playlist_type vod -start_number 0 \
    -hls_segment_filename "$TEMP_DIR/segment%03d.ts" \
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
