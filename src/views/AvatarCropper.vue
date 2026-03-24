<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch, nextTick } from 'vue';

const props = defineProps<{
    visible: boolean;
}>();

const emit = defineEmits<{
    (e: 'crop', blob: Blob): void;
    (e: 'cancel'): void;
}>();

const fileInput = ref<HTMLInputElement | null>(null);
const canvasRef = ref<HTMLCanvasElement | null>(null);
const wrapperRef = ref<HTMLDivElement | null>(null);

const selectedImage = ref<HTMLImageElement | null>(null);
const imageLoaded = ref(false);

// Transform state (in CSS pixels, applied to the displayed image)
const scale = ref(1);
const offsetX = ref(0);
const offsetY = ref(0);

// Drag state
let isDragging = false;
let dragStartX = 0;
let dragStartY = 0;
let lastOffsetX = 0;
let lastOffsetY = 0;

// Pinch state
let lastPinchDist = 0;

const CIRCLE_SIZE = 256;
// Output resolution for the cropped avatar
const OUTPUT_SIZE = 200;

// Canvas display dimensions (CSS pixels)
let canvasCSSWidth = 0;
let canvasCSSHeight = 0;

watch(() => props.visible, (val) => {
    if (val) {
        selectedImage.value = null;
        imageLoaded.value = false;
        scale.value = 1;
        offsetX.value = 0;
        offsetY.value = 0;
        setTimeout(() => fileInput.value?.click(), 100);
    }
});

function onFileSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) {
        emit('cancel');
        return;
    }
    const img = new Image();
    img.onload = () => {
        selectedImage.value = img;
        imageLoaded.value = true;
        nextTick(() => {
            sizeCanvas();
            // Scale so the image's shortest side just covers the circle
            const minImgDim = Math.min(img.width, img.height);
            scale.value = CIRCLE_SIZE / minImgDim;
            offsetX.value = 0;
            offsetY.value = 0;
            draw();
        });
    };
    img.onerror = () => emit('cancel');
    img.src = URL.createObjectURL(file);
    input.value = '';
}

