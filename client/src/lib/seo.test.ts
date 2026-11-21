import { describe, expect, it } from 'vitest'
import { LANDING_FAQ, landingHead, legalHead, robotsTxt, sitemapXml } from '@/lib/seo'

const ORIGIN = 'https://app.example.com'

type Meta = ReturnType<typeof landingHead>['meta'][number]
const content = (meta: Meta[], key: string) =>
  meta.find((m) => ('property' in m && m.property === key) || ('name' in m && m.name === key))?.['content' as keyof Meta]
/** The JSON-LD blocks as the browser would read them back from the HTML. */
const jsonLd = (meta: Meta[]) =>
  meta.flatMap((m) => ('script:ld+json' in m ? [JSON.parse(JSON.stringify(m['script:ld+json'])) as Record<string, unknown>] : []))

const copy = {
  en: { url: `${ORIGIN}/`, title: 'ShieldComment BD | AI Facebook & Instagram Comment Blocker', faq0: 'Does it understand Bangla and Banglish?', alt: /Facebook & Instagram/ },
  bn: { url: `${ORIGIN}/bn`, title: 'ShieldComment BD | এআই ফেসবুক ও ইনস্টাগ্রাম কমেন্ট ব্লকার', faq0: 'এটি কি বাংলা ও বাংলিশ বোঝে?', alt: /ফেসবুক ও ইনস্টাগ্রাম/ },
} as const

describe.each(['en', 'bn'] as const)('landingHead (%s)', (language) => {
  const t = copy[language]

  it('title + description name Facebook & Instagram, never TikTok', () => {
    const { meta } = landingHead(language, ORIGIN, 499)
    expect(meta[0]).toEqual({ title: t.title })
    expect(JSON.stringify(meta)).not.toMatch(/tiktok|টিকটক/i)
    expect(t.title.length).toBeLessThanOrEqual(60)
    expect(String(content(meta, 'description')).length).toBeLessThanOrEqual(160)
  })

  it('og:image + twitter large card with absolute URLs', () => {
    const { meta } = landingHead(language, ORIGIN, 499)
    expect(content(meta, 'og:image')).toBe(`${ORIGIN}/og-image.png`)
    expect(content(meta, 'og:image:width')).toBe('1200')
    expect(content(meta, 'og:image:height')).toBe('630')
    expect(content(meta, 'og:image:alt')).toMatch(t.alt)
    expect(content(meta, 'twitter:card')).toBe('summary_large_image')
    expect(content(meta, 'twitter:image')).toBe(`${ORIGIN}/og-image.png`)
    expect(content(meta, 'twitter:title')).toBe(t.title)
  })

  it('canonical + hreflang alternates', () => {
    const { links } = landingHead(language, ORIGIN, 499)
    expect(links).toContainEqual({ rel: 'canonical', href: t.url })
    expect(links.filter((l) => l.rel === 'alternate').map((l) => [l.hrefLang, l.href])).toEqual([
      ['en', `${ORIGIN}/`],
      ['bn', `${ORIGIN}/bn`],
      ['x-default', `${ORIGIN}/`],
    ])
  })

  it('JSON-LD: SoftwareApplication with the lowest price in BDT + FAQPage with the 6 items', () => {
    const [app, faq] = jsonLd(landingHead(language, ORIGIN, 499).meta)
    expect(app).toMatchObject({
      '@context': 'https://schema.org',
      '@type': 'SoftwareApplication',
      name: 'ShieldComment BD',
      applicationCategory: 'BusinessApplication',
      operatingSystem: 'Web',
      url: t.url,
      offers: { '@type': 'Offer', price: 499, priceCurrency: 'BDT', url: `${t.url}#pricing` },
    })
    expect(faq?.['@type']).toBe('FAQPage')
    const questions = faq?.mainEntity as { name: string; acceptedAnswer: { text: string } }[]
    expect(questions).toHaveLength(6)
    expect(questions[0]?.name).toBe(t.faq0)
    expect(questions.map((q) => [q.name, q.acceptedAnswer.text])).toEqual(LANDING_FAQ.map((item) => [item.q[language], item.a[language]]))
  })

  it('JSON-LD has no offers when the plans fetch failed', () => {
    const [app] = jsonLd(landingHead(language, ORIGIN, null).meta)
    expect(app?.['@type']).toBe('SoftwareApplication')
    expect(app).not.toHaveProperty('offers')
  })
})

