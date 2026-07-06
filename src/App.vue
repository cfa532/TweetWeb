<script setup lang="ts">
import { Alert } from './views';
</script>

<template>
  <div class="container-fluid">
    <Alert/>
    <router-view v-slot="{ Component }">
      <keep-alive :include="['MainPage', 'UserPage', 'Followers', 'Followings']">
        <component :is="Component" />
      </keep-alive>
    </router-view>
  </div>
</template>

<style scoped>
.container-fluid {
    padding: 0px;
    max-width: 600px;
}
</style>
