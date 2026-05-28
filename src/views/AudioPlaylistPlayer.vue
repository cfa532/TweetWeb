<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import type { PropType } from 'vue';

const props = defineProps({
    mediaList: { type: Array as PropType<MimeiFileType[]>, required: true },
});

const audioEl = ref<HTMLAudioElement | null>(null);
const isOpen = ref(false);
const isPlaying = ref(false);
const isLoading = ref(false);
const hasError = ref(false);
const currentIndex = ref(0);
const currentTime = ref(0);
const duration = ref(0);

const audioItems = computed(() => props.mediaList.filter(media => {
    const type = media.type?.toLowerCase() || '';
    return type.includes('audio');
}));

const currentMedia = computed(() => audioItems.value[currentIndex.value]);

const currentTitle = computed(() => {
    return currentMedia.value?.fileName?.trim() || 'Audio';
});

const progress = computed(() => {
    if (!duration.value || !isFinite(duration.value)) return 0;
    return Math.min(100, Math.max(0, (currentTime.value / duration.value) * 100));
});

function formatTime(seconds: number): string {
    if (!isFinite(seconds) || isNaN(seconds) || seconds < 0) return '0:00';
    const minutes = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${minutes}:${secs.toString().padStart(2, '0')}`;
}

function loadCurrent(shouldPlay = false) {
    const audio = audioEl.value;
    const media = currentMedia.value;
    if (!audio || !media) return;

    hasError.value = false;
    isLoading.value = true;
    currentTime.value = 0;
    duration.value = 0;
    audio.src = media.mid;
    audio.load();

    if (shouldPlay) {
        nextTick(() => {
            audio.play().catch(() => {
                isPlaying.value = false;
            });
        });
    }
}

function toggleDropdown() {
    isOpen.value = !isOpen.value;
}

function selectItem(index: number) {
    if (index < 0 || index >= audioItems.value.length) return;
    const shouldResume = isPlaying.value;
    currentIndex.value = index;
    isOpen.value = false;
    loadCurrent(shouldResume);
}

function togglePlay() {
    const audio = audioEl.value;
    if (!audio || hasError.value) return;

    if (isPlaying.value) {
        audio.pause();
    } else {
        audio.play().catch(() => {
            isPlaying.value = false;
        });
    }
}

function playPrevious() {
    if (audioItems.value.length <= 1) return;
    selectItem((currentIndex.value - 1 + audioItems.value.length) % audioItems.value.length);
}

function playNext() {
    if (audioItems.value.length <= 1) return;
    selectItem((currentIndex.value + 1) % audioItems.value.length);
}

function seek(event: Event) {
    const audio = audioEl.value;
    if (!audio) return;
    const value = parseFloat((event.target as HTMLInputElement).value);
    audio.currentTime = value;
    currentTime.value = value;
}

function onLoadedMetadata() {
    if (audioEl.value) {
        duration.value = audioEl.value.duration;
    }
}

function onTimeUpdate() {
    if (audioEl.value) {
        currentTime.value = audioEl.value.currentTime;
    }
}

function onCanPlay() {
    isLoading.value = false;
}

function onError() {
    hasError.value = true;
    isLoading.value = false;
    isPlaying.value = false;
}

function onEnded() {
    if (audioItems.value.length > 1) {
        playNext();
        return;
    }

    isPlaying.value = false;
    currentTime.value = 0;
    if (audioEl.value) audioEl.value.currentTime = 0;
}

watch(audioItems, (items) => {
    if (currentIndex.value >= items.length) {
        currentIndex.value = 0;
    }
    loadCurrent(false);
}, { deep: true });

onBeforeUnmount(() => {
    if (audioEl.value) {
        audioEl.value.pause();
        audioEl.value.src = '';
    }
});
</script>

<template>
    <section v-if="audioItems.length" class="audio-playlist-player" @click.stop>
        <audio
            ref="audioEl"
            :src="currentMedia?.mid"
            preload="metadata"
            @loadedmetadata="onLoadedMetadata"
            @timeupdate="onTimeUpdate"
            @canplay="onCanPlay"
            @play="isPlaying = true"
            @pause="isPlaying = false"
            @ended="onEnded"
            @error="onError"
        />

        <div class="playlist-row-wrap">
            <button class="playlist-row" type="button" @click.stop="toggleDropdown">
                <span class="playlist-title">{{ currentTitle }}</span>
                <svg class="playlist-chevron" :class="{ open: isOpen }" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M7 10l5 5 5-5z" />
                </svg>
            </button>

            <div v-if="isOpen" class="playlist-menu" @click.stop>
                <button
                    v-for="(item, index) in audioItems"
                    :key="item.mid"
                    class="playlist-item"
                    :class="{ selected: index === currentIndex }"
                    type="button"
                    @click="selectItem(index)"
                >
                    <span class="playlist-item-name">{{ item.fileName || 'Audio' }}</span>
                    <span v-if="index === currentIndex" class="playlist-check" aria-hidden="true">
                        <svg viewBox="0 0 24 24" fill="currentColor">
                            <path d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z" />
                        </svg>
                    </span>
                </button>
            </div>
        </div>

        <div class="audio-controls">
            <button
                class="control-btn"
                type="button"
                :disabled="audioItems.length <= 1"
                @click.stop="playPrevious"
            >
                <svg viewBox="0 0 24 24" fill="currentColor">
                    <path d="M11 6v12L3 12l8-6Zm10 0v12l-8-6 8-6Z" />
                </svg>
            </button>

            <button
                class="control-btn primary"
                type="button"
                :disabled="hasError"
                @click.stop="togglePlay"
            >
                <svg v-if="isLoading && !hasError" class="spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                    <circle cx="12" cy="12" r="9" stroke-opacity="0.25" />
                    <path d="M12 3a9 9 0 0 1 9 9" stroke-linecap="round" />
                </svg>
                <svg v-else-if="isPlaying" viewBox="0 0 24 24" fill="currentColor">
                    <rect x="6" y="4" width="4" height="16" rx="1" />
                    <rect x="14" y="4" width="4" height="16" rx="1" />
                </svg>
                <svg v-else viewBox="0 0 24 24" fill="currentColor">
                    <path d="M8 5v14l11-7z" />
                </svg>
            </button>

            <button
                class="control-btn"
                type="button"
                :disabled="audioItems.length <= 1"
                @click.stop="playNext"
            >
                <svg viewBox="0 0 24 24" fill="currentColor">
                    <path d="M13 6v12l8-6-8-6ZM3 6v12l8-6-8-6Z" />
                </svg>
            </button>
        </div>

        <div class="progress-block">
            <input
                type="range"
                class="audio-seek"
                :min="0"
                :max="duration || 100"
                :value="currentTime"
                :style="{ '--pct': progress + '%' }"
                :disabled="hasError || isLoading"
                @input="seek"
                @click.stop
            />
            <div class="audio-times">
                <span>{{ formatTime(currentTime) }}</span>
                <span>{{ hasError ? 'Error' : formatTime(duration) }}</span>
            </div>
        </div>
    </section>
</template>

<style scoped>
.audio-playlist-player {
    position: relative;
    width: 100%;
    box-sizing: border-box;
    padding: 8px 12px;
    border: 1px solid rgba(0, 0, 0, 0.08);
    border-radius: 10px;
    background: var(--bs-secondary-bg, #f0f2f5);
    color: var(--bs-body-color, #1f2328);
}

.playlist-row-wrap {
    position: relative;
}

.playlist-row {
    width: 100%;
    min-height: 40px;
    padding: 0;
    border: 0;
    background: transparent;
    color: inherit;
    display: flex;
    align-items: center;
    gap: 8px;
    cursor: pointer;
    text-align: left;
}

.playlist-title {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 1rem;
    font-weight: 650;
}

.playlist-chevron {
    width: 20px;
    height: 20px;
    color: var(--bs-secondary-color, #6a737d);
    transition: transform 0.16s ease;
}

.playlist-chevron.open {
    transform: rotate(180deg);
}

.playlist-menu {
    position: absolute;
    z-index: 30;
    left: 0;
    right: 0;
    top: calc(100% + 4px);
    max-height: 220px;
    overflow-y: auto;
    padding: 4px;
    border: 1px solid rgba(0, 0, 0, 0.12);
    border-radius: 8px;
    background: var(--bs-body-bg, #fff);
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.18);
}

.playlist-item {
    width: 100%;
    min-height: 38px;
    padding: 0 8px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: inherit;
    display: flex;
    align-items: center;
    gap: 8px;
    cursor: pointer;
    text-align: left;
}

.playlist-item:hover,
.playlist-item.selected {
    background: rgba(79, 142, 247, 0.12);
}

.playlist-item-name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.playlist-check {
    color: #4f8ef7;
    display: inline-flex;
    width: 18px;
    height: 18px;
}

.playlist-check svg {
    width: 18px;
    height: 18px;
}

.audio-controls {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    margin: 8px 0;
}

.control-btn {
    width: 48px;
    height: 48px;
    border: 0;
    border-radius: 50%;
    background: rgba(0, 0, 0, 0.07);
    color: inherit;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    padding: 0;
}

.control-btn.primary {
    background: #4f8ef7;
    color: #fff;
}

.control-btn:disabled {
    opacity: 0.38;
    cursor: default;
}

.control-btn svg {
    width: 19px;
    height: 19px;
}

.control-btn.primary svg {
    width: 23px;
    height: 23px;
}

.spin {
    animation: audio-spin 0.9s linear infinite;
}

@keyframes audio-spin {
    to { transform: rotate(360deg); }
}

.progress-block {
    display: flex;
    flex-direction: column;
    gap: 5px;
}

.audio-seek {
    -webkit-appearance: none;
    appearance: none;
    width: 100%;
    height: 8px;
    border-radius: 999px;
    background: linear-gradient(
        to right,
        #4f8ef7 var(--pct, 0%),
        rgba(0, 0, 0, 0.15) var(--pct, 0%)
    );
    cursor: pointer;
    outline: none;
    border: 0;
}

.audio-seek::-webkit-slider-thumb {
    -webkit-appearance: none;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: #4f8ef7;
    cursor: pointer;
}

.audio-seek::-moz-range-thumb {
    width: 14px;
    height: 14px;
    border: 0;
    border-radius: 50%;
    background: #4f8ef7;
    cursor: pointer;
}

.audio-times {
    display: flex;
    justify-content: space-between;
    color: var(--bs-secondary-color, #6a737d);
    font-size: 0.75rem;
    font-variant-numeric: tabular-nums;
}
</style>
