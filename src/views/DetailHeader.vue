<script setup lang='ts'>
import type { PropType } from 'vue';
import { useRouter } from 'vue-router';
import { formatTimeDifference } from '@/lib';
import { useTweetStore } from '@/stores';

const props = defineProps({
  author: { type: Object as PropType<User>, required: true },
  timestamp: { type: Number, required: false },
  isRetweet: { type: Boolean, required: false, default: false },
  by: { type: String, required: false }
});

const tweetStore = useTweetStore();
const router = useRouter();

function openUserPage(userId: string) {
  tweetStore.addFollowing(userId);
  router.push(`/author/${userId}`);
}
</script>

<template>
  <div class='d-flex justify-content-between align-items-center' style='width: 100%; margin: 2px 0px'>
    <div class='d-flex align-items-center'>
      <div class='avatar me-2'>
        <img :src='author.avatar' alt='User Avatar' class='rounded-circle' @click.stop='openUserPage(author.mid)'>
      </div>
      <div class='user-info flex-grow-1'>
        <div v-if='isRetweet' class='label text-muted small'>
          Forwarded by @{{ by }}
        </div>
        <div class='username-alias-time'>
          <span class='username fw-bold'>{{ author.name }}</span>
          <span class='alias text-muted'>@{{ author.username }}</span>
        </div>
        <div class='mt-1'>
          <span v-if='props.timestamp' class='time text-muted'>{{ formatTimeDifference(props.timestamp as number) }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.text-muted {
  font-size: 0.95rem;
}
.username {
  font-size: 0.9rem;
}
.alias {
  font-size: 1rem;
}
.avatar {
  display: flex;
  align-items: center;
}
.avatar img {
  object-fit: cover;
  width: 50px;
  height: 50px;
  cursor: pointer;
}
.user-info {
  font-size: 0.9rem;
  flex-grow: 1;
}
</style>