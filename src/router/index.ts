import { createRouter, createWebHistory } from 'vue-router';
import { TweetDetail, UserLogin as Login, EditorModal } from "@/components"
import MainPage from '@/MainPage.vue';
import { useTweetStore } from '@/stores/tweetStore';

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: "main", component: MainPage },
    { path: '/login', name: "login", component: Login },
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