import type { ApiError } from '@/lib/api'
import type { ContentFn } from '@/lib/auth-errors'
import { bnNumber } from '@/lib/language'
import type {
  MetaDisconnectResponse,
  MetaOAuthErrorReason,
  MetaReturnSearch,
  PageToggleFailure,
} from '@/lib/meta-pages'

/**
 * Bilingual copy for the Meta connect flow and the Pages API (M3-T10; reused by `/pages` in M3-T11).
 * Backend `message` text is never shown as-is.
 */

export type NoticeTone = 'success' | 'info' | 'warning' | 'error'

export interface MetaNotice {
  tone: NoticeTone
  /** Stable id for tests / `data-kind`, e.g. `connected`, `skipped`, `error:access_denied`. */
  kind: string
  text: string
}

function oauthReasonText(reason: MetaOAuthErrorReason | undefined, content: ContentFn): string {
  switch (reason) {
    case 'access_denied':
      return content(
        'You cancelled the Facebook window, so nothing was connected. Try again when you’re ready.',
        'আপনি ফেসবুকের উইন্ডোটি বাতিল করেছেন, তাই কিছু কানেক্ট হয়নি। প্রস্তুত হলে আবার চেষ্টা করুন।',
      )
    case 'invalid_state':
      return content(
        'The connection link expired or was already used. Start again.',
        'কানেকশন লিংকের মেয়াদ শেষ হয়ে গেছে বা এটি আগেই ব্যবহার করা হয়েছে। আবার শুরু করুন।',
      )
    case 'unauthenticated':
      return content(
        'You were logged out while connecting. Try again now that you’re logged in.',
        'কানেক্ট করার সময় আপনি লগ আউট হয়ে গিয়েছিলেন। এখন লগ ইন অবস্থায় আবার চেষ্টা করুন।',
      )
    case 'state_mismatch':
      return content(
        'The connection was started from another account or workspace. Start again from this page.',
        'কানেকশনটি অন্য অ্যাকাউন্ট বা ওয়ার্কস্পেস থেকে শুরু হয়েছিল। এই পেজ থেকে আবার শুরু করুন।',
      )
    case 'impersonation_blocked':
      return content(
        'Facebook can’t be connected during Admin Impersonation. The workspace owner has to connect it.',
        'অ্যাডমিন ইমপারসোনেশনের সময় ফেসবুক কানেক্ট করা যায় না। ওয়ার্কস্পেসের মালিককে এটি কানেক্ট করতে হবে।',
      )
    case 'forbidden':
      return content(
        'Only workspace owners and admins can connect Facebook, and the workspace must be active.',
        'শুধু ওয়ার্কস্পেসের মালিক ও অ্যাডমিন ফেসবুক কানেক্ট করতে পারেন, এবং ওয়ার্কস্পেসটি সক্রিয় থাকতে হবে।',
      )
    case 'missing_code':
      return content(
        'Facebook didn’t finish the connection. Try again.',
        'ফেসবুক কানেকশনটি সম্পূর্ণ করেনি। আবার চেষ্টা করুন।',
      )
    case 'not_configured':
      return content(
        'Facebook connection isn’t set up on our server yet. Please contact support.',
        'আমাদের সার্ভারে ফেসবুক কানেকশন এখনো সেট আপ করা হয়নি। অনুগ্রহ করে সাপোর্টে যোগাযোগ করুন।',
      )
    case 'meta_unavailable':
      return content(
        'Facebook is busy or unreachable right now. Try again in a few minutes.',
        'ফেসবুক এই মুহূর্তে ব্যস্ত বা পাওয়া যাচ্ছে না। কয়েক মিনিট পরে আবার চেষ্টা করুন।',
      )
    case 'meta_error':
      return content(
        'Facebook refused the connection. Try again and allow every permission it asks for.',
        'ফেসবুক কানেকশনটি গ্রহণ করেনি। আবার চেষ্টা করুন এবং চাওয়া সব অনুমতি দিন।',
      )
    case 'server_error':
      return content(
        'Something went wrong on our side while saving the connection. Try again.',
        'কানেকশন সেভ করার সময় আমাদের দিকে একটি সমস্যা হয়েছে। আবার চেষ্টা করুন।',
      )
    case undefined:
      return content('The connection didn’t finish. Try again.', 'কানেকশনটি সম্পূর্ণ হয়নি। আবার চেষ্টা করুন।')
  }
}

