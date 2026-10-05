import { computed, onActivated, onDeactivated, onMounted, onUnmounted, ref, watch } from 'vue';
import { formatTimeDifference } from '@/lib';

/** Keep tweet ages live with the same cadence as iOS and Android. */
export function useRelativeTime(timestamp: () => number | undefined) {
    const now = ref(Date.now());
    let timer: ReturnType<typeof setTimeout> | undefined;
    let active = false;

    function refresh() {
        clearTimeout(timer);
        timer = undefined;
        now.value = Date.now();
        const publishedAt = timestamp();
        if (!active || document.hidden || publishedAt === undefined) return;
        // One tick per minute for every post, matching iOS and Android. A new post's
        // seconds label may lag up to a minute before it becomes "1m".
        timer = setTimeout(refresh, 60_000);
    }

    function start() {
        active = true;
        refresh();
    }

    function stop() {
        active = false;
        clearTimeout(timer);
        timer = undefined;
    }

    onMounted(() => {
        document.addEventListener('visibilitychange', refresh);
        window.addEventListener('focus', refresh);
        start();
    });
    onActivated(start);
    onDeactivated(stop);
    onUnmounted(() => {
        stop();
        document.removeEventListener('visibilitychange', refresh);
        window.removeEventListener('focus', refresh);
    });
    watch(timestamp, refresh);

    return computed(() => {
        const publishedAt = timestamp();
        return publishedAt === undefined ? '' : formatTimeDifference(publishedAt, now.value);
    });
}
