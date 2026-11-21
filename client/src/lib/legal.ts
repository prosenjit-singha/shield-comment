import type { Language } from '@/lib/language'
import facts from '@/lib/legal-facts.json'
import type { LegalPage } from '@/lib/seo'

/**
 * Legal pages copy (M9-T7, D11 a): drafted by the agent from what the code does, reviewed by the user
 * before launch. Business facts (name, address, contact, trade licence, refund window, last-updated date)
 * live in `legal-facts.json` so they change without touching this file; its `[TODO: …]` placeholders must
 * be replaced before go-live (M9-GATE). `{key}` in the text is filled from that file.
 */
export const LEGAL_FACTS: Readonly<Record<keyof typeof facts, string>> = facts

type Text = Record<Language, string>

export interface LegalSection {
  id: string
  heading: Text
  paragraphs?: Text[]
  items?: Text[]
  link?: { to: '/data-deletion'; label: Text }
}

export interface LegalDoc {
  title: Text
  description: Text
  intro: Text
  sections: LegalSection[]
}

/** Replaces `{key}` with the matching `legal-facts.json` value (unknown keys stay as written). */
export function fillFacts(text: string): string {
  return text.replace(/\{(\w+)\}/g, (match, key: string) => (key in LEGAL_FACTS ? LEGAL_FACTS[key as keyof typeof facts] : match))
}

const contactSection: LegalSection = {
  id: 'contact',
  heading: { en: 'Contact us', bn: 'যোগাযোগ' },
  paragraphs: [
    {
      en: 'Questions about this page, your data or a payment? Write to us using the details below.',
      bn: 'এই পেজ, আপনার ডেটা বা কোনো পেমেন্ট নিয়ে প্রশ্ন আছে? নিচের ঠিকানায় আমাদের লিখুন।',
    },
  ],
}

