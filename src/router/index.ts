import { createRouter, createWebHistory } from 'vue-router';
import TweetDetail from "@/components/TweetDetail.vue"
import MainPage from '@/MainPage.vue';
import { useTweetListStore } from '@/stores/tweetStore';
// const tweetStore = useTweetListStore()

const routes = [
  { path: '/', name:"main", component: MainPage},
  { path: '/tweet/:tweetId',
    name: 'TweetDetail',
    component: TweetDetail,
    props: true},
  { path: '/upgrade',
    name:"upgrade",
    beforeEnter: (to:any, from:any, next: any) => {
      console.log("before download", to, from, next)
      useTweetListStore().downloadApk()
      next("main")
    },
    redirect: "",
  },
];

const router = createRouter({
  history: createWebHistory(),
  routes
});

export default router;