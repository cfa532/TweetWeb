<script setup lang="ts">
import { ref, onUnmounted } from 'vue';
import type { PropType } from 'vue';

const props = defineProps({
    media: { type: Object as PropType<MimeiFileType>, required: true },
});

const audioEl = ref<HTMLAudioElement | null>(null);
const isPlaying = ref(false);
const isLoading = ref(true);
const hasError = ref(false);
const currentTime = ref(0);
const duration = ref(0);

function formatTime(s: number): string {
    if (!isFinite(s) || isNaN(s)) return '0:00';
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, '0')}`;
}

function togglePlay() {
    if (!audioEl.value || hasError.value) return;
    isPlaying.value ? audioEl.value.pause() : audioEl.value.play();
}

function onCanPlay() {
    isLoading.value = false;
}

function onLoadedMetadata() {
    if (audioEl.value) duration.value = audioEl.value.duration;
}

function onTimeUpdate() {
    if (audioEl.value) currentTime.value = audioEl.value.currentTime;
}

function onEnded() {
    isPlaying.value = false;
    currentTime.value = 0;
    if (audioEl.value) audioEl.value.currentTime = 0;
}

function onError() {
    hasError.value = true;
    isLoading.value = false;
}

function seek(e: Event) {
    const val = parseFloat((e.target as HTMLInputElement).value);
    if (audioEl.value) {
        audioEl.value.currentTime = val;
        currentTime.value = val;
    }
}

const progress = () => duration.value > 0 ? (currentTime.value / duration.value) * 100 : 0;

onUnmounted(() => {
    if (audioEl.value) {
        audioEl.value.pause();
        audioEl.value.src = '';
    }
});
</script>

<template>
    <div class="audio-player" @click.stop>
        <audio
            ref="audioEl"
            :src="props.media.mid"
            preload="metadata"
            @canplay="onCanPlay"
            @loadedmetadata="onLoadedMetadata"
            @timeupdate="onTimeUpdate"
            @play="isPlaying = true"
            @pause="isPlaying = false"
            @ended="onEnded"
            @error="onError"
        />

        <div class="audio-icon">
            <svg viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z"/>
            </svg>
        </div>

        <div class="audio-body">
            <div class="audio-filename">{{ props.media.fileName || 'Audio' }}</div>

            <div class="audio-controls">
                <button class="play-btn" @click="togglePlay" :disabled="hasError">
                    <svg v-if="isLoading" class="spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                        <circle cx="12" cy="12" r="9" stroke-opacity="0.25"/>
                        <path d="M12 3a9 9 0 0 1 9 9" stroke-linecap="round"/>
                    </svg>
                    <svg v-else-if="isPlaying" viewBox="0 0 24 24" fill="currentColor">
                        <rect x="6" y="4" width="4" height="16" rx="1"/>
                        <rect x="14" y="4" width="4" height="16" rx="1"/>
                    </svg>
                    <svg v-else viewBox="0 0 24 24" fill="currentColor">
                        <path d="M8 5v14l11-7z"/>
                    </svg>
                </button>

                <div class="audio-progress-area">
                    <input
                        type="range"
                        class="audio-seek"
                        :min="0"
                        :max="duration || 100"
                        :value="currentTime"
                        :style="{ '--pct': progress() + '%' }"
                        @input="seek"
                        :disabled="hasError || isLoading"
                    />
                    <div class="audio-times">
                        <span>{{ formatTime(currentTime) }}</span>
                        <span>{{ hasError ? 'Error' : formatTime(duration) }}</span>
                    </div>
                </div>
            </div>
        </div>
    </div>
</template>

<style scoped>
.audio-player {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 12px;
    background: #1a1a2e;
    border-radius: 12px;
    width: 100%;
    box-sizing: border-box;
    color: #e0e0e0;
}

.audio-icon {
    flex-shrink: 0;
    width: 36px;
    height: 36px;
    background: rgba(255,255,255,0.08);
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #9ba4b5;
}

.audio-icon svg {
    width: 18px;
    height: 18px;
}

.audio-body {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
}

.audio-filename {
    font-size: 0.8rem;
    font-weight: 500;
    color: #c9d1d9;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

.audio-controls {
    display: flex;
    align-items: center;
    gap: 8px;
}

.play-btn {
    flex-shrink: 0;
    width: 32px;
    height: 32px;
    border-radius: 50%;
    border: none;
    background: #4f8ef7;
    color: #fff;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    padding: 0;
    transition: background 0.15s;
}

.play-btn:hover:not(:disabled) {
    background: #6fa3ff;
}

.play-btn:disabled {
    opacity: 0.4;
    cursor: default;
}

.play-btn svg {
    width: 16px;
    height: 16px;
}

.spin {
    animation: audio-spin 0.9s linear infinite;
}

@keyframes audio-spin {
    to { transform: rotate(360deg); }
}

.audio-progress-area {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
}

.audio-seek {
    -webkit-appearance: none;
    appearance: none;
    width: 100%;
    height: 4px;
    border-radius: 2px;
    background: linear-gradient(
        to right,
        #4f8ef7 var(--pct, 0%),
        rgba(255,255,255,0.15) var(--pct, 0%)
    );
    cursor: pointer;
    outline: none;
    border: none;
}

.audio-seek::-webkit-slider-thumb {
    -webkit-appearance: none;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: #4f8ef7;
    cursor: pointer;
}

.audio-seek::-moz-range-thumb {
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: #4f8ef7;
    border: none;
    cursor: pointer;
}

.audio-seek:disabled {
    opacity: 0.4;
    cursor: default;
}

.audio-times {
    display: flex;
    justify-content: space-between;
    font-size: 0.68rem;
    color: #7a8499;
}
</style>
