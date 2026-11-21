import { Link } from '@tanstack/react-router'
import { ArrowRight, ShieldCheck } from 'lucide-react'
import { LanguagePill } from '@/components/language-pill'
import { LegalLinks } from '@/components/legal/legal-links'
import { useLanguage } from '@/hooks/use-language'
import { formatDhakaDate } from '@/lib/data-deletion'
import { fillFacts, LEGAL_DOCS, LEGAL_FACTS } from '@/lib/legal'
import { PUBLIC_PAGES, type LegalPage as LegalPageId } from '@/lib/seo'

type Text = { en: string; bn: string }

/**
 * `/privacy`, `/terms`, `/refund-policy` and their `/bn/…` twins (M9-T7): public, server-rendered,
 * indexable. Language is fixed by the URL (root `beforeLoad`); facts come from `legal-facts.json`.
 */
export function LegalPage({ page }: { page: LegalPageId }) {
  const { language, content } = useLanguage()
  const doc = LEGAL_DOCS[page]
  const t = (text: Text) => fillFacts(content(text.en, text.bn))
  return (
    <div className="flex min-h-svh flex-col">
      <header className="border-b border-border/60">
        <div className="mx-auto flex h-16 w-full max-w-3xl items-center gap-3 px-4 sm:px-6">
          <Link to={PUBLIC_PAGES.landing[language]} className="flex items-center gap-2 font-semibold">
            <ShieldCheck className="size-6 text-primary" aria-hidden />
            <span>ShieldComment BD</span>
          </Link>
          <div className="ml-auto">
            <LanguagePill page={page} />
          </div>
        </div>
      </header>
      <main className="mx-auto flex w-full max-w-3xl flex-col gap-12 px-4 py-12 sm:px-6">
        <article className="flex flex-col gap-10">
          <header className="flex flex-col gap-3">
            <h1 className="text-3xl font-semibold tracking-tight text-balance sm:text-4xl">{t(doc.title)}</h1>
            <p className="text-sm text-muted-foreground" data-testid="last-updated">
              {content('Last updated: ', 'সর্বশেষ হালনাগাদ: ')}
              <time dateTime={LEGAL_FACTS.lastUpdated}>{formatDhakaDate(LEGAL_FACTS.lastUpdated, language)}</time>
            </p>
            <p className="text-pretty text-muted-foreground">{t(doc.intro)}</p>
          </header>
          {doc.sections.map((section) => (
            <section key={section.id} id={section.id} aria-labelledby={`${section.id}-title`} className="flex scroll-mt-20 flex-col gap-3">
              <h2 id={`${section.id}-title`} className="text-xl font-semibold tracking-tight">
                {t(section.heading)}
              </h2>
              {section.paragraphs?.map((text) => (
                <p key={text.en} className="text-pretty">
                  {t(text)}
                </p>
              ))}
              {section.items && (
                <ul className="flex list-disc flex-col gap-2 pl-5">
                  {section.items.map((text) => (
                    <li key={text.en} className="text-pretty">
                      {t(text)}
                    </li>
                  ))}
                </ul>
              )}
              {section.link && (
                <Link to={section.link.to} search={{ code: undefined }} className="inline-flex items-center gap-1.5 self-start font-medium text-primary underline-offset-4 hover:underline">
                  {t(section.link.label)}
                  <ArrowRight className="size-4" aria-hidden />
                </Link>
              )}
              {section.id === 'contact' && <ContactBlock />}
            </section>
          ))}
        </article>
        <footer className="flex flex-col gap-3 border-t border-border/60 pt-6 text-sm text-muted-foreground">
          <LegalLinks current={page} />
          <span>© ShieldComment BD</span>
        </footer>
      </main>
    </div>
  )
}

function ContactBlock() {
  const { content } = useLanguage()
  const rows = [
    { label: content('Business', 'প্রতিষ্ঠান'), value: LEGAL_FACTS.legalName },
    { label: content('Address', 'ঠিকানা'), value: LEGAL_FACTS.address },
    { label: content('Email', 'ইমেইল'), value: LEGAL_FACTS.email, href: `mailto:${LEGAL_FACTS.email}` },
    { label: content('Phone', 'ফোন'), value: LEGAL_FACTS.phone, href: `tel:${LEGAL_FACTS.phone.replace(/[^\d+]/g, '')}` },
    { label: content('Trade licence no.', 'ট্রেড লাইসেন্স নং'), value: LEGAL_FACTS.tradeLicenceNo },
  ]
  return (
    <address data-testid="legal-contact" className="rounded-2xl bg-muted/50 px-5 py-4 not-italic">
      <dl className="flex flex-col gap-3 text-sm">
        {rows.map((row) => (
          <div key={row.label} className="flex flex-col gap-0.5 sm:flex-row sm:gap-4">
            <dt className="text-muted-foreground sm:w-36 sm:shrink-0">{row.label}</dt>
            <dd className="font-medium break-words">
              {row.href ? (
                <a href={row.href} className="text-primary underline-offset-4 hover:underline">
                  {row.value}
                </a>
              ) : (
                row.value
              )}
            </dd>
          </div>
        ))}
      </dl>
    </address>
  )
}
