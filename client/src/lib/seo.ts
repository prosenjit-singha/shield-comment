import type { Language } from '@/lib/language'

export const SITE_NAME = 'ShieldComment BD'

/** Per-language landing copy for `head()` (docs/design/client.md §4). Crawlers don't run JS, so it's SSR'd. */
const LANDING_META: Record<Language, { title: string; description: string; locale: string }> = {
  en: {
    title: 'ShieldComment BD | AI Facebook & TikTok Comment Blocker',
    description:
      'Auto-hide spam, bKash scams & competitor comments on Facebook & TikTok ads in Bangladesh. Supports Bangla, Banglish & English. Pay via bKash, Nagad & Visa.',
    locale: 'en_US',
  },
  bn: {
    title: 'ShieldComment BD | এআই ফেসবুক ও টিকটক কমেন্ট ব্লকার',
    description:
      'বাংলাদেশে ফেসবুক ও টিকটক অ্যাডের স্প্যাম, বিকাশ স্ক্যাম ও প্রতিযোগীর কমেন্ট অটো-হাইড করুন। বাংলা, বাংলিশ ও ইংরেজি সাপোর্ট। বিকাশ, নগদ ও ভিসায় পেমেন্ট।',
    locale: 'bn_BD',
  },
}

const LANDING_PATH: Record<Language, string> = { en: '/', bn: '/bn' }

/** title, description, Open Graph, canonical and hreflang alternates for `/` and `/bn`. */
export function landingHead(language: Language, origin: string) {
  const meta = LANDING_META[language]
  const url = `${origin}${LANDING_PATH[language]}`
  return {
    meta: [
      { title: meta.title },
      { name: 'description', content: meta.description },
      { property: 'og:type', content: 'website' },
      { property: 'og:site_name', content: SITE_NAME },
      { property: 'og:title', content: meta.title },
      { property: 'og:description', content: meta.description },
      { property: 'og:url', content: url },
      { property: 'og:locale', content: meta.locale },
      { property: 'og:locale:alternate', content: LANDING_META[language === 'en' ? 'bn' : 'en'].locale },
    ],
    links: [
      { rel: 'canonical', href: url },
      { rel: 'alternate', hrefLang: 'en', href: `${origin}${LANDING_PATH.en}` },
      { rel: 'alternate', hrefLang: 'bn', href: `${origin}${LANDING_PATH.bn}` },
      { rel: 'alternate', hrefLang: 'x-default', href: `${origin}${LANDING_PATH.en}` },
    ],
  }
}
