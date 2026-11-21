# Meta App Review package (Module 9, M9-T12)

Everything we send to Meta for App Review: the reviewer overview, one section per permission, the test account setup, the screencast shot list, the URLs and the pre-submission checklist. Decision **D7 (a)** (TASKS.md Module 9): the agent wrote this package; the user records the screencast on staging during the live Meta test (M9-T15) and submits (M9-T16) once the legal pages are live on the public domain and Business Verification is done.

- `<domain>` is a placeholder until the domain is chosen (M9-T13). Staging hosts are `*.staging.<domain>`, production hosts are `*.<domain>` (deploy.md §1).
- Staging uses the Meta **test app**, production the **live app** (D5). Each app has its own id, secret, Login configuration and URLs.
- Credentials (app login, Facebook test user) go **only** in the App Review submission form. Never in git, never in this file.
- The text in the `> Reviewer note` blocks is written to be pasted into the submission form as is.

## 1. App overview (for reviewers)

> Reviewer note: ShieldComment BD is a comment moderation tool for small online shops in Bangladesh ("F-commerce": shops that sell through a Facebook Page and Instagram). Their ad and post comments are flooded with fake bKash/Nagad payment scams ("send money to this number to claim your prize"), competitors posting their own shop links, and abuse. The shop owner connects their Facebook Page and its linked Instagram professional account. When someone comments, Meta sends us a webhook. Our AI reads the comment in Bangla, Banglish (Bangla in Latin letters) or English and classifies it. Scams, competitor links and abuse are hidden (or deleted, if the owner chose that). Real customer questions stay visible and can get an automatic reply from the Page. The owner sees every comment and every action in a dashboard and can undo any action (unhide) or reply by hand. We act only on comments on Pages the owner connected and switched on. We never post on our own, never message users, and never use the data for ads.

Who uses it: the shop owner and their team (roles owner, admin, moderator) in a workspace on `app.<domain>`. The language of the app is English or Bangla.

How the data flows:
1. The owner signs in on `app.<domain>` and clicks **Connect Facebook** (Facebook Login for Business, our `config_id`).
2. We exchange the code for a long-lived user token, read the Page list with Page tokens, and store the tokens encrypted (AES-256-GCM). Every token call sends `appsecret_proof` (Require App Secret is on).
3. The owner switches a Page on. We subscribe the app to the Page (`feed`) so Meta sends comment webhooks. Instagram comments arrive through the app-level Instagram webhook (`comments`).
4. Each new or edited comment is classified, then hidden, deleted, replied to or left visible as the owner's rules say.
5. Disconnect, Deauthorize and Data Deletion remove the tokens and the data (§5).

## 2. Permissions

All eight come from Module 3 **D4** and are the list `META_LOGIN_SCOPES` in `backend/src/meta/meta-graph.config.ts`. The Login for Business configuration in the Meta dashboard must request exactly these eight (with `config_id` the dialog takes its scopes from the configuration, not from a `scope` parameter).

**Access level.** Standard Access works only for people with a role on the app (admins, developers, testers). Our users are shop owners without a role, so **every permission below needs Advanced Access through App Review**. Staging (test app) runs fine on Standard Access with testers. Meta may refuse a permission it can't see in use, so each one has a step in the screencast (§4).

| Permission | Feature | Access needed |
|---|---|---|
| `pages_show_list` | Page list after connect | Advanced (App Review) |
| `pages_read_engagement` | Page tokens, post text for AI context | Advanced (App Review) |
| `pages_manage_engagement` | Hide / unhide / delete / reply on Facebook comments | Advanced (App Review) |
| `pages_read_user_content` | Read customer comments on the Page | Advanced (App Review) |
| `pages_manage_metadata` | Subscribe the app to Page webhooks | Advanced (App Review) |
| `business_management` | Pages owned by a business portfolio | Advanced (App Review) |
| `instagram_basic` | Linked Instagram account + post captions | Advanced (App Review) |
| `instagram_manage_comments` | Instagram comment webhooks, hide / delete / reply | Advanced (App Review) |

The "How to test" steps below assume the test account from §3 and use `https://app.<domain>` (on staging: `https://app.staging.<domain>`).

### 2.1 `pages_show_list`

