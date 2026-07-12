<script setup lang="ts">
import { computed } from 'vue'
import type { PropType } from 'vue'
import { avatarSrc } from '@/lib'

defineOptions({ inheritAttrs: false })

const props = defineProps({
    user: { type: Object as PropType<User>, required: true },
    src: { type: String, required: false },
})

const resolvedSrc = computed(() => props.src || avatarSrc(props.user.avatar))
const tooltip = computed(() => [
    `User ID: ${props.user.mid}`,
    `Host ID: ${props.user.hostIds?.[0] ?? 'N/A'}`,
    `Base IP: ${props.user.providerIp ?? 'N/A'}`,
].join('\n'))
</script>

<template>
    <img v-bind="$attrs" :src="resolvedSrc" :title="tooltip" />
</template>