/** What to show after the OAuth callback brought the user back (`?meta=…`). Empty = nothing. */
export function metaReturnNotices(search: MetaReturnSearch, content: ContentFn): MetaNotice[] {
  if (search.meta === 'error') {
    return [
      {
        tone: 'error',
        kind: `error:${search.reason ?? 'unknown'}`,
        text: `${content('Facebook wasn’t connected.', 'ফেসবুক কানেক্ট হয়নি।')} ${oauthReasonText(search.reason, content)}`,
      },
    ]
  }
  if (search.meta !== 'connected') return []
  const notices: MetaNotice[] = [
    {
      tone: 'success',
      kind: 'connected',
      text: content(
        'Facebook connected. Switch on protection for the Pages you want below.',
        'ফেসবুক কানেক্ট হয়েছে। নিচে যে পেজগুলো সুরক্ষিত রাখতে চান সেগুলো চালু করুন।',
      ),
    },
  ]
  if (search.skipped) {
    const n = search.skipped
    notices.push({
      tone: 'warning',
      kind: 'skipped',
      text: content(
        `${n} ${n === 1 ? 'Page was' : 'Pages were'} skipped because ${n === 1 ? 'it is' : 'they are'} already connected to another ShieldComment workspace.`,
        `${bnNumber(n)}টি পেজ বাদ দেওয়া হয়েছে, কারণ সেগুলো আগে থেকেই অন্য একটি ShieldComment ওয়ার্কস্পেসে কানেক্ট করা আছে।`,
      ),
    })
  }
  return notices
}

function genericFailure(error: ApiError, content: ContentFn): string {
  if (error.isNetwork) {
    return content(
      'Can’t reach the server. Check your connection and try again.',
      'সার্ভারে সংযোগ করা যাচ্ছে না। ইন্টারনেট সংযোগ দেখে আবার চেষ্টা করুন।',
    )
  }
  if (error.status === 401) {
    return content('Your session has ended. Log in again.', 'আপনার সেশন শেষ হয়ে গেছে। আবার লগ ইন করুন।')
  }
  if (error.status >= 500) {
    return content(
      'The server is unavailable right now. Try again shortly.',
      'সার্ভার এই মুহূর্তে পাওয়া যাচ্ছে না। একটু পরে আবার চেষ্টা করুন।',
    )
  }
  return content(
    `Something went wrong (${error.status}). Try again.`,
    `কিছু একটা সমস্যা হয়েছে (${error.status})। আবার চেষ্টা করুন।`,
  )
}

/** `GET …/meta/oauth/url` failures (the "Continue with Facebook" button). */
export function connectErrorMessage(error: ApiError, content: ContentFn): string {
  switch (error.status) {
    case 503:
      return oauthReasonText('not_configured', content)
    case 409:
      return content(
        'This workspace isn’t the one you’re currently using. Reload the page and try again.',
        'এই ওয়ার্কস্পেসটি আপনার বর্তমানে ব্যবহৃত ওয়ার্কস্পেস নয়। পেজটি রিলোড করে আবার চেষ্টা করুন।',
      )
    case 403:
      return content(
        'You don’t have permission to connect Facebook. Only workspace owners and admins can.',
        'ফেসবুক কানেক্ট করার অনুমতি আপনার নেই। শুধু ওয়ার্কস্পেসের মালিক ও অ্যাডমিন পারেন।',
      )
    default:
      return genericFailure(error, content)
  }
}

