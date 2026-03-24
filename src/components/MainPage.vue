<script setup lang='ts'>
import { onMounted, ref, onUnmounted, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { useTweetStore } from '@/stores';
import { TweetView, AppHeader } from '@/views';
import { LoadingSpinner, PageLayout } from '@/components';
import { isWeChatBrowser } from '@/lib';


const { t } = useI18n();

const tweetStore = useTweetStore();
const router = useRouter();
const isLoading = ref(false);
const retryMessage = ref('');
const scrollThreshold = 200; // Distance from bottom to trigger load
const initialLoad = ref(true);
const pageNumber = ref(0);
const pageSize = 10; // Using the same TWEET_COUNT constant from tweetStore
const hasMoreTweets = ref(true); // Flag to track if more tweets are available

// Debounce function (you can also use a library like lodash)
function debounce<T extends Function>(func: T, delay: number) {
    let timeout: any;
    return function(this: any, ...args: any[]) { // Explicitly define 'this' type
        clearTimeout(timeout);
        timeout = setTimeout(() => {
            func.apply(this, args);
        }, delay);
    };
}

async function loadMoreTweets(isManualRetry = false) {
    if (isLoading.value) return; // Prevent multiple loads

    // For automatic loading, stop immediately if no more tweets
    if (!isManualRetry && !hasMoreTweets.value) {
        return;
    }

    isLoading.value = true;

    try {
        const tweetsLoaded = await Promise.race([
            tweetStore.loadTweets(undefined, pageNumber.value, pageSize),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), 6000))
        ]);

        if (tweetsLoaded && tweetsLoaded > 0) {
            if (tweetsLoaded < pageSize) {
                hasMoreTweets.value = false;
            } else {
                hasMoreTweets.value = true;
            }
            pageNumber.value++;
        } else {
            if (!isManualRetry) {
                console.log('No more tweets available from backend.');
                hasMoreTweets.value = false;
            }
        }
    } catch (error) {
        if (error instanceof Error && error.message === 'TIMEOUT') {
            console.log('Scroll load timed out after 6s — will retry on next scroll');
            // Do not stop pagination; user can trigger another scroll to retry
        } else {
            console.error('Error loading more tweets:', error);
            if (!isManualRetry) hasMoreTweets.value = false;
        }
    } finally {
        appendNewToDisplayed();
        isLoading.value = false;
    }
}

const handleScroll = debounce(async () => {
    // Prevent multiple simultaneous loads
    if (isLoading.value) return;
    
    const scrollPosition = window.innerHeight + window.scrollY;
    const documentHeight = document.documentElement.scrollHeight;

    if (documentHeight - scrollPosition < scrollThreshold) {
        // Only load more tweets if we have more tweets available
        if (hasMoreTweets.value) {
            await loadMoreTweets(false); // Automatic loading
        }
    }
}, 300); // Increased debounce delay to reduce conflicts

onMounted(async () => {
    // Guest user: redirect to the default user's profile page
    if (!tweetStore.loginUser) {
        router.replace(`/author/${tweetStore.followings[0]}`);
        return;
    }

    // Only load tweets if we don't have any yet or if this is a fresh session
    const shouldLoad = tweetStore.tweets.length === 0 || initialLoad.value;

    if (sessionStorage['isBot'] != 'No' && isWeChatBrowser()) {
        if (confirm(t('botVerification'))) {
            sessionStorage['isBot'] = 'No'
            if (shouldLoad) {
                await loadTweetsWithMinimum()
            } else {
                appendNewToDisplayed();
            }
        } else {
            history.go(-1)
        }
    } else {
        // For non-WeChat browsers, automatically pass verification
        if (sessionStorage['isBot'] != 'No') {
            sessionStorage['isBot'] = 'No'
        }
        if (shouldLoad) {
            await loadTweetsWithMinimum()
        } else {
            appendNewToDisplayed();
        }
    }
    window.addEventListener('scroll', handleScroll);
});

onUnmounted(() => {
    window.removeEventListener('scroll', handleScroll);
});

async function loadTweetsWithMinimum() {
    if (isLoading.value) return;

    pageNumber.value = 0;
    hasMoreTweets.value = true;

    try {
        await loadMoreTweets();
    } catch (error) {
        console.error('Error in loadTweetsWithMinimum:', error);
    } finally {
        initialLoad.value = false;
    }
}

const displayedTweets = ref<Tweet[]>([]);
const pendingCount = ref(0);

function appendNewToDisplayed() {
    const existingIds = new Set(displayedTweets.value.map(t => t.mid));
    const topTimestamp = displayedTweets.value.length > 0
        ? (displayedTweets.value[0].timestamp as number)
        : Infinity;

    const newTweets = tweetStore.tweets
        .filter(e => {
            if (existingIds.has(e.mid)) return false;
            return !e.isPrivate && (!e.originalTweetId || e.originalTweet !== null);
        })
        .sort((a, b) => (b.timestamp as number) - (a.timestamp as number));

    if (newTweets.length === 0) return;

    const newer = newTweets.filter(t => (t.timestamp as number) > topTimestamp);
    const older = newTweets.filter(t => (t.timestamp as number) <= topTimestamp);
    if (newer.length > 0) displayedTweets.value.unshift(...newer);
    if (older.length > 0) displayedTweets.value.push(...older);
}

function showPendingTweets() {
    appendNewToDisplayed();
    pendingCount.value = 0;
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

// Pick up tweets added/removed in the background (e.g. updateFollowingTweets, deleteTweet)
watch(() => tweetStore.tweets.length, (newLen, oldLen) => {
    // Handle deletions — remove from displayed immediately
    if (newLen < oldLen) {
        const storeIds = new Set(tweetStore.tweets.map(t => t.mid));
        displayedTweets.value = displayedTweets.value.filter(t => storeIds.has(t.mid));
        return;
    }
    // Handle additions — only count as pending, don't auto-insert
    if (initialLoad.value || isLoading.value) return;
    const existingIds = new Set(displayedTweets.value.map(t => t.mid));
    const count = tweetStore.tweets.filter(e =>
        !existingIds.has(e.mid) && !e.isPrivate && (!e.originalTweetId || e.originalTweet !== null)
    ).length;
    pendingCount.value = count;
});
</script>

<template>
    <PageLayout>
        <AppHeader />
        <div v-if="pendingCount > 0" class="new-tweets-banner" @click="showPendingTweets">
            {{ $t('tweet.showNewTweets', pendingCount) }}
        </div>
        <TweetView v-for='tweet in displayedTweets' :tweet='tweet' :key='tweet.mid' />
        <div v-if='isLoading' class='d-flex flex-column align-items-center my-3'>
            <LoadingSpinner />
            <div v-if='retryMessage' class='text-muted mt-2 small'>
                {{ retryMessage }}
            </div>
        </div>
        <div v-else-if='!hasMoreTweets && displayedTweets.length > 0' class='text-center text-muted my-4 small'>
            {{ $t('tweet.noMorePosts') }}
        </div>
    </PageLayout>
</template>

<style scoped>
.new-tweets-banner {
    text-align: center;
    padding: 10px;
    color: #1da1f2;
    cursor: pointer;
    border-bottom: 1px solid #e6ecf0;
    font-size: 14px;
}
.new-tweets-banner:hover {
    background-color: #f5f8fa;
}
</style>