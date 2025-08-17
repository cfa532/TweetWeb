<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from 'vue';
import type { PropType } from 'vue'
import Hls from 'hls.js';
import { useRouter } from 'vue-router';

const props = defineProps({
  media: { type: Object as PropType<MimeiFileType>, required: true },
  autoplay: { type: Boolean, required: false },
})
const router = useRouter();
const vdiv = ref();
const video = ref();
const isPlaying = ref(false);
const isPortrait = ref(false);
const autoplayBlocked = ref(false);
const isHLS = computed(() => {
  const mediaType = props.media.type?.toLowerCase();
  return mediaType === 'hls_video' || mediaType === 'video';
});
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
let hasTriedSinglePlaylist = false;

onMounted(() => {
  vdiv.value.hidden = false;
  
  // Wait for next tick to ensure video element is created
  setTimeout(() => {
    if (video.value && isHLS.value) {
      setupHLS();
    }
  }, 100);
  
  // Add page visibility change listener
  document.addEventListener('visibilitychange', handleVisibilityChange);
  
  // Add route change listener
  router.beforeEach((to, from, next) => {
    stopVideo();
    next();
  });
});

onUnmounted(() => {
  // Clean up event listeners
  document.removeEventListener('visibilitychange', handleVisibilityChange);
  
  // Stop video and clean up HLS
  stopVideo();
});

function setupHLS() {
  if (!video.value) return;
  
  const videoElement = video.value;
  
      // Enable hardware acceleration if supported
    if (supportsHardwareAcceleration.value) {
      videoElement.style.transform = 'translateZ(0)'; // Force hardware acceleration
      videoElement.style.willChange = 'transform'; // Optimize for animations
    }
  
  // Check if HLS is supported natively
  if (videoElement.canPlayType('application/vnd.apple.mpegurl')) {
    // Use native HLS support - try master playlist first, then fallback to single playlist
    videoElement.src = getHLSMasterSource();
    
    // Add fallback for native HLS
    videoElement.addEventListener('error', () => {
      videoElement.src = getHLSSource();
      
      // Add another error listener for single playlist failure
      videoElement.addEventListener('error', () => {
        fallbackToProgressiveVideo(videoElement);
      }, { once: true });
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
    hasTriedSinglePlaylist = false;
    hls.loadSource(getHLSMasterSource());
    hls.attachMedia(videoElement);
    
    // Add timeout fallback in case HLS hangs
    const hlsTimeout = setTimeout(() => {
      if (hls && !videoElement.src) {
        fallbackToProgressiveVideo(videoElement);
      }
    }, 10000); // 10 second timeout
    
    // Clear timeout when manifest is parsed
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      clearTimeout(hlsTimeout);
      
      // Handle autoplay with proper error handling
      if (props.autoplay) {
        handleAutoplay(videoElement);
      }
    });
    
    // Monitor quality level changes
    // hls.on(Hls.Events.LEVEL_SWITCHED, (event, data) => {
    //   console.log('Quality level switched to:', data.level, 'bitrate:', hls?.levels[data.level]?.bitrate);
    // });
    
    // Monitor buffer events for hardware acceleration
    // hls.on(Hls.Events.BUFFER_APPENDING, () => {
    //   if (supportsHardwareAcceleration.value) {
    //     console.log('[HARDWARE] Buffer appending with hardware acceleration');
    //   }
    // });
    
    hls.on(Hls.Events.ERROR, (event, data) => {
      // If master playlist fails, try single playlist
      if (!hasTriedSinglePlaylist && data.fatal && data.type === Hls.ErrorTypes.NETWORK_ERROR && 
          data.details === Hls.ErrorDetails.MANIFEST_LOAD_ERROR) {
        hasTriedSinglePlaylist = true;
        hls?.destroy();
        hls = new Hls(hlsConfig); // Use same config for fallback
        hls.loadSource(getHLSSource());
        hls.attachMedia(videoElement);
        
        // Add error handler for single playlist
        hls.on(Hls.Events.ERROR, (event, data) => {
          fallbackToProgressiveVideo(videoElement);
        });
        return;
      }
      
      // If we've already tried single playlist or this is a different error, go to progressive
      if (hasTriedSinglePlaylist || data.fatal) {
        fallbackToProgressiveVideo(videoElement);
        return;
      }
      
      // For non-fatal errors, try to recover
      if (!data.fatal) {
        switch (data.type) {
          case Hls.ErrorTypes.NETWORK_ERROR:
            hls?.startLoad();
            break;
          case Hls.ErrorTypes.MEDIA_ERROR:
            hls?.recoverMediaError();
            break;
        }
      }
    });
  }
}

