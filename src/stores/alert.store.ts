import { defineStore } from 'pinia';
import i18n from '@/i18n';

export type ToastType = 'success' | 'error' | 'warning' | 'info'

export interface ToastMessage {
    id: number
    message: string
    type: ToastType
    durationMs: number
}

interface ShowToastOptions {
    durationMs?: number
    fallbackMessage?: string
    silent?: boolean
}

const toastTimers = new Map<number, ReturnType<typeof setTimeout>>()

function isConnectionError(message: unknown): boolean {
    if (!message) return false
    if ((message as any).isTimeout) return true

    const text = message instanceof Error
        ? `${message.name} ${message.message}`
        : typeof message === 'string'
            ? message
            : String((message as any)?.message ?? message)

    return /timed?\s*out|timeout|failed to fetch|network error|connection request timeout|econnreset|econnrefused/i.test(text)
}

function normalizeMessage(message: unknown, fallbackMessage?: string): string {
    if (isConnectionError(message)) {
        return i18n.global.t('common.connectionTimeout')
    }
    if (fallbackMessage) return fallbackMessage
    if (message instanceof Error) return message.message || i18n.global.t('common.operationFailed')
    if (typeof message === 'string') return message
    if (message == null) return i18n.global.t('common.operationFailed')
    return String((message as any)?.message ?? message)
}

export const useAlertStore = defineStore({
    id: 'alert',
    state: () => ({
        toasts: [] as ToastMessage[],
    }),
    getters: {
        alert: (state) => {
            const toast = state.toasts[0]
            if (!toast) return null
            const typeClass = {
                success: 'alert-success',
                error: 'alert-danger',
                warning: 'alert-warning',
                info: 'alert-info',
            }[toast.type]
            return { message: toast.message, type: typeClass }
        },
    },
    actions: {
        show(type: ToastType, message: unknown, options: ShowToastOptions = {}) {
            if (options.silent) return

            const durationMs = options.durationMs ?? (type === 'error' ? 5000 : type === 'warning' ? 4000 : 2500)
            const toast: ToastMessage = {
                id: Date.now() + Math.floor(Math.random() * 1000),
                message: normalizeMessage(message, options.fallbackMessage),
                type,
                durationMs,
            }
            this.toasts.push(toast)

            const timer = setTimeout(() => this.clear(toast.id), durationMs)
            toastTimers.set(toast.id, timer)
        },
        success(message: unknown, options?: ShowToastOptions) {
            this.show('success', message, options);
        },
        error(message: unknown, options?: ShowToastOptions) {
            this.show('error', message, options);
        },
        warning(message: unknown, options?: ShowToastOptions) {
            this.show('warning', message, options);
        },
        info(message: unknown, options?: ShowToastOptions) {
            this.show('info', message, options);
        },
        clear(id?: number) {
            if (id == null) {
                for (const timer of toastTimers.values()) clearTimeout(timer)
                toastTimers.clear()
                this.toasts = []
                return
            }

            const timer = toastTimers.get(id)
            if (timer) {
                clearTimeout(timer)
                toastTimers.delete(id)
            }
            this.toasts = this.toasts.filter(toast => toast.id !== id)
        }
    }
});
