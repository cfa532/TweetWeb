<script setup lang="ts">
import { ref, onMounted, computed } from 'vue';
import type { PropType } from 'vue'

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

onMounted(() => {
  // console.log(props)
  vdiv.value.hidden = false;
});

function getVideoSource(): string {
  // For regular videos, use the existing logic
  return props.media.mid + '#t=3';
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
      <!-- For HLS videos, try master.m3u8 first (multiple resolutions), then playlist.m3u8 (single resolution) -->
      <source v-if="isHLS" :src="`${props.media.mid}/master.m3u8`" type="application/x-mpegURL" />
      <source v-if="isHLS" :src="`${props.media.mid}/playlist.m3u8`" type="application/x-mpegURL" />
      <!-- For regular videos -->
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