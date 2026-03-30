<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { marked } from 'marked'
import leitherSetupNoticeEn from '@/content/leither-setup-notice.en.md?raw'
import leitherSetupNoticeZh from '@/content/leither-setup-notice.zh.md?raw'

const { locale } = useI18n()

function parseMarkdownNotice(raw: string): { title: string; htmlBody: string } {
  const normalized = raw.replace(/\r\n/g, '\n').trimStart()
  const h1Match = normalized.match(/^#\s+(.+?)\s*$/m)
  if (!h1Match) {
    return { title: 'Notice', htmlBody: marked.parse(normalized) as string }
  }

  const title = h1Match[1].trim()
  const blockStart = normalized.indexOf(h1Match[0])
  const afterHeading = normalized.slice(blockStart + h1Match[0].length).replace(/^\n+/, '')
  return { title, htmlBody: marked.parse(afterHeading) as string }
}

const notice = computed(() => {
  const isChinese = locale.value?.toLowerCase().startsWith('zh')
  const raw = isChinese ? leitherSetupNoticeZh : leitherSetupNoticeEn
  return parseMarkdownNotice(raw)
})
</script>

<template>
  <div class="setup-notice-page">
    <div class="setup-notice-card">
      <h1>{{ notice.title }}</h1>
      <div class="setup-notice-body" v-html="notice.htmlBody"></div>
    </div>
  </div>
</template>

<style scoped>
.setup-notice-page {
  background: #f7fafc;
  min-height: 100%;
  padding: 24px;
}

.setup-notice-card {
  max-width: 760px;
  margin: 0 auto;
  background: #ffffff;
  border: 1px solid #e5e7eb;
  border-radius: 12px;
  padding: 24px;
  box-shadow: 0 8px 20px rgba(0, 0, 0, 0.06);
  color: #1f2937;
  line-height: 1.6;
}

h1 {
  margin-top: 0;
  font-size: 1.35rem;
}

.setup-notice-body :deep(p) {
  margin: 0 0 1em;
}

.setup-notice-body :deep(p:last-child) {
  margin-bottom: 0;
}

.setup-notice-body :deep(ul),
.setup-notice-body :deep(ol) {
  margin: 0 0 1em;
  padding-left: 1.6em;
}
</style>