const privacy: LegalDoc = {
  title: { en: 'Privacy Policy', bn: 'প্রাইভেসি পলিসি' },
  description: {
    en: 'What data ShieldComment BD collects from your account, Facebook and Instagram Pages and payments, why, how long we keep it and how to delete it.',
    bn: 'ShieldComment BD আপনার অ্যাকাউন্ট, ফেসবুক ও ইনস্টাগ্রাম পেজ এবং পেমেন্ট থেকে কী ডেটা নেয়, কেন, কতদিন রাখে এবং কীভাবে মুছবেন।',
  },
  intro: {
    en: 'ShieldComment BD hides scam, abusive and competitor comments on the Facebook and Instagram Pages of businesses in Bangladesh. This policy explains what data we collect when you use our website and app, why we need it, who we share it with, how long we keep it and the choices you have.',
    bn: 'ShieldComment BD বাংলাদেশের ব্যবসার ফেসবুক ও ইনস্টাগ্রাম পেজের স্ক্যাম, গালিগালাজ ও প্রতিযোগীর কমেন্ট লুকিয়ে রাখে। আমাদের ওয়েবসাইট ও অ্যাপ ব্যবহারের সময় আমরা কী ডেটা নিই, কেন নিই, কার সাথে শেয়ার করি, কতদিন রাখি এবং আপনার কী কী বিকল্প আছে, তা এই পলিসিতে বলা হয়েছে।',
  },
  sections: [
    {
      id: 'who-we-are',
      heading: { en: 'Who we are', bn: 'আমরা কারা' },
      paragraphs: [
        {
          en: 'ShieldComment BD is run by {legalName}. Our contact details are at the end of this page.',
          bn: 'ShieldComment BD পরিচালনা করে {legalName}। আমাদের যোগাযোগের ঠিকানা এই পেজের শেষে আছে।',
        },
      ],
    },
    {
      id: 'what-we-collect',
      heading: { en: 'What we collect', bn: 'আমরা কী তথ্য নিই' },
      items: [
        {
          en: 'Account data: your name, email address and business (workspace) name. Your password is stored only as a secure hash. For team members you invite: their email address and role.',
          bn: 'অ্যাকাউন্টের তথ্য: আপনার নাম, ইমেইল ঠিকানা ও ব্যবসার (ওয়ার্কস্পেস) নাম। পাসওয়ার্ড শুধু নিরাপদ হ্যাশ হিসেবে রাখা হয়। আপনি যাদের টিমে আমন্ত্রণ জানান: তাদের ইমেইল ঠিকানা ও ভূমিকা।',
        },
        {
          en: 'Facebook and Instagram data, when you connect through the official Meta login: your Facebook user ID, the Pages and Instagram business accounts you choose to share (names and IDs) and the access tokens Meta gives us. Tokens are stored encrypted.',
          bn: 'ফেসবুক ও ইনস্টাগ্রামের তথ্য, যখন আপনি অফিসিয়াল মেটা লগইন দিয়ে যুক্ত করেন: আপনার ফেসবুক ইউজার আইডি, আপনি যে পেজ ও ইনস্টাগ্রাম বিজনেস অ্যাকাউন্ট শেয়ার করেন (নাম ও আইডি) এবং মেটা আমাদের যে অ্যাক্সেস টোকেন দেয়। টোকেন এনক্রিপ্ট করে রাখা হয়।',
        },
        {
          en: 'Comments on your connected Pages: the comment text, comment and post IDs, the commenter’s name and ID as Meta sends them, the time, and what we did with the comment (kept, hidden, deleted or replied to). If you choose a higher AI analysis level, also the Page name or the post caption.',
          bn: 'যুক্ত পেজের কমেন্ট: কমেন্টের লেখা, কমেন্ট ও পোস্টের আইডি, মেটা যেভাবে পাঠায় সেভাবে কমেন্টকারীর নাম ও আইডি, সময় এবং কমেন্টটির সাথে আমরা কী করেছি (রাখা, লুকানো, মোছা বা রিপ্লাই)। আপনি উচ্চতর এআই বিশ্লেষণ লেভেল বেছে নিলে পেজের নাম বা পোস্টের ক্যাপশনও।',
        },
        {
          en: 'Billing data: your plan, amounts paid, invoice numbers and the payment reference SSLCommerz returns (transaction ID and payment method type). We never see or store your full card number or your bKash or Nagad PIN.',
          bn: 'বিলিংয়ের তথ্য: আপনার প্ল্যান, পরিশোধিত টাকা, ইনভয়েস নম্বর এবং SSLCommerz যে পেমেন্ট রেফারেন্স দেয় (ট্রানজেকশন আইডি ও পেমেন্ট মাধ্যমের ধরন)। আপনার পুরো কার্ড নম্বর বা বিকাশ/নগদের পিন আমরা কখনো দেখি না, রাখিও না।',
        },
        {
          en: 'Support and alerts: the messages and screenshots you send to support, your alert settings and, if you link one, your Telegram chat.',
          bn: 'সাপোর্ট ও অ্যালার্ট: সাপোর্টে পাঠানো মেসেজ ও স্ক্রিনশট, আপনার অ্যালার্ট সেটিংস এবং লিংক করলে আপনার টেলিগ্রাম চ্যাট।',
        },
        {
          en: 'Technical data: your IP address and browser details, used for sign-in security and rate limits.',
          bn: 'কারিগরি তথ্য: আপনার আইপি ঠিকানা ও ব্রাউজারের তথ্য, যা সাইন-ইন নিরাপত্তা ও রেট লিমিটের জন্য ব্যবহার হয়।',
        },
      ],
    },
    {
      id: 'how-we-use',
      heading: { en: 'How we use it', bn: 'কীভাবে ব্যবহার করি' },
      items: [
        {
          en: 'To run the service: receive new comments from Meta, check them, and hide, delete or reply to them according to your settings.',
          bn: 'সেবা চালাতে: মেটা থেকে নতুন কমেন্ট নেওয়া, যাচাই করা এবং আপনার সেটিংস অনুযায়ী লুকানো, মোছা বা রিপ্লাই দেওয়া।',
        },
        {
          en: 'To manage your account, team, plan and payments, and to send service emails (email verification, password reset, invitations, alerts).',
          bn: 'আপনার অ্যাকাউন্ট, টিম, প্ল্যান ও পেমেন্ট পরিচালনা এবং সেবা-সংক্রান্ত ইমেইল পাঠাতে (ইমেইল যাচাই, পাসওয়ার্ড রিসেট, আমন্ত্রণ, অ্যালার্ট)।',
        },
        {
          en: 'To keep the service secure, prevent abuse and answer your support requests.',
          bn: 'সেবা নিরাপদ রাখতে, অপব্যবহার ঠেকাতে এবং আপনার সাপোর্ট অনুরোধের উত্তর দিতে।',
        },
      ],
      paragraphs: [
        {
          en: 'We do not sell your data and do not use it for advertising.',
          bn: 'আমরা আপনার ডেটা বিক্রি করি না এবং বিজ্ঞাপনের কাজে ব্যবহার করি না।',
        },
      ],
    },
    {
      id: 'ai',
      heading: { en: 'How the AI check works', bn: 'এআই যাচাই কীভাবে কাজ করে' },
      paragraphs: [
        {
          en: 'To decide whether a comment is a scam, abuse or competitor poaching, we send the comment text (and, if you turned it on, the Page name or post caption) to an AI model through Neon’s AI Gateway. Only the text needed for the decision is sent. We keep the result (category, confidence and a short reason), not the AI provider’s full response.',
          bn: 'কোনো কমেন্ট স্ক্যাম, গালিগালাজ নাকি প্রতিযোগীর কাস্টমার টানার চেষ্টা, তা বুঝতে আমরা কমেন্টের লেখা (আর আপনি চালু করলে পেজের নাম বা পোস্টের ক্যাপশন) Neon-এর এআই গেটওয়ের মাধ্যমে একটি এআই মডেলে পাঠাই। সিদ্ধান্তের জন্য যতটুকু লেখা দরকার শুধু ততটুকুই পাঠানো হয়। আমরা ফলাফল (ক্যাটাগরি, নিশ্চয়তার মাত্রা ও ছোট কারণ) রাখি, এআই প্রোভাইডারের পুরো উত্তর রাখি না।',
        },
      ],
    },
    {
      id: 'sharing',
      heading: { en: 'Who we share it with', bn: 'কার সাথে শেয়ার করি' },
      paragraphs: [
        {
          en: 'We share data only with the service providers we need to run ShieldComment BD, and only for that purpose:',
          bn: 'ShieldComment BD চালাতে যেসব সেবাদাতা দরকার, শুধু তাদের সাথে এবং শুধু সেই কাজের জন্য ডেটা শেয়ার করি:',
        },
      ],
      items: [
        {
          en: 'Meta (Facebook and Instagram): to read comments on your Pages and hide, delete or reply to them.',
          bn: 'মেটা (ফেসবুক ও ইনস্টাগ্রাম): আপনার পেজের কমেন্ট পড়া এবং লুকানো, মোছা বা রিপ্লাই দেওয়ার জন্য।',
        },
        {
          en: 'Neon: database hosting and the AI Gateway that runs the comment check.',
          bn: 'Neon: ডেটাবেস হোস্টিং এবং কমেন্ট যাচাইয়ের এআই গেটওয়ে।',
        },
        {
          en: 'Our hosting and queue providers (Fly.io and Redis Cloud), which run our servers in Singapore.',
          bn: 'আমাদের হোস্টিং ও কিউ সেবাদাতা (Fly.io ও Redis Cloud), যারা সিঙ্গাপুরে আমাদের সার্ভার চালায়।',
        },
        {
          en: 'Resend: to send our emails.',
          bn: 'Resend: আমাদের ইমেইল পাঠানোর জন্য।',
        },
        {
          en: 'SSLCommerz: to take payments by card, bKash, Nagad and other methods.',
          bn: 'SSLCommerz: কার্ড, বিকাশ, নগদ ও অন্যান্য মাধ্যমে পেমেন্ট নেওয়ার জন্য।',
        },
        {
          en: 'Telegram: only if you link a Telegram chat for alerts.',
          bn: 'টেলিগ্রাম: শুধু যদি আপনি অ্যালার্টের জন্য টেলিগ্রাম চ্যাট লিংক করেন।',
        },
      ],
    },
    {
      id: 'retention',
      heading: { en: 'How long we keep it', bn: 'কতদিন রাখি' },
      items: [
        {
          en: 'The raw data Meta sends us for each comment is deleted automatically after 30 days.',
          bn: 'প্রতিটি কমেন্টের জন্য মেটা যে মূল (raw) ডেটা পাঠায়, তা ৩০ দিন পর স্বয়ংক্রিয়ভাবে মুছে যায়।',
        },
        {
          en: 'Comments and their check results stay while your account is active, so you can review them, until you ask us to delete them.',
          bn: 'কমেন্ট ও তার যাচাইয়ের ফলাফল আপনার অ্যাকাউন্ট চালু থাকা পর্যন্ত থাকে, যাতে আপনি দেখতে পারেন, যতক্ষণ না আপনি মুছতে বলেন।',
        },
        {
          en: 'Daily comment counts per Page are kept for your reports. They contain no personal data.',
          bn: 'রিপোর্টের জন্য প্রতিটি পেজের দৈনিক কমেন্ট সংখ্যা রাখা হয়। এতে কোনো ব্যক্তিগত তথ্য নেই।',
        },
        {
          en: 'Payment records and invoices are kept for our accounts.',
          bn: 'পেমেন্টের রেকর্ড ও ইনভয়েস আমাদের হিসাবের জন্য রাখা হয়।',
        },
      ],
    },
    {
      id: 'data-deletion',
      heading: { en: 'Deleting your data', bn: 'আপনার ডেটা মুছে ফেলা' },
      paragraphs: [
        {
          en: 'Remove ShieldComment BD from Facebook (Settings & privacy → Settings → Apps and websites → Remove). Facebook tells us, and we delete your Facebook connection, its Pages and their comments. Facebook shows you a confirmation code; you can check the status of the request on our Data deletion page.',
          bn: 'ফেসবুক থেকে ShieldComment BD রিমুভ করুন (সেটিংস ও গোপনীয়তা → সেটিংস → অ্যাপ ও ওয়েবসাইট → রিমুভ)। ফেসবুক আমাদের জানায়, আর আমরা আপনার ফেসবুক কানেকশন, এর পেজগুলো ও সেগুলোর কমেন্ট মুছে ফেলি। ফেসবুক আপনাকে একটি কনফার্মেশন কোড দেখায়; অনুরোধের অবস্থা আমাদের ডেটা মুছে ফেলার পেজে দেখতে পারেন।',
        },
        {
          en: 'You can also disconnect Facebook in the app at any time. This removes the tokens and Pages; comments already checked stay until you ask us to delete them. To delete your whole account, email us.',
          bn: 'অ্যাপ থেকেও যেকোনো সময় ফেসবুক বিচ্ছিন্ন করতে পারেন। এতে টোকেন ও পেজ মুছে যায়; আগে যাচাই করা কমেন্ট থেকে যায়, যতক্ষণ না আপনি মুছতে বলেন। পুরো অ্যাকাউন্ট মুছতে আমাদের ইমেইল করুন।',
        },
      ],
      link: { to: '/data-deletion', label: { en: 'Data deletion status', bn: 'ডেটা মুছে ফেলার অবস্থা' } },
    },
    {
      id: 'cookies',
      heading: { en: 'Cookies and browser storage', bn: 'কুকি ও ব্রাউজার স্টোরেজ' },
      paragraphs: [
        {
          en: 'We use a sign-in cookie that scripts can’t read (httpOnly), a cookie that remembers your language, and browser storage for your theme and a pending team invitation. We use no advertising or tracking cookies.',
          bn: 'আমরা একটি সাইন-ইন কুকি (httpOnly, স্ক্রিপ্ট পড়তে পারে না), ভাষা মনে রাখার একটি কুকি এবং থিম ও অপেক্ষমাণ টিম আমন্ত্রণের জন্য ব্রাউজার স্টোরেজ ব্যবহার করি। কোনো বিজ্ঞাপন বা ট্র্যাকিং কুকি ব্যবহার করি না।',
        },
      ],
    },
    {
      id: 'security',
      heading: { en: 'Security', bn: 'নিরাপত্তা' },
      paragraphs: [
        {
          en: 'Connections use HTTPS, Meta tokens and AI keys are stored encrypted, passwords are hashed, sign-in attempts are rate-limited, and each team member sees only the workspaces they belong to.',
          bn: 'সংযোগ HTTPS-এ হয়, মেটা টোকেন ও এআই কী এনক্রিপ্ট করে রাখা হয়, পাসওয়ার্ড হ্যাশ করা থাকে, সাইন-ইনের চেষ্টা সীমিত করা হয় এবং টিমের প্রত্যেকে শুধু নিজের ওয়ার্কস্পেস দেখতে পান।',
        },
      ],
    },
    {
      id: 'your-rights',
      heading: { en: 'Your choices', bn: 'আপনার অধিকার' },
      paragraphs: [
        {
          en: 'You can see and change your account details in the app, and ask us for a copy of your data, to correct it or to delete it. Email us and we will reply.',
          bn: 'অ্যাপে আপনার অ্যাকাউন্টের তথ্য দেখতে ও বদলাতে পারেন, এবং আপনার ডেটার কপি চাইতে, ঠিক করতে বা মুছতে বলতে পারেন। আমাদের ইমেইল করুন, আমরা উত্তর দেব।',
        },
        {
          en: 'ShieldComment BD is a service for businesses and is not meant for children under 18.',
          bn: 'ShieldComment BD ব্যবসার জন্য একটি সেবা, ১৮ বছরের কম বয়সীদের জন্য নয়।',
        },
      ],
    },
    {
      id: 'changes',
      heading: { en: 'Changes to this policy', bn: 'এই পলিসির পরিবর্তন' },
      paragraphs: [
        {
          en: 'When we change this policy, we update the date at the top of this page.',
          bn: 'এই পলিসি বদলালে আমরা এই পেজের উপরের তারিখটি হালনাগাদ করি।',
        },
      ],
    },
    contactSection,
  ],
}

