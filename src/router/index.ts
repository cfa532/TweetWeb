import { createRouter, createWebHistory } from 'vue-router';
import TweetDetail from "@/components/TweetDetail.vue"
import MainPage from '@/MainPage.vue';

const routes = [
  { path: '/', name:"main", component: MainPage},
  { path: '/tweet/:tweetId',
    name: 'TweetDetail',
    component: TweetDetail,
    props: true
  }
];

const router = createRouter({
  history: createWebHistory(),
  routes
});

export default router;