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
  
  // Check if HLS is supported natively
  if (videoElement.canPlayType('application/vnd.apple.mpegurl')) {
    // Use native HLS support
    videoElement.src = getHLSSource();
  } else if (Hls.isSupported()) {
    // Use HLS.js
    hls = new Hls({
      enableWorker: true,
      lowLatencyMode: true,
    });
    
    hls.loadSource(getHLSSource());
    hls.attachMedia(videoElement);
    
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      if (props.autoplay) {
        videoElement.play();
      }
    });
    
    hls.on(Hls.Events.ERROR, (event, data) => {
      if (data.fatal) {
        switch (data.type) {
          case Hls.ErrorTypes.NETWORK_ERROR:
            hls?.startLoad();
            break;
          case Hls.ErrorTypes.MEDIA_ERROR:
            hls?.recoverMediaError();
            break;
          default:
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
      :class="{'video-portrait': isPortrait}"
      :autoplay=props.autoplay
      controls
      :controlslist=controls
      preload="auto"
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