- **Feature:** after Facebook Login the owner sees the Pages they manage and picks which ones ShieldComment protects (Connected Pages screen, `/pages`).
- **API calls:** `GET /me/accounts?fields=id,name,access_token,instagram_business_account{id,username}` (user token, all result pages followed).
- **Why we need it:** without the list we can't know which Pages the owner manages, so nothing can be connected.
- **How to test:**
  1. Sign in at `https://app.<domain>/login` with the reviewer app account.
  2. Open **Pages** (`/pages`) and click **Connect Facebook**.
  3. Log in with the Facebook test user, keep the test Page selected, approve.
  4. You land back on `/pages`: the test Page is listed with its name and its Instagram username.

> Reviewer note: We use pages_show_list to show the shop owner the Facebook Pages they manage after they log in, so they can choose which Pages ShieldComment should protect from scam comments. We read only id, name and the linked Instagram business account.

### 2.2 `pages_read_engagement`

- **Feature:** the Page access token (needed for every action on the Page's comments) and the post's text, which the AI reads as context when the owner turns on post context ("Is XL available?" means something only next to the post).
- **API calls:** `access_token` in `GET /me/accounts`; `GET /{post-id}?fields=message` with the Page token.
- **Why we need it:** without the Page token we can't moderate at all; without the post text the AI misreads short replies.
- **How to test:**
  1. Do §2.1 and switch the test Page **on** in `/pages`.
  2. From a second account, comment on a Page post: "XL ache?" ("Is XL available?").
  3. Open **Comments** (`/comments`): the comment shows up with category *Safe inquiry*; it stays visible on Facebook.

> Reviewer note: We use pages_read_engagement to get the Page access token for the Pages the owner connects, and to read the text of the Page's own post when a comment arrives, so our classifier understands the comment in context. We don't store post content beyond the moderation context.

### 2.3 `pages_manage_engagement`

- **Feature:** the core of the product. Scam, competitor and abusive comments are hidden (or deleted) automatically; real questions can get an auto-reply from the Page; the owner can unhide, hide, delete or reply by hand from the Comments screen.
- **API calls (Page token + `appsecret_proof`):** `POST /{comment-id}` with `is_hidden=true|false` (hide / unhide), `DELETE /{comment-id}` (delete), `POST /{comment-id}/comments` with `message` (reply as the Page).
- **Why we need it:** hiding a scam within seconds is what protects the shop's customers. Without it the app can only watch.
- **How to test:**
  1. Test Page switched on (§2.1–2.2).
  2. From a second account, post this scam comment on a Page post: `Congratulations! You won 5000 tk. Send 50 tk bKash to 01712-345678 to claim`.
  3. Within a few seconds the comment is hidden on Facebook (the commenter and their friends still see it; others don't). In `/comments` it shows **Hidden**, category *Scam / phishing*.
  4. Post a question: `Ei dress ta koto taka?` ("How much is this dress?"). It stays visible and the Page replies with the auto-reply text set in **Rules** (`/rules` → Safe inquiry → Auto-reply).
  5. In `/comments`, open the hidden scam comment and click **Unhide**: it is visible again on Facebook. **Hide** hides it again; **Reply** posts a reply as the Page; **Delete** removes it.

> Reviewer note: We use pages_manage_engagement to hide (or delete, if the owner chose that) scam, competitor and abusive comments on the owner's Page, to post the owner's own auto-reply text to genuine customer questions, and to let the owner hide, unhide, delete or reply to comments manually from our dashboard. Every action is logged and can be undone by the owner.

### 2.4 `pages_read_user_content`

- **Feature:** reading the customers' comments on the Page (text, author id and name, post id) so the AI can classify them and the owner can see them in the Comments feed.
- **API calls:** the Page `feed` webhook (`item: comment`, verbs add / edited / remove) delivers the comment; acting on user comments (§2.3) also needs this permission.
- **Why we need it:** the comments we moderate are user-generated content on the Page.
- **How to test:** same as §2.3 steps 2–3: the comment text and author appear in `/comments`. Edit the scam comment to a harmless text: the app re-checks the edit and unhides it.

> Reviewer note: We use pages_read_user_content to read comments that people post on the owner's Page (delivered by the Page feed webhook), so we can detect scams and abuse and show the owner every comment with the action taken. We delete comment text on disconnect or on a data deletion request.

### 2.5 `pages_manage_metadata`

- **Feature:** turning protection on and off per Page. Switching a Page on subscribes our app to its webhooks; switching it off, disconnecting or deauthorizing unsubscribes it.
- **API calls:** `POST /{page-id}/subscribed_apps` with `subscribed_fields=feed`, `DELETE /{page-id}/subscribed_apps` (Page token + `appsecret_proof`).
- **Why we need it:** Meta only sends comment webhooks for Pages the app is subscribed to. Without it no comment reaches us.
- **How to test:**
  1. In `/pages`, switch the test Page **on** (subscribe).
  2. Post a comment from a second account: it appears in `/comments` within seconds.
  3. Switch the Page **off** (unsubscribe), post another comment: it does not appear.

> Reviewer note: We use pages_manage_metadata to subscribe our app to the feed webhook of the Pages the owner switches on, and to unsubscribe when they switch a Page off or disconnect. This is how comments reach our moderation.

### 2.6 `business_management`

- **Feature:** connecting Pages that belong to a business portfolio (Business Manager). Most Bangladeshi shops run their Page and ad account inside a portfolio. With Facebook Login for Business the portfolio's Pages only show up in `GET /me/accounts` when this permission is granted.
- **API calls:** none of its own; it lets `GET /me/accounts` (§2.1) return portfolio-owned Pages and their tokens.
- **Why we need it:** without it, shops whose Page is owned by a portfolio see an empty Page list and can't use the app.
- **How to test:** give the reviewer a Facebook test user whose test Page belongs to a business portfolio (§3). Do §2.1: the portfolio's Page is listed.

> Reviewer note: Our customers manage their Pages through a Meta business portfolio. We use business_management only so that Facebook Login for Business returns the Pages owned by the owner's business portfolio in /me/accounts. We don't read or change any other business assets.

### 2.7 `instagram_basic`

- **Feature:** finding the Instagram professional account linked to each Page and showing its username, and reading the caption of an Instagram post for AI context.
- **API calls:** `instagram_business_account{id,username}` in `GET /me/accounts`; `GET /{ig-media-id}?fields=caption` (Page token).
- **Why we need it:** without it we can't tell which Instagram account belongs to the Page, so Instagram comments can't be routed to the right shop.
- **How to test:** do §2.1: the test Page row in `/pages` shows the linked Instagram username (`@…`).

> Reviewer note: We use instagram_basic to read the id and username of the Instagram professional account linked to each connected Page, and the caption of the owner's own Instagram post as context for classifying a comment.

### 2.8 `instagram_manage_comments`

- **Feature:** the same moderation on Instagram: comment webhooks, hide / unhide, delete and reply.
- **API calls (Page token + `appsecret_proof`):** the Instagram `comments` webhook; `POST /{ig-comment-id}` with `hide=true|false`; `DELETE /{ig-comment-id}`; `POST /{ig-comment-id}/replies` with `message`.
- **Why we need it:** many shops sell mostly on Instagram, where the same scams appear.
- **How to test:**
  1. Test Page switched on; its Instagram professional account is linked.
  2. From a second Instagram account, comment the scam text from §2.3 on a post of the test Instagram account.
  3. It is hidden within seconds (Instagram shows it under *Hidden comments*); `/comments` shows it with platform Instagram, **Hidden**.
  4. Post a question: it stays visible and gets the auto-reply. **Unhide** from `/comments` makes the scam comment visible again.

> Reviewer note: We use instagram_manage_comments to receive comments on the owner's Instagram professional account, hide (or delete) scam, competitor and abusive comments, post the owner's auto-reply to genuine questions, and let the owner unhide, delete or reply from our dashboard.

## 3. Reviewer test account

Set this up on **production** (live app) before submitting, after go-live checks pass (M9-T16). Rehearse the same on staging with the test app during M9-T15. Credentials go only into the submission form ("App Verification Details" / reviewer instructions).

1. **App login (ShieldComment):** register `reviewer@<domain>` (or another mailbox you control) on `https://app.<domain>/register`, verify the email, business name "ShieldComment Review". This creates the workspace; you are its **owner** (only owners and admins can connect Facebook).
2. **Plan:** the sign-up trial (Starter) has no auto-reply. In the admin panel (`https://admin.<domain>`) activate **Growth** for this workspace manually (source ADMIN, reason "Meta App Review"), so the auto-reply steps work.
3. **Rules:** in `/rules`, mode **Auto**; Scam / phishing = Hide; Competitor = Hide; Abusive = Hide; Safe inquiry: Auto-reply on with an English and a Bangla text (e.g. "Thanks! We sent the price to your inbox." / "ধন্যবাদ! দাম ইনবক্সে পাঠানো হয়েছে।"). Save.
4. **Facebook side:** a Facebook account that you control (or a test user of the app) that is admin of a test Page "ShieldComment Test Shop". Put the Page in a business portfolio (for `business_management`) and link an Instagram professional account to it. Post 1–2 product posts on both.
5. **Second account for comments:** a second Facebook + Instagram account to post the test comments. While the app is in Development mode it must have a role on the app (tester), or Meta sends no webhooks for its comments (meta-webhooks-local.md §3 step 5).
6. In the submission form give: the app URL, the app login (email + password), the Facebook login of the Page admin (if you give one; reviewers may use their own), and the step list "§2.x How to test". Mention that the second account's comments are already on the posts, in case the reviewer can't comment from a second account.
7. After the review: change the reviewer password, remove the reviewer Facebook roles, keep or delete the workspace.

## 4. Screencast shot list

Recorded by the user on **staging** with the Meta test app during M9-T15 (D7). One video, **3 minutes or less**, screen at 1280×720 or larger, app language **English**, **English captions** burned in (or a caption file). No passwords or tokens on screen (type them before you start recording, or blur). Meta reviewers watch for the permission dialog and each permission in use, so keep every step below.

| # | Shot (≈ seconds) | Shows | Permissions | Caption |
|---|---|---|---|---|
| 1 | Sign in on `app.staging.<domain>/login` (10 s) | Our app | — | "The shop owner signs in to ShieldComment." |
| 2 | `/pages` → **Connect Facebook** → Login for Business dialog, scroll the permission list, choose the Page (and its business portfolio), approve (30 s) | The dialog with all eight permissions | all | "The owner connects their Facebook Page and its Instagram account with Facebook Login for Business." |
| 3 | Back on `/pages`: Page listed with its Instagram username; switch it **on** (15 s) | Page list, IG username, toggle | `pages_show_list`, `business_management`, `instagram_basic`, `pages_manage_metadata` | "We list the Pages the owner manages. Switching a Page on subscribes it to comment webhooks." |
| 4 | Second window (commenter): post the scam comment on a Facebook post (15 s) | Facebook post | — | "A scammer posts a fake bKash prize comment." |
| 5 | Refresh the post as the Page admin / a third viewer: comment hidden. `/comments`: row **Hidden**, *Scam / phishing* (25 s) | Hidden comment, feed row | `pages_read_user_content`, `pages_read_engagement`, `pages_manage_engagement` | "ShieldComment reads the comment, the AI detects the scam, and hides it within seconds." |
| 6 | Commenter asks "Ei dress ta koto taka?" → Page auto-reply appears (20 s) | Visible question + Page reply | `pages_manage_engagement` | "A real customer question stays visible and gets the owner's auto-reply." |
| 7 | Same on Instagram: scam comment hidden, question auto-replied (30 s) | IG post, *Hidden comments*, reply | `instagram_manage_comments`, `instagram_basic` | "The same protection works on the linked Instagram account." |
| 8 | `/dashboard` (counts) → `/comments` → open the hidden comment → **Unhide** → visible again on Facebook (20 s) | Dashboard, manual action | `pages_manage_engagement` | "The owner sees every action and can undo it at any time." |
| 9 | `/pages` → **Disconnect Facebook** → confirm (10 s) | Disconnect | `pages_manage_metadata` | "Disconnecting removes our access and the stored tokens." |
| 10 | Facebook → Settings & privacy → Business integrations → remove the app with *Send request to delete data* → open the status link `app.staging.<domain>/data-deletion?code=…` (pending → completed) (25 s) | Deauthorize + Data Deletion | — | "Removing the app from Facebook revokes access; a data deletion request deletes the Page's data and shows its status." |

Total ≈ 3 min. If it runs long, shorten shots 1, 4 and 9 first; never cut 2, 5, 6 or 7.

## 5. URLs

Production values (staging: replace `<domain>` with `staging.<domain>`). Every route exists today (verified in M9-T12, see TASKS.md verification log).

| Meta dashboard field | URL | Route in code |
|---|---|---|
| Privacy Policy URL (App settings → Basic) | `https://app.<domain>/privacy` (Bangla `/bn/privacy`) | `client/src/routes/privacy.tsx`, `bn_.privacy.tsx` |
| Terms of Service URL (App settings → Basic) | `https://app.<domain>/terms` (Bangla `/bn/terms`) | `client/src/routes/terms.tsx`, `bn_.terms.tsx` |
| Refund policy (SSLCommerz, not Meta; same site) | `https://app.<domain>/refund-policy` | `client/src/routes/refund-policy.tsx`, `bn_.refund-policy.tsx` |
| User data deletion → Data deletion callback URL | `https://api.<domain>/api/meta/data-deletion` | `POST` in `backend/src/meta-callbacks/meta-callbacks.controller.ts` |
| Data deletion status page (link Meta shows the user) | `https://app.<domain>/data-deletion?code=<code>` (reads `GET /api/meta/data-deletion/:code`) | `client/src/routes/data-deletion.tsx`; `GET data-deletion/:code` in the same controller |
| Facebook Login for Business → Deauthorize callback URL | `https://api.<domain>/api/meta/deauthorize` | `POST` in `meta-callbacks.controller.ts` |
| Facebook Login for Business → Valid OAuth Redirect URIs (= `META_OAUTH_REDIRECT_URI`) | `https://app.<domain>/api/meta/oauth/callback` (client origin, Module 3 D6; the client proxies `/api/*`) | `GET callback` in `backend/src/meta/meta-oauth.controller.ts`; proxy `client/src/routes/api/$.ts` |
| Webhooks → Page (`feed`) and Instagram (`comments`) callback URL + verify token `META_WEBHOOK_VERIFY_TOKEN` | `https://api.<domain>/api/webhooks/meta` | `GET` + `POST` in `backend/src/webhooks/meta-webhook.controller.ts` |
| App Domains | `<domain>` (covers `app.`, `api.`) | — |
| Site URL / website | `https://app.<domain>/` | `client/src/routes/index.tsx` |

App settings that are not URLs:
- **App icon:** 1024 × 1024 PNG, the ShieldComment shield, no text, no Meta logos.
- **Category:** *Business and pages*.
- **Contact email:** a monitored support address on `<domain>` (the same as `email` in `legal-facts.json`).
- **Advanced → Require App Secret:** on (we send `appsecret_proof` on every token call).
- **Login for Business configuration:** user access token, the eight permissions of §2; its id is `META_LOGIN_CONFIG_ID`.

## 6. Before you submit (checklist)

Carry-over from M9-T7:
- [ ] `client/src/lib/legal-facts.json` has no `[TODO: …]` left (`grep -n TODO client/src/lib/legal-facts.json` prints nothing): legal name, address, email, phone, trade licence no., refund window, last updated. Deployed, so `/privacy`, `/terms`, `/refund-policy` show the real facts.
- [ ] You have read the legal copy (agent draft) and the privacy policy names the Meta data we use: Page and Instagram account ids and names, Page tokens, comment text and author, and how to delete it (`/data-deletion`).

Business and app settings:
- [ ] **Business Verification** done for the business portfolio that owns the live app (Meta Business Settings → Security Center; trade licence and a utility bill or bank statement in the legal name).
- [ ] App settings → Basic: icon, category, privacy URL, terms URL, data deletion callback URL, contact email, app domains (§5).
- [ ] Facebook Login for Business: redirect URI and deauthorize URL (§5); configuration with exactly the eight permissions.
- [ ] Webhooks: Page `feed` and Instagram `comments` verified against `https://api.<domain>/api/webhooks/meta`.
- [ ] Each permission requested for Advanced Access with its "Reviewer note" text and the §2 steps; screencast uploaded (§4).
- [ ] Reviewer test account ready (§3): verified email, Growth plan, rules set, test Page in a portfolio with a linked Instagram account, comments in place.
- [ ] Data handling questions answered (data processors: our hosting, database and email providers; no data sold or shared for ads; data deleted on request).

After approval:
- [ ] **App Mode:** switch the live app from **Development** to **Live** (only after Advanced Access is granted, or real owners' comments won't arrive) (M9-T19).
- [ ] **Data Use Checkup:** Meta asks once a year to confirm each permission is still used as described. Answer it in the App Dashboard before the deadline, or the permissions are removed.
- [ ] Record the review result and date in TASKS.md (M9-T16).
