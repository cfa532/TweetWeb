import type { Router } from 'vue-router'

export function redirectGuestToLogin(router: Router, redirect: string = '/') {
  const target = router.resolve(redirect)

  if (target.name && target.name !== 'login') {
    void router.push({
      path: target.path,
      query: {
        ...target.query,
        login: '1',
        redirect,
      },
      hash: target.hash,
    })
    return
  }

  void router.push({ name: 'login', query: { redirect } })
}

export function requireLoginForWritableAction(
  isLoggedIn: boolean,
  router: Router,
  redirect: string = '/',
): boolean {
  if (isLoggedIn) return true

  redirectGuestToLogin(router, redirect)
  return false
}