function sizeCanvas() {
    const canvas = canvasRef.value;
    const wrapper = wrapperRef.value;
    if (!canvas || !wrapper) return;

    const dpr = window.devicePixelRatio || 1;
    canvasCSSWidth = wrapper.clientWidth;
    canvasCSSHeight = wrapper.clientHeight;

    canvas.width = canvasCSSWidth * dpr;
    canvas.height = canvasCSSHeight * dpr;
    canvas.style.width = canvasCSSWidth + 'px';
    canvas.style.height = canvasCSSHeight + 'px';

    const ctx = canvas.getContext('2d');
    if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function draw() {
    const canvas = canvasRef.value;
    const img = selectedImage.value;
    if (!canvas || !img) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const w = canvasCSSWidth;
    const h = canvasCSSHeight;

    ctx.clearRect(0, 0, w, h);

    // Draw the image centered with scale and offset
    const imgW = img.width * scale.value;
    const imgH = img.height * scale.value;
    const ix = (w - imgW) / 2 + offsetX.value;
    const iy = (h - imgH) / 2 + offsetY.value;
    ctx.drawImage(img, ix, iy, imgW, imgH);

    // Dark overlay with circular cutout
    ctx.save();
    ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
    ctx.beginPath();
    ctx.rect(0, 0, w, h);
    ctx.arc(w / 2, h / 2, CIRCLE_SIZE / 2, 0, Math.PI * 2, true);
    ctx.fill();
    ctx.restore();

    // Circle border
    ctx.save();
    ctx.strokeStyle = 'white';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(w / 2, h / 2, CIRCLE_SIZE / 2, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
}

// Pointer events
function onPointerDown(e: PointerEvent) {
    if (!imageLoaded.value) return;
    isDragging = true;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    lastOffsetX = offsetX.value;
    lastOffsetY = offsetY.value;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
}

function onPointerMove(e: PointerEvent) {
    if (!isDragging) return;
    offsetX.value = lastOffsetX + (e.clientX - dragStartX);
    offsetY.value = lastOffsetY + (e.clientY - dragStartY);
    requestAnimationFrame(draw);
}

function onPointerUp() {
    isDragging = false;
}

// Touch pinch zoom
function onTouchStart(e: TouchEvent) {
    if (e.touches.length === 2) {
        lastPinchDist = getTouchDist(e);
    }
}

function onTouchMove(e: TouchEvent) {
    if (e.touches.length === 2) {
        e.preventDefault();
        const dist = getTouchDist(e);
        if (lastPinchDist > 0) {
            const delta = dist / lastPinchDist;
            scale.value = Math.min(Math.max(scale.value * delta, 0.01), 20);
            requestAnimationFrame(draw);
        }
        lastPinchDist = dist;
    }
}

function onTouchEnd() {
    lastPinchDist = 0;
}

function getTouchDist(e: TouchEvent): number {
    const dx = e.touches[0].clientX - e.touches[1].clientX;
    const dy = e.touches[0].clientY - e.touches[1].clientY;
    return Math.sqrt(dx * dx + dy * dy);
}

// Mouse wheel zoom
function onWheel(e: WheelEvent) {
    if (!imageLoaded.value) return;
    e.preventDefault();
    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    scale.value = Math.min(Math.max(scale.value * delta, 0.01), 20);
    requestAnimationFrame(draw);
}

function handleCrop() {
    const img = selectedImage.value;
    if (!img) return;

    const w = canvasCSSWidth;
    const h = canvasCSSHeight;

    // Image position in CSS pixels
    const imgW = img.width * scale.value;
    const imgH = img.height * scale.value;
    const ix = (w - imgW) / 2 + offsetX.value;
    const iy = (h - imgH) / 2 + offsetY.value;

    // Circle center
    const cx = w / 2;
    const cy = h / 2;
    const r = CIRCLE_SIZE / 2;

    // Map circle bounds to original image pixel coordinates
    const cropX = (cx - r - ix) / scale.value;
    const cropY = (cy - r - iy) / scale.value;
    const cropSize = CIRCLE_SIZE / scale.value;

    // Clamp
    const clampedSize = Math.min(cropSize, img.width, img.height);
    const clampedX = Math.max(0, Math.min(cropX, img.width - clampedSize));
    const clampedY = Math.max(0, Math.min(cropY, img.height - clampedSize));

    const outCanvas = document.createElement('canvas');
    outCanvas.width = OUTPUT_SIZE;
    outCanvas.height = OUTPUT_SIZE;
    const outCtx = outCanvas.getContext('2d');
    if (!outCtx) return;

    outCtx.drawImage(img, clampedX, clampedY, clampedSize, clampedSize, 0, 0, OUTPUT_SIZE, OUTPUT_SIZE);

    outCanvas.toBlob((blob) => {
        if (blob) emit('crop', blob);
    }, 'image/jpeg', 0.9);
}

function handleCancel() {
    emit('cancel');
}

function onResize() {
    sizeCanvas();
    if (imageLoaded.value) draw();
}

onMounted(() => {
    window.addEventListener('resize', onResize);
});

onUnmounted(() => {
    window.removeEventListener('resize', onResize);
});
</script>

<template>
    <div v-if="visible" class="avatar-cropper-overlay">
        <input ref="fileInput" type="file" accept="image/*" style="display: none" @change="onFileSelected" />

        <div v-if="!imageLoaded" class="select-photo-view">
            <svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 24 24" fill="none"
                stroke="rgba(255,255,255,0.4)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
                <circle cx="8.5" cy="8.5" r="1.5"></circle>
                <polyline points="21 15 16 10 5 21"></polyline>
            </svg>
            <p class="select-text">{{ $t('avatar.selectPhoto') }}</p>
            <button class="btn-choose" @click="fileInput?.click()">{{ $t('avatar.choosePhoto') }}</button>
            <button class="btn-cancel-select" @click="handleCancel">{{ $t('common.cancel') }}</button>
        </div>

        <div v-else class="cropper-container">
            <div ref="wrapperRef" class="canvas-wrapper"
                @wheel.prevent="onWheel"
                @touchstart="onTouchStart"
                @touchmove="onTouchMove"
                @touchend="onTouchEnd">
                <canvas ref="canvasRef"
                    @pointerdown="onPointerDown"
                    @pointermove="onPointerMove"
                    @pointerup="onPointerUp"
                    @pointercancel="onPointerUp" />
            </div>
            <div class="cropper-buttons">
                <button class="btn-crop-cancel" @click="handleCancel">{{ $t('common.cancel') }}</button>
                <button class="btn-crop-done" @click="handleCrop">{{ $t('avatar.choose') }}</button>
            </div>
        </div>
    </div>
</template>

<style scoped>
.avatar-cropper-overlay {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: #000;
    z-index: 2000;
    display: flex;
    flex-direction: column;
}

.select-photo-view {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 24px;
}

.select-text {
    color: rgba(255, 255, 255, 0.9);
    font-size: 1.1rem;
    font-weight: 500;
}

.btn-choose {
    background: #007AFF;
    color: white;
    border: none;
    border-radius: 10px;
    padding: 14px 0;
    width: 280px;
    font-size: 17px;
    font-weight: 600;
    cursor: pointer;
}

.btn-cancel-select {
    background: rgba(255, 255, 255, 0.15);
    color: rgba(255, 255, 255, 0.9);
    border: none;
    border-radius: 10px;
    padding: 14px 0;
    width: 280px;
    font-size: 17px;
    cursor: pointer;
}

.cropper-container {
    flex: 1;
    display: flex;
    flex-direction: column;
}

.canvas-wrapper {
    flex: 1;
    overflow: hidden;
    touch-action: none;
}

.canvas-wrapper canvas {
    display: block;
    cursor: grab;
}

.canvas-wrapper canvas:active {
    cursor: grabbing;
}

.cropper-buttons {
    display: flex;
    justify-content: center;
    gap: 20px;
    padding: 20px 20px 34px;
    background: #000;
}

.btn-crop-cancel {
    background: rgba(255, 255, 255, 0.2);
    color: white;
    border: none;
    border-radius: 10px;
    padding: 13px 24px;
    min-width: 120px;
    font-size: 17px;
    cursor: pointer;
}

.btn-crop-done {
    background: #007AFF;
    color: white;
    border: none;
    border-radius: 10px;
    padding: 13px 24px;
    min-width: 120px;
    font-size: 17px;
    font-weight: 600;
    cursor: pointer;
}
</style>
