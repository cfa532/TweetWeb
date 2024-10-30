import { createRouter, createWebHashHistory, createWebHistory, createMemoryHistory } from 'vue-router';
import { MainPage, TweetDetail, UserLogin as Login, EditorModal, IPs } from "@/components"
import { useTweetStore } from '@/stores/tweetStore';

/**
 * createWebHashHistory: access tweet by IP is ok, by domain not.
 * createWebHistory works for domain base url, so is createWebHistory
 */
export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    {
      path: '/tweet/:tweetId/:authorId?',
      name: 'TweetDetail',
      component: TweetDetail,
      props: true,
    },
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

// router.beforeEach((to: any, from: any) => {
//   console.log("From", from)
//   console.log("To:", to)
// })