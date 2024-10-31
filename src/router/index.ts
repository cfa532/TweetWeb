import { createRouter, createWebHashHistory, createWebHistory, createMemoryHistory } from 'vue-router';
import { UserPage, MainPage, TweetDetail, UserLogin as Login, EditorModal, IPs } from "@/components"
import { useTweetStore, useAlertStore } from '@/stores';

/**
 * createWebHashHistory: access tweet by IP is ok, by domain not.
 * createWebHistory works for domain base url, so is createWebHistory
 */
export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', name: "main", component: MainPage },
    {
      path: '/tweet/:tweetId/:authorId?',
      name: 'TweetDetail',
      component: TweetDetail,
      props: false,
    },
    {
      path: '/author/:authorId',
      name: 'UserPage',
      component: UserPage,
      props: false,
    },
    { path: '/login', name: "login", component: Login },
    { path: '/ips', name: "IPs", component: IPs },
    {
      path: '/upload', name: "upload", component: EditorModal,
      beforeEnter: (to: any, from: any, next: any) => {
        let user = sessionStorage.getItem("user")
        if (!user) {
          next("login")
        } else
          next()
      },
    },
    { path: '/upgrade',
      name: "upgrade",
      beforeEnter: (to:any, from:any, next: any) => {
        useTweetStore().downloadApk()
        next("main")
      },
      redirect: ""
    },
  ],
})

router.beforeEach((to: any, from: any) => {
  useAlertStore().clear()
})