<script setup lang="ts">
import { computed } from 'vue'
interface Props {
  size?: 'sm' | 'md' | 'lg'
  color?: string
  visible?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  size: 'md',
  color: 'primary',
  visible: true
})

const sizeClass = computed(() => {
  switch (props.size) {
    case 'sm': return 'spinner-border-sm'
    case 'lg': return 'spinner-border-lg'
    default: return ''
  }
})
</script>

<template>
  <div v-if="visible" :class="['spinner-border', `text-${color}`, sizeClass]" role="status">
    <span class="visually-hidden">Loading...</span>
  </div>
</template>

<style scoped>
/* Additional custom spinner styles can go here if needed */
</style>