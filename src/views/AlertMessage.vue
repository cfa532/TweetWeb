<script setup lang="ts">
import { storeToRefs } from 'pinia';
import { useAlertStore } from '@/stores';
import type { ToastType } from '@/stores/alert.store';

const alertStore = useAlertStore();
const { toasts } = storeToRefs(alertStore);

const iconByType: Record<ToastType, string> = {
    success: 'circle-check',
    error: 'triangle-exclamation',
    warning: 'triangle-exclamation',
    info: 'circle-info',
}
</script>

<template>
    <Teleport to="body">
        <TransitionGroup name="toast-stack" tag="div" class="toast-viewport" aria-live="polite" aria-atomic="true">
            <div
                v-for="toast in toasts"
                :key="toast.id"
                class="app-toast"
                :class="`app-toast--${toast.type}`"
                role="status"
            >
                <font-awesome-icon class="app-toast__icon" :icon="iconByType[toast.type]" />
                <span class="app-toast__message">{{ toast.message }}</span>
                <button
                    class="app-toast__close"
                    type="button"
                    :aria-label="String($t('common.close'))"
                    @click="alertStore.clear(toast.id)"
                >
                    <font-awesome-icon icon="xmark" />
                </button>
            </div>
        </TransitionGroup>
    </Teleport>
</template>

<style scoped>
.toast-viewport {
    position: fixed;
    left: 50%;
    bottom: calc(24px + env(safe-area-inset-bottom));
    z-index: 2147483000;
    display: flex;
    width: min(520px, calc(100vw - 24px));
    transform: translateX(-50%);
    flex-direction: column;
    align-items: center;
    gap: 10px;
    pointer-events: none;
}

.app-toast {
    display: grid;
    grid-template-columns: 20px minmax(0, 1fr) 28px;
    align-items: center;
    width: fit-content;
    max-width: 100%;
    min-height: 48px;
    gap: 10px;
    padding: 10px 10px 10px 16px;
    border: 1px solid rgba(112, 112, 112, 0.28);
    border-radius: 16px;
    background: rgba(248, 248, 248, 0.96);
    color: #1f2328;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
    font-size: 15px;
    font-weight: 600;
    line-height: 1.35;
    pointer-events: auto;
}

.app-toast__icon {
    width: 18px;
    height: 18px;
}

.app-toast__message {
    min-width: 0;
    overflow-wrap: anywhere;
}

.app-toast__close {
    display: inline-flex;
    width: 28px;
    height: 28px;
    align-items: center;
    justify-content: center;
    border: 0;
    border-radius: 50%;
    background: transparent;
    color: #606770;
    cursor: pointer;
}

.app-toast__close:hover,
.app-toast__close:focus-visible {
    background: rgba(0, 0, 0, 0.07);
    color: #1f2328;
    outline: none;
}

.app-toast--success .app-toast__icon {
    color: #1a7f37;
}

.app-toast--error .app-toast__icon {
    color: #cf222e;
}

.app-toast--warning .app-toast__icon {
    color: #9a6700;
}

.app-toast--info .app-toast__icon {
    color: #0969da;
}

.toast-stack-enter-active,
.toast-stack-leave-active {
    transition: opacity 0.24s ease, transform 0.24s ease;
}

.toast-stack-enter-from,
.toast-stack-leave-to {
    opacity: 0;
    transform: translateY(18px);
}

.toast-stack-move {
    transition: transform 0.24s ease;
}

@media (prefers-color-scheme: dark) {
    .app-toast {
        border-color: rgba(255, 255, 255, 0.16);
        background: rgba(34, 34, 34, 0.96);
        color: #f0f0f0;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.42);
    }

    .app-toast__close {
        color: #c9c9c9;
    }

    .app-toast__close:hover,
    .app-toast__close:focus-visible {
        background: rgba(255, 255, 255, 0.10);
        color: #ffffff;
    }
}
</style>
