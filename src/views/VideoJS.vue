<script setup lang="ts">
import { ref, onMounted, computed } from 'vue';
import type { PropType } from 'vue'
import Hls from 'hls.js';

const props = defineProps({
  media: { type: Object as PropType<MimeiFileType>, required: true },
  autoplay: { type: Boolean, required: false },
})
const vdiv = ref();
const video = ref();
const isPlaying = ref(false);
const isPortrait = ref(false);
const isHLS = computed(() => props.media.type === 'hls_video' || props.media.type === 'Video');
const controls = computed(()=>{
  return props.media.downloadable==false ? "nodownload" : undefined
})

// Detect if this video is being displayed in a tweet list context
const isInTweetList = computed(() => {
  // Check if we're in a tweet list by looking for tweet list specific elements
  const tweetContainer = vdiv.value?.closest('.tweet-container');
  const isInList = tweetContainer && !tweetContainer.closest('.card-body')?.closest('.comment');
  return isInList;
});

// Hardware acceleration detection
const supportsHardwareAcceleration = computed(() => {
  if (!video.value) return false;
  
  // Check for hardware acceleration support
  const canvas = document.createElement('canvas');
  const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
  
  if (!gl) return false;
  
  // Check for hardware video decoding support
  const videoElement = video.value;
  
  // Test hardware acceleration by checking if the browser supports it
  const testVideo = document.createElement('video');
  testVideo.style.display = 'none';
  document.body.appendChild(testVideo);
  
  // Check for hardware acceleration hints
  const hasHardwareSupport = (
    'mediaCapabilities' in navigator ||
    'getVideoPlaybackQuality' in videoElement ||
    'webkitVideoPlaybackQuality' in videoElement
  );
  
  document.body.removeChild(testVideo);
  
  return hasHardwareSupport;
});

let hls: Hls | null = null;

onMounted(() => {
  vdiv.value.hidden = false;
  
  // Wait for next tick to ensure video element is created
  setTimeout(() => {
    if (video.value && isHLS.value) {
      setupHLS();
    }
  }, 100);
});

function setupHLS() {
  if (!video.value) return;
  
  const videoElement = video.value;
  
  // Enable hardware acceleration if supported
  if (supportsHardwareAcceleration.value) {
    videoElement.style.transform = 'translateZ(0)'; // Force hardware acceleration
    videoElement.style.willChange = 'transform'; // Optimize for animations
    console.log('[HARDWARE] Hardware acceleration enabled for video playback');
  }
  
  // Check if HLS is supported natively
  if (videoElement.canPlayType('application/vnd.apple.mpegurl')) {
    // Use native HLS support - try master playlist first, then fallback to single playlist
    videoElement.src = getHLSMasterSource();
    
    // Add fallback for native HLS
    videoElement.addEventListener('error', () => {
      console.log('Master playlist failed, trying single playlist...');
      videoElement.src = getHLSSource();
    });
  } else if (Hls.isSupported()) {
    // Configure HLS.js based on context (list vs detail) with hardware acceleration
    const hlsConfig = isInTweetList.value ? {
      // Low quality settings for tweet list with hardware acceleration
      enableWorker: true,
      lowLatencyMode: false, // Disable low latency for list view
      // Conservative bandwidth settings for list view
      abrEwmaDefaultEstimate: 250000, // 250kbps default bandwidth estimate (lower)
      abrBandWidthFactor: 0.8, // More conservative bandwidth factor
      abrBandWidthUpFactor: 0.5, // Very conservative for bandwidth increases
      abrMaxWithRealBitrate: true,
      // Force lower quality for list view
      startLevel: 1, // Start with second quality level (usually 480p)
      capLevelToPlayerSize: true,
      // Smaller buffer for list view
      maxBufferLength: 15, // Reduced buffer length
      maxMaxBufferLength: 300, // Reduced max buffer
      maxBufferSize: 30 * 1000 * 1000, // 30MB max buffer size (smaller)
      maxBufferHole: 0.5,
      // Hardware acceleration settings
      enableSoftwareAES: false, // Use hardware AES if available
      enableStashBuffer: true, // Enable stash buffer for smoother playback
      stashInitialSize: 384 * 1024, // Initial stash buffer size
    } : {
      // High quality settings for detail view with hardware acceleration
      enableWorker: true,
      lowLatencyMode: true,
      // Auto quality selection settings
      abrEwmaDefaultEstimate: 500000, // 500kbps default bandwidth estimate
      abrBandWidthFactor: 0.95, // Conservative bandwidth factor
      abrBandWidthUpFactor: 0.7, // More conservative for bandwidth increases
      abrMaxWithRealBitrate: true, // Use real bitrate for ABR decisions
      // Quality selection preferences
      startLevel: -1, // Auto-select starting quality level
      capLevelToPlayerSize: true, // Cap quality to player size
      // Buffer settings for smooth playback
      maxBufferLength: 30, // Max buffer length in seconds
      maxMaxBufferLength: 600, // Absolute max buffer length
      maxBufferSize: 60 * 1000 * 1000, // 60MB max buffer size
      maxBufferHole: 0.5, // Max buffer hole in seconds
      // Hardware acceleration settings
      enableSoftwareAES: false, // Use hardware AES if available
      enableStashBuffer: true, // Enable stash buffer for smoother playback
      stashInitialSize: 384 * 1024, // Initial stash buffer size
      // Advanced hardware acceleration
      enableWebAssembly: true, // Enable WebAssembly for better performance
      backBufferLength: 90, // Back buffer length for smooth seeking
    };
    
    hls = new Hls(hlsConfig);
    
    // Try master playlist first
    hls.loadSource(getHLSMasterSource());
    hls.attachMedia(videoElement);
    
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      console.log('HLS manifest parsed successfully');
      console.log('Available quality levels:', hls?.levels.length);
      console.log('Auto-selected starting level:', hls?.currentLevel);
      console.log('Context:', isInTweetList.value ? 'Tweet List (Low Quality)' : 'Detail View (High Quality)');
      console.log('Hardware acceleration:', supportsHardwareAcceleration.value ? 'Enabled' : 'Disabled');
      if (props.autoplay) {
        videoElement.play();
      }
    });
    
    // Monitor quality level changes
    hls.on(Hls.Events.LEVEL_SWITCHED, (event, data) => {
      console.log('Quality level switched to:', data.level, 'bitrate:', hls?.levels[data.level]?.bitrate);
    });
    
    // Monitor buffer events for hardware acceleration
    hls.on(Hls.Events.BUFFER_APPENDING, () => {
      if (supportsHardwareAcceleration.value) {
        console.log('[HARDWARE] Buffer appending with hardware acceleration');
      }
    });
    
    hls.on(Hls.Events.ERROR, (event, data) => {
      console.error('HLS error:', data);
      
      // If master playlist fails, try single playlist
      if (data.fatal && data.type === Hls.ErrorTypes.NETWORK_ERROR && 
          data.details === Hls.ErrorDetails.MANIFEST_LOAD_ERROR) {
        console.log('Master playlist failed, trying single playlist...');
        hls?.destroy();
        hls = new Hls(hlsConfig); // Use same config for fallback
        hls.loadSource(getHLSSource());
        hls.attachMedia(videoElement);
        return;
      }
      
      if (data.fatal) {
        switch (data.type) {
          case Hls.ErrorTypes.NETWORK_ERROR:
            console.log('Network error, trying to recover...');
            hls?.startLoad();
            break;
          case Hls.ErrorTypes.MEDIA_ERROR:
            console.log('Media error, trying to recover...');
            hls?.recoverMediaError();
            break;
          default:
            console.log('Fatal error, destroying HLS instance');
            hls?.destroy();
            break;
        }
      }
    });
  }
}