/** D5: impersonated sessions get 403 on connect, so the button is replaced by this. */
export function impersonationConnectNotice(content: ContentFn): string {
  return content(
    'Connecting Facebook is turned off during Admin Impersonation, so an admin’s own Facebook account is never linked to this workspace. Ask the owner to connect it. You can still switch protection on or off for Pages that are already connected.',
    'অ্যাডমিন ইমপারসোনেশনের সময় ফেসবুক কানেক্ট করা বন্ধ থাকে, যাতে অ্যাডমিনের নিজের ফেসবুক অ্যাকাউন্ট কখনো এই ওয়ার্কস্পেসে যুক্ত না হয়। মালিককে কানেক্ট করতে বলুন। আগে থেকে কানেক্ট করা পেজের সুরক্ষা আপনি চালু বা বন্ধ করতে পারবেন।',
  )
}

/** `GET …/pages` failures. */
export function pagesLoadErrorMessage(error: ApiError, content: ContentFn): string {
  if (error.status === 403) {
    return content(
      'Only workspace owners and admins can manage Pages.',
      'শুধু ওয়ার্কস্পেসের মালিক ও অ্যাডমিন পেজ ম্যানেজ করতে পারেন।',
    )
  }
  if (error.status === 404) {
    return content('This workspace couldn’t be found.', 'এই ওয়ার্কস্পেসটি খুঁজে পাওয়া যায়নি।')
  }
  return `${content('Couldn’t load your Pages.', 'আপনার পেজগুলো লোড করা যায়নি।')} ${genericFailure(error, content)}`
}

/** A Page without a stored token (`hasToken: false`, or the toggle's 409 `PAGE_TOKEN_MISSING`). */
export function pageNeedsReconnectMessage(content: ContentFn): string {
  return content(
    'Facebook no longer gives us access to this Page. Reconnect Facebook and include this Page, then switch it on.',
    'ফেসবুক এই পেজে আর অ্যাক্সেস দিচ্ছে না। ফেসবুক আবার কানেক্ট করুন এবং এই পেজটি সিলেক্ট করুন, তারপর চালু করুন।',
  )
}

/** `PATCH …/pages/:id/toggle` failures, incl. the 409 plan-limit / missing-token and 502 subscribe cases. */
export function pageToggleErrorMessage(failure: PageToggleFailure, isActive: boolean, content: ContentFn): string {
  switch (failure.kind) {
    case 'limit-reached': {
      const { limit, activeCount } = failure
      if (limit === undefined || activeCount === undefined) {
        return content(
          'You’ve reached your plan’s Page limit. Switch another Page off or upgrade your plan.',
          'আপনার প্ল্যানের পেজ সীমা পূর্ণ হয়ে গেছে। অন্য একটি পেজ বন্ধ করুন বা প্ল্যান আপগ্রেড করুন।',
        )
      }
      return content(
        `Your plan allows ${limit} active ${limit === 1 ? 'Page' : 'Pages'} and ${activeCount} ${activeCount === 1 ? 'is' : 'are'} already on. Switch another Page off or upgrade your plan to protect more.`,
        `আপনার প্ল্যানে ${bnNumber(limit)}টি পেজ চালু রাখা যায় এবং ${bnNumber(activeCount)}টি আগে থেকেই চালু আছে। আরও পেজ সুরক্ষিত রাখতে অন্য একটি পেজ বন্ধ করুন বা প্ল্যান আপগ্রেড করুন।`,
      )
    }
    case 'token-missing':
      return pageNeedsReconnectMessage(content)
    case 'connection-needs-reauth':
      return connectionNeedsReauthToggleMessage(content)
    case 'subscribe-failed':
      return content(
        'Facebook didn’t confirm the connection for this Page, so protection is still off. Try again in a moment. If it keeps failing, reconnect Facebook.',
        'ফেসবুক এই পেজের সংযোগ নিশ্চিত করেনি, তাই সুরক্ষা এখনও বন্ধ আছে। একটু পরে আবার চেষ্টা করুন। বারবার ব্যর্থ হলে ফেসবুক আবার কানেক্ট করুন।',
      )
    case 'other':
      if (failure.error.status === 404) {
        return content(
          'This Page is no longer in your workspace. The list has been refreshed.',
          'এই পেজটি আর আপনার ওয়ার্কস্পেসে নেই। তালিকাটি রিফ্রেশ করা হয়েছে।',
        )
      }
      return `${
        isActive
          ? content('Couldn’t switch protection on.', 'সুরক্ষা চালু করা যায়নি।')
          : content('Couldn’t switch protection off.', 'সুরক্ষা বন্ধ করা যায়নি।')
      } ${failure.error.status === 403 ? pagesLoadErrorMessage(failure.error, content) : genericFailure(failure.error, content)}`
  }
}

