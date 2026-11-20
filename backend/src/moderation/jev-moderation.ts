import type { NoulQuestion } from '../ai-gateway/systemone.adapter.js';
import type { NormalizedClassifierInput } from './classifier-input.js';
import type {
  CommentLanguage,
  ModerationCategory,
} from './moderation.constants.js';

/**
 * Moderation through a System One model (Jev, M5-T15a, D24). Jev answers yes/no judgments with
 * calibrated probabilities; the category is decided here in code (truth table below), not by the
 * model. Question wording, criteria and the threshold live only in this file. Any change = bump
 * `JEV_PROMPT_VERSION` (kept apart from the chat prompt's `moderation-v2`, so chat replays stay valid).
 */
export const JEV_PROMPT_VERSION = 'jev-v1';

/** A Noul at or above this reads as yes (TypeSafe's starting point is 0.7 / 0.3; 0.5–0.8 stays below the workspace threshold → review). */
export const JEV_YES = 0.5;

/** Harmful judgment per question id. Object order = tie-break order (first wins). */
const HARMFUL_QUESTIONS = {
  money_offer: 'SCAM_PHISHING',
  asks_secret_code: 'SCAM_PHISHING',
  abusive: 'ABUSIVE_TOXIC',
  other_seller: 'COMPETITOR_POACH',
  unrelated_spam: 'SPAM_IRRELEVANT',
} as const satisfies Record<string, ModerationCategory>;
export type JevQuestionId = keyof typeof HARMFUL_QUESTIONS;

export const JEV_QUESTIONS: Record<JevQuestionId, NoulQuestion> = {
  money_offer: {
    type: 'noul',
    instructions:
      'Does `comment` promise readers free money, cashback, a prize, a bonus, a job or an investment profit?',
    criteria: {
      true: 'The comment offers readers money or a reward they did not buy, for example a bKash or Nagad cashback, a lottery or gift win, a job or an investment return, often with a number or link to claim it.',
      false:
        "The comment asks about or talks about this shop's own products, prices, delivery or how to pay the shop, or promotes something without promising money.",
    },
  },
  asks_secret_code: {
    type: 'noul',
    instructions:
      'Does `comment` ask readers to send a PIN, OTP, password or verification code?',
  },
  abusive: {
    type: 'noul',
    instructions:
      'Does `comment` insult, threaten or harass someone, or use slurs or sexual language?',
    criteria: {
      true: 'Insults, slurs, threats, harassment, sexual content or hate against a person, a group, a religion or the shop, in any language or spelling, including angry, disgusted or insulting emoji-only reactions such as 😡 🤬 👎 🤮 🖕.',
      false:
        'Polite, neutral or positive words or emoji, including a harsh but honest complaint about the product or service without insults.',
    },
  },
  other_seller: {
    type: 'noul',
    instructions:
      "Does `comment` try to send this shop's customers to a different seller of similar products?",
    criteria: {
      true: 'Points readers to another shop, Page, WhatsApp number or link to buy similar goods, for example "our page sells cheaper" or "inbox me for a better price".',
      false:
        "Talks only about this shop's own products, or promotes something that is not a similar product.",
    },
  },
  unrelated_spam: {
    type: 'noul',
    instructions:
      'Is `comment` spam that has nothing to do with shopping at this shop?',
    criteria: {
      true: 'Unrelated promotion such as follow-for-follow, crypto or betting channels or unrelated services, random characters, or a chain message.',
      false:
        'A real customer or follower: a question, order, complaint, review, greeting, a friend tagged, "interested", "inbox please", or a reaction emoji.',
    },
  },
};

/** What Jev reads: named fields that the questions refer to (`comment`). Never the author. */
export function jevState(
  input: NormalizedClassifierInput,
): Record<string, string> {
  return {
    setting: `A public ${input.platform === 'INSTAGRAM' ? 'Instagram' : 'Facebook'} comment ${input.isReply ? 'replying to another comment ' : ''}under a post of a Bangladeshi online shop. Comments are in Bangla, Banglish (Bangla in Latin letters) or English.`,
    comment: input.text,
    ...(input.pageName !== undefined && { shop_page_name: input.pageName }),
    ...(input.postCaption !== undefined && {
      shop_post_caption: input.postCaption,
    }),
  };
}

/**
 * Truth table: the strongest harmful judgment ≥ `JEV_YES` wins (ties → `HARMFUL_QUESTIONS`
 * order), confidence = its probability; none → `SAFE_INQUIRY` with confidence 1 − the strongest.
 * A Noul near the threshold gives a confidence below the workspace threshold (D4) → review.
 */
export function jevDecision(nouls: Readonly<Record<string, number>>): {
  category: ModerationCategory;
  confidence: number;
} {
  let top: { id: JevQuestionId; p: number } | undefined;
  for (const id of Object.keys(HARMFUL_QUESTIONS) as JevQuestionId[]) {
    const p = nouls[id] ?? 0;
    if (!top || p > top.p) top = { id, p };
  }
  const round = (n: number) => Math.round(n * 1000) / 1000;
  if (!top || top.p < JEV_YES) {
    return { category: 'SAFE_INQUIRY', confidence: round(1 - (top?.p ?? 0)) };
  }
  return { category: HARMFUL_QUESTIONS[top.id], confidence: round(top.p) };
}

/** Short machine summary for `reasoning`: the two strongest Nouls (ids + p), never comment text. */
export function jevReasoning(nouls: Readonly<Record<string, number>>): string {
  const top = Object.entries(nouls)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 2)
    .map(([id, p]) => `${id} ${p.toFixed(2)}`);
  return `jev: ${top.join(', ')}`;
}

const BANGLA_SCRIPT = /[ঀ-৿]/u;
/** Common Banglish words (Bangla in Latin letters) that are not English words. */
const BANGLISH_WORDS = new Set(
  'ami amar amra apni apnar apnader tumi tomar tora apu vai bhai bhaiya vaiya koto dam ache ase achen nai nei ki kivabe kibhabe kemon koro koren korben korte kore korlam korsi hobe hoibo dao den deben din dibo diben niben nibo nile nite chai lagbe valo bhalo kharap ekhane ekhon kothay keno jonno theke sathe kintu gula gulo pathan pathao dilam pelam paben pabo jabe jai ekta duita sob shob onek khub rakhben thakle thaka hoy hoyna hoise hoyeche bolen bolben vabi bhabi kotodin moto mal jinish naki amake ektu diyen thaki aro jinis amader ekbar ghure cholche jon korle diye korun'.split(
    ' ',
  ),
);

/**
 * Comment language for the System One path (Jev has no language answer; M5-T15b), pure code, no
 * extra tokens: most words in Bangla script → `bn`; some Bangla script or a common
 * Banglish word → `banglish`; else `en` (emoji-only too). 46/48 on the golden fixture labels.
 * ponytail: word list, so rare Banglish wording reads as `en`; an extra Choice question if it matters.
 */
export function guessCommentLanguage(text: string): CommentLanguage {
  const words = text.toLowerCase().match(/[\p{L}\p{M}]+/gu) ?? [];
  const bangla = words.filter((w) => BANGLA_SCRIPT.test(w)).length;
  if (bangla > 0 && bangla * 2 > words.length) return 'bn';
  return bangla > 0 || words.some((w) => BANGLISH_WORDS.has(w))
    ? 'banglish'
    : 'en';
}
