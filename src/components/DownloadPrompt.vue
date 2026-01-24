<script setup lang="ts">
import { computed } from 'vue';

// Localization for download prompt
const downloadText = computed(() => {
    const language = navigator.language || 'en'

    if (language.startsWith('zh')) {
        return '下载APP获得最佳体验'
    } else if (language.startsWith('ja')) {
        return 'ネイティブアプリで最高の体験を'
    } else {
        return '下载APP获得最佳体验'
    }
})

// Props
const props = defineProps<{
    show: boolean
}>()

// Emits
const emit = defineEmits<{
    click: []
}>()

const handleClick = () => {
    emit('click')
}
</script>

<template>
    <!-- App Download Prompt for All Users -->
    <div v-if="show" class="download-prompt" @click="handleClick">
        <div class="prompt-content">
            <div class="prompt-text">
                <p>{{ downloadText }} ⬇️</p>
            </div>
        </div>
    </div>
</template>

<style scoped>
.download-prompt {
    position: relative;
    width: 100%;
    background: #1a1a1a;
    color: #ffffff;
    padding: 0 15px 0 0;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
    margin-top: 10px;
    cursor: pointer;
    transition: transform 0.2s ease;
    animation: rotateToVertical 0.6s ease-out;
    transform-style: preserve-3d;
    perspective: 1000px;
}

.download-prompt:hover {
    transform: translateY(-1px);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
}

.prompt-content {
    display: flex;
    justify-content: flex-start;
    align-items: center;
    max-width: 100%;
    margin: 0;
    gap: 8px;
}

.prompt-text p {
    margin: 0;
    padding: 4px 0;
    font-size: 1.0rem;
    font-weight: 500;
    opacity: 0.9;
    line-height: 1.4;
}

.prompt-icon {
    font-size: 1rem;
    flex-shrink: 0;
}

@keyframes rotateToVertical {
    from {
        transform: rotateX(90deg);
        opacity: 0;
    }
    to {
        transform: rotateX(0deg);
        opacity: 1;
    }
}

@media (max-width: 768px) {
    .prompt-content {
        flex-direction: column;
        gap: 15px;
        text-align: center;
    }

    .prompt-text p {
        font-size: 0.85rem;
    }
}
</style>