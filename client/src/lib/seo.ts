import type { Language } from '@/lib/language'

export const SITE_NAME = 'ShieldComment BD'

/** Per-language landing copy for `head()` (docs/design/client.md §4). Crawlers don't run JS, so it's SSR'd. */
const LANDING_META: Record<Language, { title: string; description: string; locale: string; imageAlt: string }> = {
  en: {
    title: 'ShieldComment BD | AI Facebook & Instagram Comment Blocker',
    description:
      'Auto-hide spam, bKash scams & competitor comments on Facebook & Instagram ads in Bangladesh. Supports Bangla, Banglish & English. Pay via bKash, Nagad & Visa.',
    locale: 'en_US',
    imageAlt: 'ShieldComment BD: AI comment moderation for Facebook & Instagram ads',
  },
  bn: {
    title: 'ShieldComment BD | এআই ফেসবুক ও ইনস্টাগ্রাম কমেন্ট ব্লকার',
    description:
      'বাংলাদেশে ফেসবুক ও ইনস্টাগ্রাম অ্যাডের স্প্যাম, বিকাশ স্ক্যাম ও প্রতিযোগীর কমেন্ট অটো-হাইড করুন। বাংলা, বাংলিশ ও ইংরেজি সাপোর্ট। বিকাশ, নগদ ও ভিসায় পেমেন্ট।',
    locale: 'bn_BD',
    imageAlt: 'ShieldComment BD: ফেসবুক ও ইনস্টাগ্রাম অ্যাডের জন্য এআই কমেন্ট মডারেশন',
  },
}

const LANDING_PATH: Record<Language, string> = { en: '/', bn: '/bn' }

/** Link-preview image (1200×630, `client/public/og-image.png`). */
export const OG_IMAGE = { path: '/og-image.png', width: 1200, height: 630 } as const

/** The 6 landing FAQ items: rendered by the FAQ section and sent as `FAQPage` JSON-LD (same text). */
export const LANDING_FAQ: readonly { q: Record<Language, string>; a: Record<Language, string> }[] = [
  {
    q: { en: 'Does it understand Bangla and Banglish?', bn: 'এটি কি বাংলা ও বাংলিশ বোঝে?' },
    a: {
      en: 'Yes. The AI reads Bangla script, Banglish (Bangla in English letters), English and mixes of them, including local scam patterns.',
      bn: 'হ্যাঁ। এআই বাংলা লিপি, বাংলিশ (ইংরেজি অক্ষরে বাংলা), ইংরেজি এবং এগুলোর মিশ্রণ পড়ে, স্থানীয় স্ক্যামের ধরনসহ।',
    },
  },
  {
    q: { en: 'Do you need my Facebook password?', bn: 'আপনাদের কি আমার ফেসবুক পাসওয়ার্ড লাগবে?' },
    a: {
      en: 'No. You connect through the official Meta login and choose which Pages to share. You can disconnect any time.',
      bn: 'না। অফিসিয়াল মেটা লগইনের মাধ্যমে যুক্ত করেন এবং কোন পেজ শেয়ার করবেন তা নিজেই বেছে নেন। যেকোনো সময় বিচ্ছিন্ন করতে পারেন।',
    },
  },
  {
    q: { en: 'What happens to a hidden comment?', bn: 'লুকানো কমেন্টের কী হয়?' },
    a: {
      en: 'Meta hides it from everyone except the person who wrote it and their friends. Nothing is deleted unless you choose that, and you can unhide it from your dashboard.',
      bn: 'মেটা এটি লেখক ও তার বন্ধুদের ছাড়া সবার কাছ থেকে লুকিয়ে রাখে। আপনি না চাইলে কিছু মোছা হয় না, আর ড্যাশবোর্ড থেকে আবার দেখাতে পারেন।',
    },
  },
  {
    q: { en: 'How do I pay?', bn: 'কীভাবে পেমেন্ট করব?' },
    a: {
      en: 'Pay in Taka with bKash, Nagad, Visa or Mastercard through SSLCommerz’s secure checkout. You get an invoice for every payment.',
      bn: 'SSLCommerz-এর নিরাপদ চেকআউটে বিকাশ, নগদ, ভিসা বা মাস্টারকার্ডে টাকায় পেমেন্ট করুন। প্রতিটি পেমেন্টের ইনভয়েস পাবেন।',
    },
  },
  {
    q: { en: 'Can I try it before paying?', bn: 'পেমেন্টের আগে কি চেষ্টা করে দেখতে পারি?' },
    a: {
      en: 'When a free trial is running, its plan card says so. Create an account and start the trial from the Plans page, no payment needed.',
      bn: 'ফ্রি ট্রায়াল চালু থাকলে সেই প্ল্যানের কার্ডে লেখা থাকে। অ্যাকাউন্ট খুলে প্ল্যান পেজ থেকে ট্রায়াল শুরু করুন, কোনো পেমেন্ট লাগবে না।',
    },
  },
  {
    q: { en: 'Do I pay monthly or yearly?', bn: 'মাসিক না বার্ষিক পেমেন্ট?' },
    a: {
      en: 'Either. You pay for a month or a year at a time, and yearly costs less per month. You renew from Billing before the term ends.',
      bn: 'দুটোই পারেন। এক মাস বা এক বছরের জন্য একবারে পেমেন্ট করেন, বার্ষিক প্ল্যানে প্রতি মাসের খরচ কম। মেয়াদ শেষের আগে বিলিং থেকে রিনিউ করেন।',
    },
  },
]

