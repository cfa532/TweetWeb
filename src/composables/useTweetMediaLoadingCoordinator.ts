import { computed, onBeforeUnmount, onMounted, ref, watch, type Ref } from 'vue'
import { isImageType, isVideoType, normalizeMediaType } from '@/lib'

export type MediaLoadState = 'idle' | 'preload' | 'visible'

interface TweetEntry {
  tweet: Tweet
  element: HTMLElement
  ratio: number
  top: number
}

const VISIBLE_THRESHOLD = 0.01
const DIRECTIONAL_IMAGE_TWEETS = 2
const DIRECTIONAL_VIDEOS = 2
const REVERSE_TWEETS = 1

function isImageMedia(media: MimeiFileType): boolean {
  const type = normalizeMediaType(media.type)
  return isImageType(type) || type.includes('image')
}

function isVideoMedia(media: MimeiFileType): boolean {
  const type = normalizeMediaType(media.type)
  return isVideoType(type) || type.includes('video')
}

function mediaItems(tweet: Tweet): MimeiFileType[] {
  return tweet.attachments || []
}

function hasImage(tweet: Tweet): boolean {
  return mediaItems(tweet).some(isImageMedia)
}

function visibleRatioForElement(element: HTMLElement): { ratio: number; top: number } {
  if (typeof window === 'undefined') return { ratio: 0, top: 0 }
  const rect = element.getBoundingClientRect()
  if (rect.height <= 0) return { ratio: 0, top: rect.top }
  const visibleTop = Math.max(rect.top, 0)
  const visibleBottom = Math.min(rect.bottom, window.innerHeight)
  const visibleHeight = Math.max(0, visibleBottom - visibleTop)
  return { ratio: visibleHeight / rect.height, top: rect.top }
}

function debugMediaPlan(message: string, payload: Record<string, unknown>) {
  if (!import.meta.env.DEV) return
  console.debug(`[MEDIA COORD] ${message}`, payload)
}