const terms: LegalDoc = {
  title: { en: 'Terms of Service', bn: 'সেবার শর্তাবলি' },
  description: {
    en: 'The terms for using ShieldComment BD: your account, connecting Facebook and Instagram Pages, plans and payments in Taka, acceptable use and liability.',
    bn: 'ShieldComment BD ব্যবহারের শর্ত: আপনার অ্যাকাউন্ট, ফেসবুক ও ইনস্টাগ্রাম পেজ যুক্ত করা, টাকায় প্ল্যান ও পেমেন্ট, গ্রহণযোগ্য ব্যবহার ও দায়।',
  },
  intro: {
    en: 'These terms are an agreement between you and {legalName}, which runs ShieldComment BD. By creating an account or using the service you accept them. Please read them together with our Privacy Policy and Refund Policy.',
    bn: 'এই শর্তাবলি আপনার এবং ShieldComment BD পরিচালনাকারী {legalName}-এর মধ্যে একটি চুক্তি। অ্যাকাউন্ট খুলে বা সেবা ব্যবহার করে আপনি এগুলো মেনে নিচ্ছেন। আমাদের প্রাইভেসি পলিসি ও রিফান্ড পলিসির সাথে মিলিয়ে পড়ুন।',
  },
  sections: [
    {
      id: 'service',
      heading: { en: 'The service', bn: 'সেবা' },
      paragraphs: [
        {
          en: 'ShieldComment BD checks comments on the Facebook and Instagram Pages you connect and hides, deletes or replies to them according to your settings. The AI check is good but not perfect: it can miss a bad comment or hide a good one. You can review every decision and unhide a comment from your dashboard.',
          bn: 'ShieldComment BD আপনার যুক্ত করা ফেসবুক ও ইনস্টাগ্রাম পেজের কমেন্ট যাচাই করে এবং আপনার সেটিংস অনুযায়ী লুকায়, মোছে বা রিপ্লাই দেয়। এআই যাচাই ভালো, তবে নিখুঁত নয়: কোনো খারাপ কমেন্ট বাদ পড়তে পারে বা ভালো কমেন্ট লুকিয়ে যেতে পারে। ড্যাশবোর্ড থেকে প্রতিটি সিদ্ধান্ত দেখতে এবং কমেন্ট আবার দেখাতে পারেন।',
        },
      ],
    },
    {
      id: 'account',
      heading: { en: 'Your account', bn: 'আপনার অ্যাকাউন্ট' },
      items: [
        {
          en: 'Give correct details and keep your password safe. You are responsible for what happens in your account and for the team members you invite.',
          bn: 'সঠিক তথ্য দিন এবং পাসওয়ার্ড নিরাপদ রাখুন। আপনার অ্যাকাউন্টে যা ঘটে এবং আপনার আমন্ত্রিত টিম সদস্যদের দায় আপনার।',
        },
        {
          en: 'You must be at least 18 and allowed to act for the business you register.',
          bn: 'আপনার বয়স কমপক্ষে ১৮ হতে হবে এবং যে ব্যবসার নামে নিবন্ধন করছেন তার পক্ষে কাজ করার অনুমতি থাকতে হবে।',
        },
      ],
    },
    {
      id: 'meta',
      heading: { en: 'Connecting Facebook and Instagram', bn: 'ফেসবুক ও ইনস্টাগ্রাম যুক্ত করা' },
      items: [
        {
          en: 'Connect only Pages and Instagram accounts you manage. By connecting them you allow us to read their comments and to hide, delete or reply to comments as your settings say.',
          bn: 'শুধু আপনার পরিচালিত পেজ ও ইনস্টাগ্রাম অ্যাকাউন্ট যুক্ত করুন। যুক্ত করার মাধ্যমে আপনি আমাদের সেগুলোর কমেন্ট পড়তে এবং আপনার সেটিংস অনুযায়ী লুকাতে, মুছতে বা রিপ্লাই দিতে অনুমতি দিচ্ছেন।',
        },
        {
          en: 'Meta’s own terms also apply. If Meta changes or limits its services, parts of ShieldComment BD may stop working until we can adapt.',
          bn: 'মেটার নিজস্ব শর্তাবলিও প্রযোজ্য। মেটা তাদের সেবা বদলালে বা সীমিত করলে, আমরা মানিয়ে নেওয়া পর্যন্ত ShieldComment BD-র কিছু অংশ কাজ নাও করতে পারে।',
        },
      ],
    },
    {
      id: 'plans',
      heading: { en: 'Plans and payments', bn: 'প্ল্যান ও পেমেন্ট' },
      items: [
        {
          en: 'Prices are in Bangladeshi Taka (৳) and include VAT. You pay for a month or a year in advance through SSLCommerz.',
          bn: 'দাম বাংলাদেশি টাকায় (৳) এবং ভ্যাটসহ। আপনি SSLCommerz-এর মাধ্যমে এক মাস বা এক বছরের জন্য আগাম পেমেন্ট করেন।',
        },
        {
          en: 'Plans do not renew automatically and we never charge you without your action. Renew from Billing before your term ends.',
          bn: 'প্ল্যান স্বয়ংক্রিয়ভাবে রিনিউ হয় না এবং আপনার পদক্ষেপ ছাড়া আমরা কখনো টাকা কাটি না। মেয়াদ শেষের আগে বিলিং থেকে রিনিউ করুন।',
        },
        {
          en: 'Each plan has limits (comments checked per month, Pages, team seats, workspaces) shown on the plan card. Free trials and discounts apply as shown when you choose a plan.',
          bn: 'প্রতিটি প্ল্যানের সীমা (মাসে যাচাই করা কমেন্ট, পেজ, টিম সিট, ওয়ার্কস্পেস) প্ল্যান কার্ডে দেখানো থাকে। প্ল্যান বেছে নেওয়ার সময় যেভাবে দেখানো হয়, সেভাবে ফ্রি ট্রায়াল ও ছাড় প্রযোজ্য।',
        },
        {
          en: 'When a term ends unpaid, comment checking pauses. Your comments stay visible on Facebook and Instagram and nothing is deleted.',
          bn: 'পেমেন্ট ছাড়া মেয়াদ শেষ হলে কমেন্ট যাচাই বন্ধ থাকে। আপনার কমেন্ট ফেসবুক ও ইনস্টাগ্রামে দেখা যেতে থাকে এবং কিছুই মোছা হয় না।',
        },
        {
          en: 'Refunds follow our Refund Policy.',
          bn: 'রিফান্ড আমাদের রিফান্ড পলিসি অনুযায়ী হয়।',
        },
      ],
    },
    {
      id: 'acceptable-use',
      heading: { en: 'Acceptable use', bn: 'গ্রহণযোগ্য ব্যবহার' },
      items: [
        {
          en: 'Don’t use the service for anything illegal or to silence lawful criticism by deception.',
          bn: 'বেআইনি কোনো কাজে বা প্রতারণার মাধ্যমে বৈধ সমালোচনা চাপা দিতে সেবাটি ব্যবহার করবেন না।',
        },
        {
          en: 'Don’t try to break, overload or get around the limits or security of the service, or to access other customers’ data.',
          bn: 'সেবার সীমা বা নিরাপত্তা ভাঙা, অতিরিক্ত চাপ দেওয়া বা এড়ানোর চেষ্টা করবেন না, অন্য গ্রাহকের ডেটায় ঢোকার চেষ্টাও নয়।',
        },
      ],
      paragraphs: [
        {
          en: 'We may suspend a workspace that breaks these terms. We will tell you why.',
          bn: 'এই শর্ত ভাঙলে আমরা কোনো ওয়ার্কস্পেস স্থগিত করতে পারি। কেন করছি তা আপনাকে জানাব।',
        },
      ],
    },
    {
      id: 'your-content',
      heading: { en: 'Your content', bn: 'আপনার কনটেন্ট' },
      paragraphs: [
        {
          en: 'Your Pages, comments and settings remain yours. We use them only to provide the service, as our Privacy Policy describes.',
          bn: 'আপনার পেজ, কমেন্ট ও সেটিংস আপনারই থাকে। আমরা শুধু সেবা দেওয়ার জন্য এগুলো ব্যবহার করি, যেভাবে আমাদের প্রাইভেসি পলিসিতে বলা আছে।',
        },
      ],
    },
    {
      id: 'liability',
      heading: { en: 'Availability and liability', bn: 'সেবার প্রাপ্যতা ও দায়' },
      paragraphs: [
        {
          en: 'We work to keep ShieldComment BD running, but we provide it “as is” and can’t promise it will never be interrupted. As far as the law allows, we are not liable for indirect losses, such as lost sales from a missed or wrongly hidden comment, and our total liability is limited to the amount you paid us in the 12 months before the claim.',
          bn: 'আমরা ShieldComment BD চালু রাখতে কাজ করি, তবে সেবাটি “যেমন আছে” সেভাবে দেওয়া হয় এবং কখনো বিঘ্ন ঘটবে না, এমন নিশ্চয়তা দিতে পারি না। আইন যতটুকু অনুমতি দেয়, পরোক্ষ ক্ষতির (যেমন বাদ পড়া বা ভুলে লুকানো কমেন্টের কারণে বিক্রি হারানো) দায় আমাদের নয়, এবং আমাদের মোট দায় দাবির আগের ১২ মাসে আপনি আমাদের যা পরিশোধ করেছেন তার মধ্যে সীমিত।',
        },
      ],
    },
    {
      id: 'ending',
      heading: { en: 'Ending the service', bn: 'সেবা বন্ধ করা' },
      paragraphs: [
        {
          en: 'You can stop at any time: disconnect Facebook in the app and don’t renew. To delete your account and data, email us or follow the steps in our Privacy Policy.',
          bn: 'যেকোনো সময় বন্ধ করতে পারেন: অ্যাপ থেকে ফেসবুক বিচ্ছিন্ন করুন এবং রিনিউ করবেন না। অ্যাকাউন্ট ও ডেটা মুছতে আমাদের ইমেইল করুন বা প্রাইভেসি পলিসির ধাপগুলো অনুসরণ করুন।',
        },
      ],
    },
    {
      id: 'law',
      heading: { en: 'Changes and governing law', bn: 'পরিবর্তন ও প্রযোজ্য আইন' },
      paragraphs: [
        {
          en: 'When we change these terms, we update the date at the top of this page; using the service after that means you accept the new terms. These terms are governed by the laws of Bangladesh.',
          bn: 'এই শর্তাবলি বদলালে আমরা এই পেজের উপরের তারিখ হালনাগাদ করি; এরপর সেবা ব্যবহার করলে আপনি নতুন শর্ত মেনে নিচ্ছেন। এই শর্তাবলি বাংলাদেশের আইন অনুযায়ী পরিচালিত।',
        },
      ],
    },
    contactSection,
  ],
}

