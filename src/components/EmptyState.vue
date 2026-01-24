<script setup lang="ts">
interface Props {
  message?: string
  icon?: string
}

const props = withDefaults(defineProps<Props>(), {
  message: 'No items found',
  icon: '📁'
})
</script>

<template>
  <div class="empty-state">
    <div class="empty-icon">{{ icon }}</div>
    <p class="empty-message">{{ message }}</p>
  </div>
</template>

<style scoped>
.empty-state {
  text-align: center;
  padding: 2rem 1rem;
  color: #6c757d;
}

.empty-icon {
  font-size: 3rem;
  margin-bottom: 1rem;
  opacity: 0.5;
}

.empty-message {
  margin: 0;
  font-size: 1.1rem;
}
</style>