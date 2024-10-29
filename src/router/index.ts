import { createRouter, createWebHashHistory } from 'vue-router';
import { TweetDetail, UserLogin as Login, EditorModal, IPs } from "@/components"
import MainPage from '@/MainPage.vue';
import { useTweetStore } from '@/stores/tweetStore';

export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', name: "main", component: MainPage },
    { path: '/login', name: "login", component: Login },
    { path: '/ips', name: "IPs", component: IPs },
    {
      path: '/upload', name: "upload", component: EditorModal,
      beforeEnter: (to: any, from: any, next: any) => {
        let user = sessionStorage.getItem("userId")
        if (!user) {
          next("login")
        } else
          next()
      },
    },
    {
      path: '/tweet/:tweetId/:authorId?',
      name: 'TweetDetail',
      component: TweetDetail,
      props: true,
    },
    { path: '/upgrade',
      name: "upgrade",
      beforeEnter: (to:any, from:any, next: any) => {
        useTweetStore().downloadApk()
        next("main")
      },
      redirect: ""
    },
  ]
})