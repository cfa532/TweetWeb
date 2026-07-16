<script setup lang="ts">
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { Alert } from './views';
import { UserLogin } from './components';

const route = useRoute();
const router = useRouter();

const showLoginModal = computed(() => route.query.login === '1');

const loginRedirect = computed(() => {
  if (typeof route.query.redirect === 'string') return route.query.redirect;

  const query = { ...route.query };
  delete query.login;
  delete query.redirect;

  return router.resolve({
    path: route.path,
    query,
    hash: route.hash,
  }).fullPath;
});

function closeLoginModal() {
  const query = { ...route.query };
  delete query.login;
  delete query.redirect;

  router.replace({
    path: route.path,
    query,
    hash: route.hash,
  });
}
</script>

<template>
  <div class="container-fluid">
    <Alert/>
    <router-view v-slot="{ Component }">
      <keep-alive :include="['MainPage', 'UserPage', 'Followers', 'Followings']">
        <component :is="Component" />
      </keep-alive>
    </router-view>
    <div v-if="showLoginModal" class="login-modal-host">
      <UserLogin :redirect="loginRedirect" @dismiss="closeLoginModal" />
    </div>
  </div>
</template>

<style scoped>
.container-fluid {
    padding: 0px;
    max-width: 600px;
}

.login-modal-host {
    position: fixed;
    top: 72px;
    left: 50%;
    z-index: 2000;
    width: min(100vw, 600px);
    transform: translateX(-50%);
    pointer-events: none;
}

.login-modal-host :deep(.login-modal-overlay) {
    pointer-events: auto;
    margin-top: 0;
    margin-bottom: 0;
}

@media (max-width: 480px) {
    .login-modal-host {
        top: 16px;
    }
}
</style>