export function useTweetMediaLoadingCoordinator(tweets: Ref<Tweet[]>) {
  const entries = new Map<string, TweetEntry>()
  const version = ref(0)
  const scrollDirection = ref<'down' | 'up'>('down')
  let observer: IntersectionObserver | null = null
  let lastScrollY = typeof window !== 'undefined' ? window.scrollY : 0
  let scrollFrame: number | null = null
  let lastPlanKey = ''

  function bump() {
    version.value += 1
  }

  function sortedEntries(): TweetEntry[] {
    version.value
    return tweets.value
      .map(tweet => entries.get(tweet.mid))
      .filter((entry): entry is TweetEntry => Boolean(entry))
      .sort((a, b) => a.element.compareDocumentPosition(b.element) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1)
  }

  function lastIndexBeforeViewport(entries: TweetEntry[]): number {
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      if (entries[index].top < 0) return index
    }
    return entries.length - 1
  }

  const loadingPlan = computed(() => {
    const ordered = sortedEntries()
    const visibleTweetIds = new Set<string>()
    const preloadTweetIds = new Set<string>()
    const preloadVideoIds = new Set<string>()

    for (const entry of ordered) {
      if (entry.ratio >= VISIBLE_THRESHOLD) {
        visibleTweetIds.add(entry.tweet.mid)
      }
    }

    const visibleIndexes = ordered
      .map((entry, index) => entry.ratio >= VISIBLE_THRESHOLD ? index : -1)
      .filter(index => index >= 0)

    if (ordered.length > 0) {
      const direction = scrollDirection.value
      const startIndex = direction === 'down'
        ? (visibleIndexes.length ? Math.max(...visibleIndexes) + 1 : ordered.findIndex(entry => entry.top > 0))
        : (visibleIndexes.length ? Math.min(...visibleIndexes) - 1 : lastIndexBeforeViewport(ordered))

      const directionalIndexes: number[] = []
      if (direction === 'down') {
        for (let i = Math.max(0, startIndex); i < ordered.length; i += 1) {
          directionalIndexes.push(i)
        }
      } else {
        for (let i = Math.min(ordered.length - 1, startIndex); i >= 0; i -= 1) {
          directionalIndexes.push(i)
        }
      }

      let imageTweetCount = 0
      let videoCount = 0
      for (const index of directionalIndexes) {
        const entry = ordered[index]
        if (!entry || visibleTweetIds.has(entry.tweet.mid)) continue

        if (imageTweetCount < DIRECTIONAL_IMAGE_TWEETS && hasImage(entry.tweet)) {
          preloadTweetIds.add(entry.tweet.mid)
          imageTweetCount += 1
        }

        if (videoCount < DIRECTIONAL_VIDEOS) {
          for (const media of mediaItems(entry.tweet)) {
            if (!isVideoMedia(media)) continue
            preloadVideoIds.add(media.mid)
            videoCount += 1
            if (videoCount >= DIRECTIONAL_VIDEOS) break
          }
        }

        if (imageTweetCount >= DIRECTIONAL_IMAGE_TWEETS && videoCount >= DIRECTIONAL_VIDEOS) {
          break
        }
      }

      const reverseStart = direction === 'down'
        ? (visibleIndexes.length ? Math.min(...visibleIndexes) - 1 : startIndex - 1)
        : (visibleIndexes.length ? Math.max(...visibleIndexes) + 1 : startIndex + 1)

      let reverseCount = 0
      if (direction === 'down') {
        for (let i = reverseStart; i >= 0 && reverseCount < REVERSE_TWEETS; i -= 1) {
          const entry = ordered[i]
          if (!entry || visibleTweetIds.has(entry.tweet.mid)) continue
          preloadTweetIds.add(entry.tweet.mid)
          reverseCount += 1
        }
      } else {
        for (let i = reverseStart; i < ordered.length && reverseCount < REVERSE_TWEETS; i += 1) {
          const entry = ordered[i]
          if (!entry || visibleTweetIds.has(entry.tweet.mid)) continue
          preloadTweetIds.add(entry.tweet.mid)
          reverseCount += 1
        }
      }
    }

    return { visibleTweetIds, preloadTweetIds, preloadVideoIds }
  })

  watch(loadingPlan, (plan) => {
    const visible = [...plan.visibleTweetIds]
    const preloadTweets = [...plan.preloadTweetIds]
    const preloadVideos = [...plan.preloadVideoIds]
    const key = [
      scrollDirection.value,
      visible.join(','),
      preloadTweets.join(','),
      preloadVideos.join(','),
    ].join('|')
    if (key === lastPlanKey) return
    lastPlanKey = key
    debugMediaPlan('plan', {
      direction: scrollDirection.value,
      visibleTweets: visible,
      preloadImageTweets: preloadTweets,
      preloadVideos,
    })
  }, { flush: 'post' })

  function getMediaLoadState(tweetId: string, media: MimeiFileType): MediaLoadState {
    const plan = loadingPlan.value
    if (plan.visibleTweetIds.has(tweetId)) return 'visible'
    if (isImageMedia(media) && plan.preloadTweetIds.has(tweetId)) return 'preload'
    if (isVideoMedia(media) && plan.preloadVideoIds.has(media.mid)) return 'preload'
    return 'idle'
  }

  function setTweetElement(tweet: Tweet, element: Element | null) {
    const existing = entries.get(tweet.mid)
    if (existing && existing.element === element) {
      existing.tweet = tweet
      return
    }

    if (existing && existing.element !== element) {
      observer?.unobserve(existing.element)
      entries.delete(tweet.mid)
    }

    if (element instanceof HTMLElement) {
      const initialVisibility = visibleRatioForElement(element)
      entries.set(tweet.mid, {
        tweet,
        element,
        ratio: initialVisibility.ratio,
        top: initialVisibility.top,
      })
      observer?.observe(element)
    }
    bump()
  }

  function handleScroll() {
    if (scrollFrame != null) return
    scrollFrame = window.requestAnimationFrame(() => {
      scrollFrame = null
      const y = window.scrollY
      if (y !== lastScrollY) {
        scrollDirection.value = y > lastScrollY ? 'down' : 'up'
        lastScrollY = y
      }
      for (const entry of entries.values()) {
        const visibility = visibleRatioForElement(entry.element)
        entry.ratio = visibility.ratio
        entry.top = visibility.top
      }
      bump()
    })
  }

  onMounted(() => {
    observer = new IntersectionObserver((observedEntries) => {
      for (const observed of observedEntries) {
        for (const entry of entries.values()) {
          if (entry.element !== observed.target) continue
          entry.ratio = observed.intersectionRatio
          entry.top = observed.boundingClientRect.top
          break
        }
      }
      bump()
    }, { threshold: [0, 0.01, 0.25, 0.5, 0.75, 1] })

    for (const entry of entries.values()) {
      observer.observe(entry.element)
    }

    window.addEventListener('scroll', handleScroll, { passive: true })
    window.addEventListener('resize', handleScroll, { passive: true })
    handleScroll()
  })

  onBeforeUnmount(() => {
    if (scrollFrame != null) {
      window.cancelAnimationFrame(scrollFrame)
      scrollFrame = null
    }
    window.removeEventListener('scroll', handleScroll)
    window.removeEventListener('resize', handleScroll)
    observer?.disconnect()
    observer = null
    entries.clear()
  })

  return {
    setTweetElement,
    getMediaLoadState,
  }
}
