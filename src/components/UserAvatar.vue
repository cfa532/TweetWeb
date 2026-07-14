<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { PropType } from 'vue'
import { avatarSrc } from '@/lib'

defineOptions({ inheritAttrs: false })

const props = defineProps({
    user: { type: Object as PropType<User>, required: true },
    src: { type: String, required: false },
})

const intendedSrc = computed(() => props.src || avatarSrc(props.user.avatar))
// Falls back to the default logo if the intended avatar URL fails to load
// (e.g. the user's provider host is unreachable). VITE_APP_LOGO is itself a
// remote URL, so if that also fails to load (e.g. that host is down), fall
// back further to a same-origin asset that doesn't depend on any external
// host, so the avatar never hangs blank.
const errorStage = ref(0)
const resolvedSrc = computed(() => {
    if (errorStage.value >= 2) return '/ic_splash.png'
    if (errorStage.value === 1) return avatarSrc(undefined)
    return intendedSrc.value
})

watch(intendedSrc, () => { errorStage.value = 0 })

function onImgError() {
    errorStage.value += 1
}

const tooltip = computed(() => [
    `User ID: ${props.user.mid}`,
    `Host ID: ${props.user.hostIds?.[0] ?? 'N/A'}`,
    `Base IP: ${props.user.providerIp ?? 'N/A'}`,
].join('\n'))
</script>

<template>
    <img v-bind="$attrs" :src="resolvedSrc" :title="tooltip" @error="onImgError" />
</template>
