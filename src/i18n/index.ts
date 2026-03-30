import { createI18n } from 'vue-i18n'
import en from './locales/en.json'
import zhCN from './locales/zh-CN.json'
import ja from './locales/ja.json'

function detectLocale(): string {
    const lang = navigator.language || 'en'
    if (lang.startsWith('zh')) return 'zh-CN'
    if (lang.startsWith('ja')) return 'ja'
    return 'en'
}

const i18n = createI18n({
    legacy: false,
    locale: detectLocale(),
    fallbackLocale: 'en',
    messages: { en, 'zh-CN': zhCN, ja },
})

export default i18n