/**
 * title, description, Open Graph + Twitter card, canonical, hreflang alternates and JSON-LD
 * (`SoftwareApplication` + `FAQPage`) for `/` and `/bn`. `lowestPriceBdt` = the cheapest live monthly price;
 * `null` (plans fetch failed or no plans) leaves `offers` out.
 */
export function landingHead(language: Language, origin: string, lowestPriceBdt: number | null = null) {
  const meta = LANDING_META[language]
  const url = `${origin}${LANDING_PATH[language]}`
  const image = `${origin}${OG_IMAGE.path}`
  const app = {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: SITE_NAME,
    applicationCategory: 'BusinessApplication',
    operatingSystem: 'Web',
    description: meta.description,
    url,
    image,
    inLanguage: language,
    ...(lowestPriceBdt === null
      ? {}
      : {
          offers: {
            '@type': 'Offer',
            price: lowestPriceBdt,
            priceCurrency: 'BDT',
            url: `${url}#pricing`,
            priceSpecification: { '@type': 'UnitPriceSpecification', price: lowestPriceBdt, priceCurrency: 'BDT', unitCode: 'MON' },
          },
        }),
  }
  const faq = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    inLanguage: language,
    mainEntity: LANDING_FAQ.map((item) => ({
      '@type': 'Question',
      name: item.q[language],
      acceptedAnswer: { '@type': 'Answer', text: item.a[language] },
    })),
  }
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
      { property: 'og:image', content: image },
      { property: 'og:image:type', content: 'image/png' },
      { property: 'og:image:width', content: String(OG_IMAGE.width) },
      { property: 'og:image:height', content: String(OG_IMAGE.height) },
      { property: 'og:image:alt', content: meta.imageAlt },
      { name: 'twitter:card', content: 'summary_large_image' },
      { name: 'twitter:title', content: meta.title },
      { name: 'twitter:description', content: meta.description },
      { name: 'twitter:image', content: image },
      { name: 'twitter:image:alt', content: meta.imageAlt },
      // TanStack renders these as <script type="application/ld+json"> with the JSON HTML-escaped.
      { 'script:ld+json': app },
      { 'script:ld+json': faq },
    ],
    links: [
      { rel: 'canonical', href: url },
      { rel: 'alternate', hrefLang: 'en', href: `${origin}${LANDING_PATH.en}` },
      { rel: 'alternate', hrefLang: 'bn', href: `${origin}${LANDING_PATH.bn}` },
      { rel: 'alternate', hrefLang: 'x-default', href: `${origin}${LANDING_PATH.en}` },
    ],
  }
}

/** Every app route serves `noindex`; crawlers skip them (and the API). Only `/` + `/bn` are public pages. */
const DISALLOWED_PATHS = [
  '/api/',
  '/analytics',
  '/billing',
  '/comments',
  '/dashboard',
  '/data-deletion',
  '/impersonate',
  '/invite/',
  '/login',
  '/onboarding',
  '/pages',
  '/plans',
  '/playground',
  '/register',
  '/rules',
  '/settings',
  '/support',
]

/** `/robots.txt`: allow everything public, skip the app routes, point at the sitemap. */
export function robotsTxt(origin: string): string {
  return ['User-agent: *', 'Allow: /', ...DISALLOWED_PATHS.map((path) => `Disallow: ${path}`), '', `Sitemap: ${origin}/sitemap.xml`, ''].join('\n')
}

/** `/sitemap.xml`: `/` + `/bn`, each with its hreflang alternates. */
export function sitemapXml(origin: string): string {
  const alternates = (['en', 'bn'] as const)
    .map((lang) => `    <xhtml:link rel="alternate" hreflang="${lang}" href="${origin}${LANDING_PATH[lang]}"/>`)
    .concat(`    <xhtml:link rel="alternate" hreflang="x-default" href="${origin}${LANDING_PATH.en}"/>`)
    .join('\n')
  const urls = (['en', 'bn'] as const).map((lang) => `  <url>\n    <loc>${origin}${LANDING_PATH[lang]}</loc>\n${alternates}\n  </url>`)
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">',
    ...urls,
    '</urlset>',
    '',
  ].join('\n')
}
