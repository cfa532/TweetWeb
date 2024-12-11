<script setup lang='ts'>
import { onMounted, computed, ref } from 'vue';
import type { PropType } from 'vue';
import { useRouter } from 'vue-router';
import { formatTimeDifference } from '@/lib';
import { useTweetStore } from '@/stores';
import { QRCoder } from '@/views';

const props = defineProps({
  author: { type: Object as PropType<User>, required: true },
  timestamp: { type: Number, required: false },
  isRetweet: { type: Boolean, required: false, default: false },
  by: { type: String, required: false }
});

const tweetStore = useTweetStore();
const router = useRouter();
const downloadApk = import.meta.env.VITE_APP_PKG
const dlUrl = ref();
const qrSize = ref(60);

const avatar = computed(() => {
  let url = 'http://' + props.author.providerIp;
  let mid = props.author.avatar;
  if (mid) return mid.length > 27 ? url + '/ipfs/' + mid : url + '/mm/' + mid;
});

onMounted(async () => {
  if (sessionStorage["isBot"] != "No") {
        confirm("芝麻，开门！\nOpen Sesame!\n開け！ゴマ\nيا سمسم، افتح الباب!") ? sessionStorage["isBot"] = "No" : history.go(-1)
    }
  let host = await tweetStore.getProviderIp(downloadApk);
  dlUrl.value = downloadApk.length > 27 ? 'http://' + host + '/ipfs/' + downloadApk : 'http://' + host + '/mm/' + downloadApk;
});

function openUserPage(userId: string) {
  tweetStore.addFollowing(userId);
  router.push(`/author/${userId}`);
}
</script>

<template>
  <div class='d-flex justify-content-between align-items-center' style='width: 100%;'>
    <div class='d-flex align-items-center'>
      <div class='avatar me-2'>
        <img :src='avatar' alt='User Avatar' class='rounded-circle' @click.stop='openUserPage(author.mid)'>
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
    <div class='d-flex align-items-end'>
      <button class='btn btn-link' @click='tweetStore.downloadApk'>APP ⬇️</button>
      <div class='qr-code-container'>
        <QRCoder v-if='dlUrl' :url='dlUrl' :size='qrSize'></QRCoder>
      </div>
    </div>
  </div>
</template>

<style scoped>
.btn {
  font-size: 0.8rem;
}
.qr-code-container {
  display: flex;
  justify-content: center;
  align-items: center;
}
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
.links a {
  color: #3d5563;
  text-decoration: none;
  font-size: 0.9rem;
}
.links a:hover {
  text-decoration: underline;
}
</style>