const refund: LegalDoc = {
  title: { en: 'Refund Policy', bn: 'রিফান্ড পলিসি' },
  description: {
    en: 'When and how ShieldComment BD refunds payments made in Taka through SSLCommerz (card, bKash, Nagad), and how to ask for one.',
    bn: 'SSLCommerz-এর মাধ্যমে টাকায় করা পেমেন্ট (কার্ড, বিকাশ, নগদ) ShieldComment BD কখন ও কীভাবে ফেরত দেয় এবং কীভাবে চাইবেন।',
  },
  intro: {
    en: 'Prices are in Taka (৳), include VAT and are paid in advance for a month or a year through SSLCommerz. Plans never renew or charge you automatically, and you can try ShieldComment BD with a free trial whenever one is offered on the plan card.',
    bn: 'দাম টাকায় (৳), ভ্যাটসহ, এবং SSLCommerz-এর মাধ্যমে এক মাস বা এক বছরের জন্য আগাম পরিশোধ করা হয়। প্ল্যান কখনো স্বয়ংক্রিয়ভাবে রিনিউ হয় না বা টাকা কাটে না, আর প্ল্যান কার্ডে ফ্রি ট্রায়াল থাকলে তা দিয়ে ShieldComment BD চেষ্টা করে দেখতে পারেন।',
  },
  sections: [
    {
      id: 'eligibility',
      heading: { en: 'When you can get a refund', bn: 'কখন রিফান্ড পাবেন' },
      items: [
        {
          en: 'You were charged twice, or you paid and the plan was not activated: we refund the extra payment in full.',
          bn: 'দুবার টাকা কাটা হয়েছে, অথবা পেমেন্ট করেছেন কিন্তু প্ল্যান চালু হয়নি: বাড়তি পেমেন্ট পুরোটা ফেরত দিই।',
        },
        {
          en: 'Any other reason: ask within {refundWindowDays} days of the payment. We review each request and tell you our decision.',
          bn: 'অন্য যেকোনো কারণ: পেমেন্টের {refundWindowDays} দিনের মধ্যে অনুরোধ করুন। আমরা প্রতিটি অনুরোধ যাচাই করে সিদ্ধান্ত জানাই।',
        },
      ],
    },
    {
      id: 'how-to-ask',
      heading: { en: 'How to ask', bn: 'কীভাবে চাইবেন' },
      paragraphs: [
        {
          en: 'Email us from your account’s email address with the invoice number (for example SC-2026-00012, shown under Billing → Invoices), your workspace name and the reason.',
          bn: 'অ্যাকাউন্টের ইমেইল ঠিকানা থেকে আমাদের ইমেইল করুন: ইনভয়েস নম্বর (যেমন SC-2026-00012, বিলিং → ইনভয়েসে দেখা যায়), আপনার ওয়ার্কস্পেসের নাম ও কারণ লিখুন।',
        },
      ],
    },
    {
      id: 'how-paid',
      heading: { en: 'How refunds are paid', bn: 'রিফান্ড কীভাবে দেওয়া হয়' },
      items: [
        {
          en: 'We refund through SSLCommerz to the method you paid with (card, bKash, Nagad or other). How long it takes to reach you depends on your bank or mobile wallet.',
          bn: 'যে মাধ্যমে পেমেন্ট করেছেন (কার্ড, বিকাশ, নগদ বা অন্য), SSLCommerz-এর মাধ্যমে সেখানেই ফেরত দিই। আপনার কাছে পৌঁছাতে কত সময় লাগবে তা আপনার ব্যাংক বা মোবাইল ওয়ালেটের ওপর নির্ভর করে।',
        },
        {
          en: 'We refund the amount you actually paid, after any discount or coupon.',
          bn: 'ছাড় বা কুপনের পর আপনি আসলে যত টাকা পরিশোধ করেছেন, ততটাই ফেরত দিই।',
        },
        {
          en: 'A refund does not end your plan by itself. We tell you in our reply whether the refunded term stays active.',
          bn: 'রিফান্ড নিজে থেকে আপনার প্ল্যান বন্ধ করে না। রিফান্ড করা মেয়াদ চালু থাকবে কি না, তা আমাদের উত্তরে জানাই।',
        },
      ],
    },
    contactSection,
  ],
}

export const LEGAL_DOCS: Record<LegalPage, LegalDoc> = { privacy, terms, refund }