// Handle autoplay with proper error handling and user interaction detection
async function handleAutoplay(videoElement: HTMLVideoElement) {
  try {
    // Check if autoplay is allowed
    const canAutoplay = await checkAutoplaySupport(videoElement);
    
    if (canAutoplay) {
      await videoElement.play();
      isPlaying.value = true;
    } else {
      // Show play button or other UI indication that user needs to interact
      showAutoplayBlockedUI();
    }
  } catch (error) {
    // Show play button or other UI indication
    showAutoplayBlockedUI();
  }
}

// Check if autoplay is supported by the browser
async function checkAutoplaySupport(videoElement: HTMLVideoElement): Promise<boolean> {
  try {
    // Try to play a silent video to test autoplay support
    videoElement.muted = true;
    videoElement.volume = 0;
    
    // Create a promise that resolves when play() succeeds or rejects
    const playPromise = videoElement.play();
    
    if (playPromise !== undefined) {
      await playPromise;
      // If we get here, autoplay worked
      videoElement.pause();
      return true;
    }
    return false;
  } catch (error) {
    return false;
  }
}

// Show UI indication that autoplay is blocked
function showAutoplayBlockedUI() {
  autoplayBlocked.value = true;
}

// Handle manual play when autoplay is blocked
async function handleManualPlay() {
  try {
    if (video.value) {
      await video.value.play();
      isPlaying.value = true;
      autoplayBlocked.value = false;
    }
  } catch (error) {
    // Silent error handling
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

// Fallback to progressive video when HLS streaming fails
function fallbackToProgressiveVideo(videoElement: HTMLVideoElement) {
  // Destroy HLS instance
  if (hls) {
    hls.destroy();
    hls = null;
  }
  
  // Remove any existing sources
  while (videoElement.firstChild) {
    videoElement.removeChild(videoElement.firstChild);
  }
  
  // Set the video source to the original URL without extension
  // This will attempt to play the video as a progressive download
  const progressiveUrl = props.media.mid;
  videoElement.src = progressiveUrl;
  
  // Add error handling for progressive video
  videoElement.addEventListener('error', (e) => {
    // Silent error handling
  }, { once: true });
  
  // Add load event to confirm progressive video loaded
  videoElement.addEventListener('loadeddata', () => {
    // Video loaded successfully
  }, { once: true });
  
  // Add canplay event
  videoElement.addEventListener('canplay', () => {
    // Video can start playing
  }, { once: true });
  
  // Try to play the video
  if (props.autoplay) {
    videoElement.play().catch(error => {
      // Silent error handling
    });
  }
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

// Handle page visibility change
function handleVisibilityChange() {
  if (document.hidden) {
    stopVideo();
  }
}

// Stop video playback and clean up resources
function stopVideo() {
  if (video.value) {
    // Pause the video
    if (!video.value.paused) {
      video.value.pause();
      isPlaying.value = false;
    }
    
    // Reset video to beginning
    video.value.currentTime = 0;
  }
  
  // Clean up HLS instance
  if (hls) {
    hls.destroy();
    hls = null;
  }
  
  // Reset flags
  hasTriedSinglePlaylist = false;
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
    
    <!-- Autoplay blocked overlay -->
    <div v-if="autoplayBlocked && props.autoplay" class="autoplay-blocked-overlay" @click="handleManualPlay">
      <div class="autoplay-blocked-content">
        <div class="play-button">
          <font-awesome-icon icon="play" />
        </div>
        <p class="autoplay-message">Click to play video</p>
      </div>
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

/* Autoplay blocked overlay styles */
.autoplay-blocked-overlay {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  background: rgba(0, 0, 0, 0.7);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 20;
  cursor: pointer;
  transition: background-color 0.3s ease;
}

.autoplay-blocked-overlay:hover {
  background: rgba(0, 0, 0, 0.8);
}

.autoplay-blocked-content {
  text-align: center;
  color: white;
}

.play-button {
  font-size: 48px;
  margin-bottom: 10px;
  opacity: 0.9;
  transition: opacity 0.3s ease;
}

.autoplay-blocked-overlay:hover .play-button {
  opacity: 1;
}

.autoplay-message {
  font-size: 14px;
  margin: 0;
  opacity: 0.8;
  font-weight: 500;
}
</style>