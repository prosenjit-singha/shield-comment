import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { ArrowRight, ChevronDown, EyeOff, Link2, MessageCircleQuestion, PlugZap, ShieldAlert, ShieldCheck, Sparkles, TrendingUp } from 'lucide-react'
import { useId, useState, type ReactNode } from 'react'
import { FacebookIcon, InstagramIcon } from '@/components/meta/brand-icons'
import { IntervalSwitch, PlanCard } from '@/components/plans/plan-card'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { useLanguage } from '@/hooks/use-language'
import type { SubscriptionInterval } from '@/lib/billing-summary'
import { AD_SPEND, landingPlansQueryOptions, protectedSales, ROAS_ASSUMED, SALES_LOST_PERCENT } from '@/lib/landing'
import { formatNumber, formatTaka, planButtonVariant, type PublicPlan } from '@/lib/plans'
import { cn } from '@/lib/utils'

/**
 * C1 landing for `/` (en) and `/bn` (bn), server-rendered (M8-T12; client.md §3): navbar, hero + comment
 * simulator, trust strip, bento, ROAS calculator, how it works, live pricing, FAQ, footer CTA. Language is
 * fixed by the URL (root `beforeLoad`). Everything works without JS: pricing prints both intervals, the
 * FAQ is native `<details>`, the calculator shows its default.
 */
export function LandingPage() {
  return (
    <div className="flex min-h-svh flex-col pb-20 md:pb-0">
      <Navbar />
      <main className="flex flex-col">
        <Hero />
        <TrustStrip />
        <Bento />
        <RoasCalculator />
        <HowItWorks />
        <Pricing />
        <Faq />
        <FooterCta />
      </main>
      <MobileCtaBar />
    </div>
  )
}

const CTA_CLASS = 'h-11 px-5 text-sm'

function Section({ id, title, eyebrow, intro, children, className }: { id: string; title: string; eyebrow?: string; intro?: string; children: ReactNode; className?: string }) {
  const headingId = `${id}-title`
  return (
    <section id={id} aria-labelledby={headingId} className={cn('scroll-mt-20 px-4 py-16 sm:px-6 sm:py-20', className)}>
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-10">
        <header className="mx-auto flex max-w-2xl flex-col items-center gap-3 text-center">
          {eyebrow ? <p className="text-sm font-medium text-primary">{eyebrow}</p> : null}
          <h2 id={headingId} className="text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
            {title}
          </h2>
          {intro ? <p className="text-pretty text-muted-foreground">{intro}</p> : null}
        </header>
        {children}
      </div>
    </section>
  )
}

/** `EN | বাং` pill: plain links to the fixed language URLs; the click also saves the cookie for the app. */
function LanguagePill() {
  const { language, setLanguage, content } = useLanguage()
  const item = (lang: 'en' | 'bn', to: '/' | '/bn', label: string) => (
    <Link
      to={to}
      hrefLang={lang}
      lang={lang}
      aria-current={language === lang ? 'page' : undefined}
      onClick={() => setLanguage(lang)}
      className={cn(
        'inline-flex h-8 min-w-11 items-center justify-center rounded-full px-3 text-xs font-medium transition-colors',
        language === lang ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
      )}
    >
      {label}
    </Link>
  )
  return (
    <nav aria-label={content('Language', 'ভাষা')} className="flex items-center rounded-full bg-muted p-0.5">
      {item('en', '/', 'EN')}
      {item('bn', '/bn', 'বাং')}
    </nav>
  )
}