function getVideoSource(): string {
  // For regular videos, use the existing logic
  return props.media.mid + '#t=3';
}

function getHLSSource(): string {
  // For HLS videos, props.media.mid already contains the full IPFS URL
  // We need to append the playlist filename
  return props.media.mid + '/playlist.m3u8';
}

function getHLSMasterSource(): string {
  // For HLS videos with multiple resolutions, try master playlist first
  return props.media.mid + '/master.m3u8';
}

function togglePlay() {
  if (video.value.paused) {
    video.value.play();
    isPlaying.value = true;
  } else {
    video.value.pause();
    isPlaying.value = false;
  }
}

function checkVideoOrientation() {
  const videoElement = video.value;
  if (videoElement && (videoElement.videoWidth < videoElement.videoHeight)) {
    isPortrait.value = true;
  } else {
    isPortrait.value = false;
  }
}

function disableRightClick(event: MouseEvent) {
  if (props.media.downloadable == false)
    event.preventDefault();
}
</script>

<template>
  <div ref="vdiv" hidden class="video-container">
    <div v-if="isPortrait" class="custom-controls">
      <button @click.stop="togglePlay">
        <font-awesome-icon :icon='isPlaying ? "pause" : "play"' />
      </button>
      <!-- Add more custom control buttons as needed -->
    </div>
    <video
      ref="video"
      class="video"
      :class="{'video-portrait': isPortrait, 'hardware-accelerated': supportsHardwareAcceleration}"
      :autoplay=props.autoplay
      controls
      :controlslist=controls
      preload="auto"
      playsinline
      webkit-playsinline
      x5-playsinline
      x5-video-player-type="h5"
      x5-video-player-fullscreen="true"
      @loadedmetadata="checkVideoOrientation"
      @contextmenu="disableRightClick"
    >
      <!-- For regular videos only - HLS videos are handled by HLS.js -->
      <source v-if="!isHLS" :src="getVideoSource()" type="video/mp4" />
      <source v-if="!isHLS" :src="getVideoSource()" type="video/mp4" />
      Your browser does not support the video tag.
    </video>
    <p style="margin-top: 5px; font-size: small; color: darkslategray; left: 1%; position: relative;">
      {{ media.fileName }}
    </p>
  </div>
</template>

<style>
.video-container {
  position: relative;
  max-width: 100%;
}

.video {
  width: 100%;
  display: block;
}

/* Hardware acceleration styles */
.hardware-accelerated {
  transform: translateZ(0);
  backface-visibility: hidden;
  perspective: 1000px;
  will-change: transform;
}

/* Add this style */
.video-portrait {
  max-height: 80vh; /* Adjust this value as needed */
  object-fit: contain; /*  Prevent the video from being cropped */
}

.custom-controls {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  display: flex;
  justify-content: flex-start;
  background: rgba(0, 0, 0, 0.2);
  color: white;
  padding: 5px;
  z-index: 10;
}

.custom-controls button {
  background: none;
  border: none;
  color: white;
  font-size: 16px;
  cursor: pointer;
  margin-right: 10px;
}

.custom-controls button:hover {
  text-decoration: underline;
}
</style>