describe('robots.txt + sitemap.xml', () => {
  it('robots allows the site, disallows the noindex app routes, points at the sitemap', () => {
    const lines = robotsTxt(ORIGIN).split('\n')
    expect(lines.slice(0, 2)).toEqual(['User-agent: *', 'Allow: /'])
    for (const path of ['/api/', '/dashboard', '/billing', '/plans', '/login', '/register', '/settings', '/forgot-password', '/reset-password', '/verify-email']) expect(lines).toContain(`Disallow: ${path}`)
    expect(lines).not.toContain('Disallow: /')
    expect(lines).not.toContain('Disallow: /bn')
    expect(lines).toContain(`Sitemap: ${ORIGIN}/sitemap.xml`)
  })

  it('robots does not disallow the legal pages (M9-T7)', () => {
    const disallowed = robotsTxt(ORIGIN)
      .split('\n')
      .filter((line) => line.startsWith('Disallow: '))
      .map((line) => line.slice('Disallow: '.length))
    for (const path of ['/privacy', '/terms', '/refund-policy', '/bn/privacy', '/bn/terms', '/bn/refund-policy']) {
      expect(disallowed.some((prefix) => path.startsWith(prefix))).toBe(false)
    }
  })

  it('sitemap lists the landing + legal pages (en + bn) with hreflang alternates', () => {
    const xml = sitemapXml(ORIGIN)
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true)
    expect(xml).toContain('xmlns:xhtml="http://www.w3.org/1999/xhtml"')
    expect([...xml.matchAll(/<loc>(.+?)<\/loc>/g)].map((m) => m[1])).toEqual(
      ['/', '/bn', '/privacy', '/bn/privacy', '/terms', '/bn/terms', '/refund-policy', '/bn/refund-policy'].map((path) => `${ORIGIN}${path}`),
    )
    expect(xml.match(/<xhtml:link rel="alternate" hreflang="bn" href="https:\/\/app\.example\.com\/bn"\/>/g)).toHaveLength(2)
    expect(xml.match(/hreflang="x-default" href="https:\/\/app\.example\.com\/"/g)).toHaveLength(2)
    expect(xml.match(/hreflang="bn" href="https:\/\/app\.example\.com\/bn\/refund-policy"\/>/g)).toHaveLength(2)
    expect(xml.match(/hreflang="x-default" href="https:\/\/app\.example\.com\/privacy"\/>/g)).toHaveLength(2)
  })
})

describe('legalHead (M9-T7)', () => {
  it.each([
    ['privacy', 'en', 'Privacy Policy | ShieldComment BD', '/privacy', '/bn/privacy'],
    ['terms', 'bn', 'সেবার শর্তাবলি | ShieldComment BD', '/terms', '/bn/terms'],
    ['refund', 'en', 'Refund Policy | ShieldComment BD', '/refund-policy', '/bn/refund-policy'],
    ['refund', 'bn', 'রিফান্ড পলিসি | ShieldComment BD', '/refund-policy', '/bn/refund-policy'],
  ] as const)('%s (%s): title, description, canonical + hreflang, no noindex', (page, language, title, en, bn) => {
    const { meta, links } = legalHead(page, language, ORIGIN)
    expect(meta[0]).toEqual({ title })
    const description = String(content(meta as unknown as Meta[], 'description'))
    expect(description.length).toBeGreaterThan(50)
    expect(description.length).toBeLessThanOrEqual(160)
    expect(JSON.stringify(meta)).not.toMatch(/noindex/)
    expect(links).toEqual([
      { rel: 'canonical', href: `${ORIGIN}${language === 'bn' ? bn : en}` },
      { rel: 'alternate', hrefLang: 'en', href: `${ORIGIN}${en}` },
      { rel: 'alternate', hrefLang: 'bn', href: `${ORIGIN}${bn}` },
      { rel: 'alternate', hrefLang: 'x-default', href: `${ORIGIN}${en}` },
    ])
  })
})