function Navbar() {
  const { language, content } = useLanguage()
  const links = [
    { href: '#features', label: content('Features', 'ফিচার') },
    { href: '#how-it-works', label: content('How it works', 'যেভাবে কাজ করে') },
    { href: '#pricing', label: content('Pricing', 'মূল্য') },
  ]
  return (
    <header className="sticky top-0 z-40 border-b border-border/60 bg-background/80 backdrop-blur-md">
      <div className="mx-auto flex h-16 w-full max-w-6xl items-center gap-3 px-4 sm:px-6">
        <Link to={language === 'bn' ? '/bn' : '/'} className="flex items-center gap-2 font-semibold">
          <ShieldCheck className="size-6 text-primary" aria-hidden />
          <span>ShieldComment BD</span>
        </Link>
        <nav aria-label={content('Sections', 'বিভাগ')} className="ml-6 hidden items-center gap-5 text-sm text-muted-foreground lg:flex">
          {links.map((link) => (
            <a key={link.href} href={link.href} className="hover:text-foreground">
              {link.label}
            </a>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <LanguagePill />
          <Button variant="ghost" size="lg" asChild className="hidden sm:inline-flex">
            <Link to="/login">{content('Log in', 'লগ ইন')}</Link>
          </Button>
          <Button size="lg" asChild className="hidden md:inline-flex">
            <Link to="/register">{content('Get started', 'শুরু করুন')}</Link>
          </Button>
        </div>
      </div>
    </header>
  )
}

/** Sample comments for the simulator: what real Page comments look like, the same in both languages. */
const SIMULATED = [
  { author: 'Rafi Ahmed', text: 'Bkash e 500 tk send koren, iPhone free pathabo! Call 01XXXXXXXXX', kind: 'scam' },
  { author: 'Deal Hub BD', text: 'Ekhane dam beshi, amader page e 30% kom 👉 bit.ly/xyz', kind: 'poach' },
  { author: 'Nusrat Jahan', text: 'Apu ei dress ta XL size e ache? Dam koto?', kind: 'buyer' },
] as const

function Hero() {
  const { content } = useLanguage()
  return (
    <section aria-labelledby="hero-title" className="px-4 pt-12 pb-16 sm:px-6 sm:pt-20">
      <div className="mx-auto grid w-full max-w-6xl items-center gap-12 lg:grid-cols-[1.1fr_1fr]">
        <div className="flex flex-col items-start gap-6">
          <p className="inline-flex items-center gap-2 rounded-full bg-muted px-3 py-1 text-xs font-medium text-muted-foreground">
            <Sparkles className="size-3.5 text-primary" aria-hidden />
            {content('AI comment moderation for Bangladesh', 'বাংলাদেশের জন্য এআই কমেন্ট মডারেশন')}
          </p>
          <h1 id="hero-title" className="text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
            {content(
              'Stop losing Facebook & Instagram ad sales to scam comments',
              'স্ক্যাম কমেন্টে ফেসবুক ও ইনস্টাগ্রাম অ্যাডের সেল হারানো বন্ধ করুন',
            )}
          </h1>
          <p className="max-w-xl text-lg text-pretty text-muted-foreground">
            {content(
              'ShieldComment hides bKash/Nagad scams, competitor poaching and abuse on your ads within seconds, and keeps real buyer questions visible. It reads Bangla, Banglish and English.',
              'ShieldComment কয়েক সেকেন্ডের মধ্যে আপনার অ্যাডের বিকাশ/নগদ স্ক্যাম, প্রতিযোগীর কাস্টমার টানা আর গালিগালাজ লুকিয়ে দেয়, আসল ক্রেতার প্রশ্ন রেখে দেয়। বাংলা, বাংলিশ ও ইংরেজি বোঝে।',
            )}
          </p>
          <div className="flex flex-wrap gap-3">
            <Button size="lg" asChild className={CTA_CLASS}>
              <Link to="/register">
                {content('Get started', 'শুরু করুন')}
                <ArrowRight data-icon="inline-end" aria-hidden />
              </Link>
            </Button>
            <Button size="lg" variant="outline" asChild className={CTA_CLASS}>
              <a href="#pricing">{content('See pricing', 'মূল্য দেখুন')}</a>
            </Button>
          </div>
        </div>
        <CommentSimulator />
      </div>
    </section>
  )
}

function CommentSimulator() {
  const { content } = useLanguage()
  const verdict = {
    scam: { label: content('Scam · hidden', 'স্ক্যাম · লুকানো হয়েছে'), tone: 'bg-secondary/10 text-secondary' },
    poach: { label: content('Competitor poaching · hidden', 'কাস্টমার টানা · লুকানো হয়েছে'), tone: 'bg-secondary/10 text-secondary' },
    buyer: { label: content('Buyer question · kept', 'ক্রেতার প্রশ্ন · রাখা হয়েছে'), tone: 'bg-primary/10 text-primary' },
  } as const
  return (
    <Card className="gap-4 rounded-3xl p-5 shadow-lg sm:p-6" aria-label={content('Live comment simulator', 'লাইভ কমেন্ট সিমুলেটর')} role="figure">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span className="flex items-center gap-2 font-medium text-foreground">
          <FacebookIcon className="size-4 text-primary" />
          {content('Your ad · comments', 'আপনার অ্যাড · কমেন্ট')}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-2 rounded-full bg-primary motion-safe:animate-pulse" aria-hidden />
          {content('Live', 'লাইভ')}
        </span>
      </div>
      <ul className="flex flex-col gap-3">
        {SIMULATED.map((comment) => {
          const hidden = comment.kind !== 'buyer'
          return (
            <li key={comment.author} className="flex flex-col gap-2 rounded-2xl bg-muted p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium">{comment.author}</span>
                <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium', verdict[comment.kind].tone)}>
                  {hidden ? <EyeOff className="size-3" aria-hidden /> : <ShieldCheck className="size-3" aria-hidden />}
                  {verdict[comment.kind].label}
                </span>
              </div>
              <p className={cn('text-sm', hidden && 'text-muted-foreground line-through decoration-secondary/60')}>{comment.text}</p>
              {hidden ? null : (
                <p className="ml-4 rounded-2xl bg-primary px-3 py-2 text-sm text-primary-foreground">
                  {content('Auto-reply: Yes, XL is in stock! Check your inbox for the price.', 'অটো-রিপ্লাই: জি আপু, XL আছে! দাম ইনবক্সে পাঠাচ্ছি।')}
                </p>
              )}
            </li>
          )
        })}
      </ul>
    </Card>
  )
}

function TrustStrip() {
  const { content } = useLanguage()
  const pill = 'inline-flex h-9 items-center gap-2 rounded-full border bg-background px-4 text-sm font-medium'
  return (
    <section aria-labelledby="trust-title" className="border-y bg-muted/50 px-4 py-8 sm:px-6">
      <h2 id="trust-title" className="sr-only">
        {content('Platforms and payments', 'প্ল্যাটফর্ম ও পেমেন্ট')}
      </h2>
      <div className="mx-auto flex w-full max-w-6xl flex-col items-center gap-4 text-center lg:flex-row lg:justify-between">
        <div className="flex flex-wrap items-center justify-center gap-2">
          <span className="text-sm text-muted-foreground">{content('Works with', 'যেখানে কাজ করে')}</span>
          <span className={pill}>
            <FacebookIcon className="size-4" />
            Facebook
          </span>
          <span className={pill}>
            <InstagramIcon className="size-4" />
            Instagram
          </span>
        </div>
        <div className="flex flex-wrap items-center justify-center gap-2" data-testid="payment-methods">
          <span className="text-sm text-muted-foreground">{content('Pay with', 'পেমেন্ট করুন')}</span>
          {['bKash', 'Nagad', 'Visa', 'Mastercard'].map((method) => (
            <span key={method} className={pill}>
              {method}
            </span>
          ))}
          <span className="text-xs text-muted-foreground">{content('Secured by SSLCommerz', 'SSLCommerz-এর মাধ্যমে সুরক্ষিত')}</span>
        </div>
      </div>
    </section>
  )
}

function Bento() {
  const { content } = useLanguage()
  const cards = [
    {
      icon: Link2,
      title: content('Competitor poaching', 'প্রতিযোগীর কাস্টমার টানা'),
      body: content(
        'Rival pages drop “cheaper here” links under your paid ads. ShieldComment hides them before your buyers click away.',
        'প্রতিযোগী পেজ আপনার পেইড অ্যাডের নিচে “এখানে কম দাম” লিংক দেয়। ক্রেতা চলে যাওয়ার আগেই ShieldComment সেগুলো লুকিয়ে দেয়।',
      ),
    },
    {
      icon: ShieldAlert,
      title: content('bKash & phishing scams', 'বিকাশ ও ফিশিং স্ক্যাম'),
      body: content(
        'Fake “send money first” offers and phone numbers get hidden in seconds, in Bangla, Banglish or English.',
        '“আগে টাকা পাঠান” ধরনের ভুয়া অফার আর ফোন নম্বর কয়েক সেকেন্ডে লুকানো হয়, বাংলা, বাংলিশ বা ইংরেজি যেভাবেই লেখা হোক।',
      ),
    },
    {
      icon: MessageCircleQuestion,
      title: content('Buried buyer questions', 'চাপা পড়া ক্রেতার প্রশ্ন'),
      body: content(
        'Real “price koto?” questions stay visible and can get an instant reply, so no order is lost in the noise.',
        'আসল “দাম কত?” প্রশ্ন দেখা যায় এবং সাথে সাথে রিপ্লাই পেতে পারে, তাই ভিড়ে কোনো অর্ডার হারায় না।',
      ),
    },
  ]
  return (
    <Section
      id="features"
      eyebrow={content('The problem', 'সমস্যা')}
      title={content('Bad comments cost you real orders', 'খারাপ কমেন্টে আসল অর্ডার হারান')}
      intro={content(
        'Every hour a scam or rival link stays under your ad, buyers lose trust in your page.',
        'আপনার অ্যাডের নিচে স্ক্যাম বা প্রতিযোগীর লিংক যত সময় থাকে, ক্রেতারা তত আপনার পেজের ওপর আস্থা হারান।',
      )}
    >
      <ul className="grid gap-4 md:grid-cols-3">
        {cards.map(({ icon: Icon, title, body }) => (
          <li key={title}>
            <Card className="h-full gap-3 rounded-3xl p-6">
              <span className="flex size-11 items-center justify-center rounded-full bg-primary/10 text-primary">
                <Icon className="size-5" aria-hidden />
              </span>
              <h3 className="text-lg font-semibold">{title}</h3>
              <p className="text-sm text-pretty text-muted-foreground">{body}</p>
            </Card>
          </li>
        ))}
      </ul>
    </Section>
  )
}

function RoasCalculator() {
  const { content, language } = useLanguage()
  const inputId = useId()
  const [spend, setSpend] = useState<number>(AD_SPEND.initial)
  return (
    <Section
      id="roas"
      className="bg-muted/50"
      eyebrow={content('ROAS calculator', 'ROAS ক্যালকুলেটর')}
      title={content('See what clean comments are worth', 'পরিষ্কার কমেন্টের মূল্য দেখুন')}
    >
      <Card className="mx-auto w-full max-w-2xl gap-6 rounded-3xl p-6 sm:p-8">
        <div className="flex flex-col gap-3">
          <label htmlFor={inputId} className="flex items-baseline justify-between gap-3 text-sm font-medium">
            {content('Monthly ad spend', 'মাসিক অ্যাড খরচ')}
            <span className="text-lg font-semibold tabular-nums" data-testid="ad-spend">
              {formatTaka(spend, language)}
            </span>
          </label>
          <input
            id={inputId}
            type="range"
            min={AD_SPEND.min}
            max={AD_SPEND.max}
            step={AD_SPEND.step}
            value={spend}
            onChange={(event) => setSpend(Number(event.target.value))}
            className="h-11 w-full cursor-pointer accent-primary"
          />
          <div className="flex justify-between text-xs text-muted-foreground tabular-nums">
            <span>{formatTaka(AD_SPEND.min, language)}</span>
            <span>{formatTaka(AD_SPEND.max, language)}</span>
          </div>
        </div>
        <div className="flex flex-col gap-1 rounded-2xl bg-primary/10 p-5 text-center" aria-live="polite">
          <p className="text-sm text-muted-foreground">{content('Sales you could protect each month', 'প্রতি মাসে যত সেল রক্ষা করতে পারেন')}</p>
          <p className="text-4xl font-semibold text-primary tabular-nums" data-testid="protected-sales">
            {formatTaka(protectedSales(spend), language)}
          </p>
        </div>
        <p className="text-xs text-pretty text-muted-foreground">
          {content(
            `Estimate: a ${ROAS_ASSUMED}× ROAS, with ${SALES_LOST_PERCENT}% of ad sales lost to scam, poaching and abusive comments.`,
            `আনুমানিক হিসাব: ${formatNumber(ROAS_ASSUMED, 'bn')}× ROAS, যার ${formatNumber(SALES_LOST_PERCENT, 'bn')}% অ্যাড সেল স্ক্যাম, কাস্টমার টানা ও আপত্তিকর কমেন্টে হারায়।`,
          )}
        </p>
      </Card>
    </Section>
  )
}

function HowItWorks() {
  const { content } = useLanguage()
  const steps = [
    {
      icon: PlugZap,
      title: content('Connect your Page', 'পেজ যুক্ত করুন'),
      body: content('Log in with Facebook and pick the Pages and Instagram accounts to protect.', 'ফেসবুক দিয়ে লগ ইন করে কোন পেজ ও ইনস্টাগ্রাম অ্যাকাউন্ট সুরক্ষিত রাখবেন বেছে নিন।'),
    },
    {
      icon: Sparkles,
      title: content('Turn on the Bangla AI', 'বাংলা এআই চালু করুন'),
      body: content('Every new comment is checked in Bangla, Banglish and English, and the bad ones are hidden.', 'প্রতিটি নতুন কমেন্ট বাংলা, বাংলিশ ও ইংরেজিতে যাচাই হয়, খারাপগুলো লুকানো হয়।'),
    },
    {
      icon: TrendingUp,
      title: content('Watch ROAS climb', 'ROAS বাড়তে দেখুন'),
      body: content('Buyers see a clean, trusted comment section and order with confidence.', 'ক্রেতারা পরিষ্কার, বিশ্বস্ত কমেন্ট দেখে নিশ্চিন্তে অর্ডার করেন।'),
    },
  ]
  return (
    <Section id="how-it-works" eyebrow={content('How it works', 'যেভাবে কাজ করে')} title={content('Live in three steps', 'তিন ধাপে চালু')}>
      <ol className="grid gap-4 md:grid-cols-3">
        {steps.map(({ icon: Icon, title, body }, index) => (
          <li key={title}>
            <Card className="h-full gap-3 rounded-3xl p-6">
              <div className="flex items-center gap-3">
                <span className="flex size-11 items-center justify-center rounded-full bg-primary text-primary-foreground">
                  <Icon className="size-5" aria-hidden />
                </span>
                <span className="text-sm font-medium text-muted-foreground">
                  {content(`Step ${index + 1}`, `ধাপ ${formatNumber(index + 1, 'bn')}`)}
                </span>
              </div>
              <h3 className="text-lg font-semibold">{title}</h3>
              <p className="text-sm text-pretty text-muted-foreground">{body}</p>
            </Card>
          </li>
        ))}
      </ol>
    </Section>
  )
}

function Pricing() {
  const { content, language } = useLanguage()
  const [interval, setBillingInterval] = useState<SubscriptionInterval>('month')
  const plans = useQuery(landingPlansQueryOptions)
  const data = plans.data
  const hasYearly = data?.items.some((plan) => plan.yearly !== null) ?? false

  return (
    <Section
      id="pricing"
      eyebrow={content('Pricing', 'মূল্য')}
      title={content('Simple pricing in Taka', 'টাকায় সহজ মূল্য')}
      intro={content('Pay with bKash, Nagad or card. Every plan reads Bangla, Banglish and English.', 'বিকাশ, নগদ বা কার্ডে পেমেন্ট করুন। প্রতিটি প্ল্যান বাংলা, বাংলিশ ও ইংরেজি বোঝে।')}
    >
      {data && data.items.length > 0 ? (
        <>
          {hasYearly ? <IntervalSwitch interval={interval} onChange={setBillingInterval} savePercent={data.yearlySaveUpToPercent} /> : null}
          <ul className="grid gap-4 md:grid-cols-3">
            {data.items.map((plan) => (
              <PlanCard key={plan.id} plan={plan} interval={interval} language={language} titleAs="h3" showOtherInterval>
                <PlanAction plan={plan} interval={plan.yearly && interval === 'year' ? 'year' : 'month'} />
              </PlanCard>
            ))}
          </ul>
        </>
      ) : (
        // Failed (or empty) plans call: the page still renders, sign-up shows every plan (reading 12).
        <div data-testid="pricing-fallback" className="mx-auto flex max-w-md flex-col items-center gap-4 rounded-3xl border bg-card px-6 py-8 text-center">
          <p className="text-sm text-muted-foreground">
            {content('Create a free account to see every plan and today’s prices.', 'সব প্ল্যান ও আজকের দাম দেখতে ফ্রি অ্যাকাউন্ট খুলুন।')}
          </p>
          <Button size="lg" asChild className={CTA_CLASS}>
            <Link to="/register">{content('See plans', 'প্ল্যান দেখুন')}</Link>
          </Button>
        </div>
      )}
    </Section>
  )
}

/** D11: a live trial → `/register` (trial by choice on `/plans`), else "Choose <plan>" → sign-up then checkout. */
function PlanAction({ plan, interval }: { plan: PublicPlan; interval: SubscriptionInterval }) {
  const { content } = useLanguage()
  const variant = planButtonVariant(plan)
  if (plan.trial)
    return (
      <div className="flex flex-col gap-1.5">
        <Button asChild variant={variant} size="lg" className={cn(CTA_CLASS, 'w-full')}>
          <Link to="/register">
            {content(`Start free ${plan.trial.days}-day trial`, `${formatNumber(plan.trial.days, 'bn')} দিনের ফ্রি ট্রায়াল শুরু করুন`)}
          </Link>
        </Button>
        <p className="text-center text-xs text-muted-foreground">
          {content(
            `${formatNumber(plan.trial.commentLimit, 'en')} comments included. No payment needed.`,
            `${formatNumber(plan.trial.commentLimit, 'bn')}টি কমেন্ট সহ। কোনো পেমেন্ট লাগবে না।`,
          )}
        </p>
      </div>
    )
  return (
    <Button asChild variant={variant} size="lg" className={cn(CTA_CLASS, 'w-full')}>
      <Link to="/register" search={{ plan: plan.slug, interval }}>
        {content(`Choose ${plan.name}`, `${plan.name} বেছে নিন`)}
      </Link>
    </Button>
  )
}

function Faq() {
  const { content } = useLanguage()
  const items = [
    {
      q: content('Does it understand Bangla and Banglish?', 'এটি কি বাংলা ও বাংলিশ বোঝে?'),
      a: content(
        'Yes. The AI reads Bangla script, Banglish (Bangla in English letters), English and mixes of them, including local scam patterns.',
        'হ্যাঁ। এআই বাংলা লিপি, বাংলিশ (ইংরেজি অক্ষরে বাংলা), ইংরেজি এবং এগুলোর মিশ্রণ পড়ে, স্থানীয় স্ক্যামের ধরনসহ।',
      ),
    },
    {
      q: content('Do you need my Facebook password?', 'আপনাদের কি আমার ফেসবুক পাসওয়ার্ড লাগবে?'),
      a: content(
        'No. You connect through the official Meta login and choose which Pages to share. You can disconnect any time.',
        'না। অফিসিয়াল মেটা লগইনের মাধ্যমে যুক্ত করেন এবং কোন পেজ শেয়ার করবেন তা নিজেই বেছে নেন। যেকোনো সময় বিচ্ছিন্ন করতে পারেন।',
      ),
    },
    {
      q: content('What happens to a hidden comment?', 'লুকানো কমেন্টের কী হয়?'),
      a: content(
        'Meta hides it from everyone except the person who wrote it and their friends. Nothing is deleted unless you choose that, and you can unhide it from your dashboard.',
        'মেটা এটি লেখক ও তার বন্ধুদের ছাড়া সবার কাছ থেকে লুকিয়ে রাখে। আপনি না চাইলে কিছু মোছা হয় না, আর ড্যাশবোর্ড থেকে আবার দেখাতে পারেন।',
      ),
    },
    {
      q: content('How do I pay?', 'কীভাবে পেমেন্ট করব?'),
      a: content(
        'Pay in Taka with bKash, Nagad, Visa or Mastercard through SSLCommerz’s secure checkout. You get an invoice for every payment.',
        'SSLCommerz-এর নিরাপদ চেকআউটে বিকাশ, নগদ, ভিসা বা মাস্টারকার্ডে টাকায় পেমেন্ট করুন। প্রতিটি পেমেন্টের ইনভয়েস পাবেন।',
      ),
    },
    {
      q: content('Can I try it before paying?', 'পেমেন্টের আগে কি চেষ্টা করে দেখতে পারি?'),
      a: content(
        'When a free trial is running, its plan card says so. Create an account and start the trial from the Plans page, no payment needed.',
        'ফ্রি ট্রায়াল চালু থাকলে সেই প্ল্যানের কার্ডে লেখা থাকে। অ্যাকাউন্ট খুলে প্ল্যান পেজ থেকে ট্রায়াল শুরু করুন, কোনো পেমেন্ট লাগবে না।',
      ),
    },
    {
      q: content('Do I pay monthly or yearly?', 'মাসিক না বার্ষিক পেমেন্ট?'),
      a: content(
        'Either. You pay for a month or a year at a time, and yearly costs less per month. You renew from Billing before the term ends.',
        'দুটোই পারেন। এক মাস বা এক বছরের জন্য একবারে পেমেন্ট করেন, বার্ষিক প্ল্যানে প্রতি মাসের খরচ কম। মেয়াদ শেষের আগে বিলিং থেকে রিনিউ করেন।',
      ),
    },
  ]
  return (
    <Section id="faq" eyebrow={content('FAQ', 'প্রশ্নোত্তর')} title={content('Questions, answered', 'আপনার প্রশ্নের উত্তর')}>
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-3">
        {items.map((item) => (
          <details key={item.q} className="group rounded-2xl border bg-card px-5 py-1 open:pb-4">
            <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-4 py-3 font-medium [&::-webkit-details-marker]:hidden">
              <h3 className="text-base">{item.q}</h3>
              <ChevronDown className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" aria-hidden />
            </summary>
            <p className="text-sm text-pretty text-muted-foreground">{item.a}</p>
          </details>
        ))}
      </div>
    </Section>
  )
}

function FooterCta() {
  const { content } = useLanguage()
  return (
    <section aria-labelledby="cta-title" className="px-4 pb-10 sm:px-6">
      <div className="relative mx-auto flex w-full max-w-6xl flex-col items-center gap-6 overflow-hidden rounded-3xl bg-foreground px-6 py-16 text-center text-background">
        <div className="pointer-events-none absolute -top-24 -left-24 size-72 rounded-full bg-primary/40 blur-3xl" aria-hidden />
        <div className="pointer-events-none absolute -right-24 -bottom-24 size-72 rounded-full bg-accent/30 blur-3xl" aria-hidden />
        <h2 id="cta-title" className="relative max-w-2xl text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
          {content('Protect your next ad before the scammers find it', 'স্ক্যামাররা খুঁজে পাওয়ার আগেই পরের অ্যাড সুরক্ষিত করুন')}
        </h2>
        <p className="relative max-w-xl text-pretty opacity-80">
          {content('Connect your Page in a few minutes. Bangla, Banglish and English from day one.', 'কয়েক মিনিটে পেজ যুক্ত করুন। প্রথম দিন থেকেই বাংলা, বাংলিশ ও ইংরেজি।')}
        </p>
        <Button size="lg" asChild className={cn(CTA_CLASS, 'relative')}>
          <Link to="/register">
            {content('Get started', 'শুরু করুন')}
            <ArrowRight data-icon="inline-end" aria-hidden />
          </Link>
        </Button>
      </div>
      <footer className="mx-auto mt-8 flex w-full max-w-6xl flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground">
        <span>© ShieldComment BD</span>
        <Link to="/login" className="hover:text-foreground">
          {content('Log in', 'লগ ইন')}
        </Link>
      </footer>
    </section>
  )
}

/** < 768px: sticky frosted CTA bar (client.md §2). */
function MobileCtaBar() {
  const { content } = useLanguage()
  return (
    <div className="fixed inset-x-0 bottom-0 z-40 border-t border-border/60 bg-background/80 p-3 backdrop-blur-md md:hidden">
      <Button size="lg" asChild className={cn(CTA_CLASS, 'w-full')}>
        <Link to="/register">{content('Get started', 'শুরু করুন')}</Link>
      </Button>
    </div>
  )
}