/** Toggle refused with 409 `CONNECTION_NEEDS_REAUTH` (D9 soft block). */
export function connectionNeedsReauthToggleMessage(content: ContentFn): string {
  return content(
    'Facebook needs to be reconnected before protection can be switched on. Reconnect Facebook, then try again.',
    'সুরক্ষা চালু করার আগে ফেসবুক আবার কানেক্ট করতে হবে। ফেসবুক আবার কানেক্ট করুন, তারপর আবার চেষ্টা করুন।',
  )
}

/** `/pages` banner for a connection that isn't ACTIVE (D9). */
export function connectionBannerMessage(status: 'NEEDS_REAUTH' | 'REVOKED', content: ContentFn): string {
  if (status === 'REVOKED') {
    return content(
      'ShieldComment was removed from your Facebook account, so protection is off on every Page and new comments aren’t coming in. Reconnect Facebook to turn protection back on.',
      'আপনার ফেসবুক অ্যাকাউন্ট থেকে ShieldComment সরিয়ে দেওয়া হয়েছে, তাই সব পেজে সুরক্ষা বন্ধ এবং নতুন কমেন্ট আসছে না। সুরক্ষা আবার চালু করতে ফেসবুক আবার কানেক্ট করুন।',
    )
  }
  return content(
    'Your Facebook connection needs to be renewed. Pages that are on stay on, but no Page can be switched on until you reconnect Facebook.',
    'আপনার ফেসবুক কানেকশন নবায়ন করা দরকার। চালু থাকা পেজগুলো চালু থাকবে, কিন্তু ফেসবুক আবার কানেক্ট না করা পর্যন্ত নতুন কোনো পেজ চালু করা যাবে না।',
  )
}

/** `DELETE …/meta/connection` failures (shown inside the confirm dialog). */
export function disconnectErrorMessage(error: ApiError, content: ContentFn): string {
  const prefix = content('Facebook wasn’t disconnected.', 'ফেসবুক ডিসকানেক্ট হয়নি।')
  if (error.status === 403) {
    return `${prefix} ${content(
      'Only workspace owners and admins can disconnect Facebook, and not during Admin Impersonation.',
      'শুধু ওয়ার্কস্পেসের মালিক ও অ্যাডমিন ফেসবুক ডিসকানেক্ট করতে পারেন, অ্যাডমিন ইমপারসোনেশনের সময় নয়।',
    )}`
  }
  if (error.status === 404) {
    return `${prefix} ${content('This workspace couldn’t be found.', 'এই ওয়ার্কস্পেসটি খুঁজে পাওয়া যায়নি।')}`
  }
  return `${prefix} ${genericFailure(error, content)}`
}

/** After a successful disconnect (`disconnected: false` = nothing was connected any more). */
export function disconnectSuccessMessage(result: MetaDisconnectResponse, content: ContentFn): string {
  if (!result.disconnected) {
    return content(
      'Facebook was already disconnected. Nothing was removed.',
      'ফেসবুক আগেই ডিসকানেক্ট করা ছিল। কিছু সরানো হয়নি।',
    )
  }
  const pages = result.pagesDeleted
  const comments = result.commentsKept
  return content(
    `Facebook disconnected. ${pages} ${pages === 1 ? 'Page was' : 'Pages were'} removed and ${comments} ${comments === 1 ? 'comment was' : 'comments were'} kept.`,
    `ফেসবুক ডিসকানেক্ট হয়েছে। ${bnNumber(pages)}টি পেজ সরানো হয়েছে এবং ${bnNumber(comments)}টি কমেন্ট রাখা হয়েছে।`,
  )
}
