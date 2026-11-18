import { authClient } from '@/lib/auth-client'
import { authErrorFromResponse, toAuthError, type ContentFn } from '@/lib/auth-errors'

/** Better Auth `emailAndPassword` limits on the backend (`minPasswordLength: 8`, default max 128). */
export const PASSWORD_MIN = 8
export const PASSWORD_MAX = 128
/** `WORKSPACE_NAME_MAX` in `backend/src/auth/first-workspace.ts` (`parseWorkspaceName`). */
export const BUSINESS_NAME_MAX = 80

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export interface SignInInput {
  email: string
  password: string
}

export interface SignUpInput {
  name: string
  email: string
  password: string
  /** Becomes the first workspace's name (sent as `workspaceName`). */
  businessName: string
}

export type FieldError = 'required' | 'invalid-email' | 'too-short' | 'too-long'
export type FieldErrors<K extends string> = Partial<Record<K, FieldError>>

function emailError(email: string): FieldError | undefined {
  if (!email.trim()) return 'required'
  return EMAIL_PATTERN.test(email.trim()) ? undefined : 'invalid-email'
}

function compact<K extends string>(errors: Record<K, FieldError | undefined>): FieldErrors<K> {
  const result: FieldErrors<K> = {}
  for (const key of Object.keys(errors) as K[]) {
    if (errors[key]) result[key] = errors[key]
  }
  return result
}

export function validateSignIn(input: SignInInput): FieldErrors<keyof SignInInput> {
  return compact({ email: emailError(input.email), password: input.password ? undefined : 'required' })
}

/**
 * Same rules as the backend: Better Auth's password length, and `parseWorkspaceName` (trimmed,
 * 1–80 characters) for the business name, so a valid form never gets the hook's 400.
 */
export function validateSignUp(input: SignUpInput): FieldErrors<keyof SignUpInput> {
  const businessName = input.businessName.trim()
  return compact({
    name: input.name.trim() ? undefined : 'required',
    email: emailError(input.email),
    password: !input.password
      ? 'required'
      : input.password.length < PASSWORD_MIN
        ? 'too-short'
        : input.password.length > PASSWORD_MAX
          ? 'too-long'
          : undefined,
    businessName: !businessName ? 'required' : businessName.length > BUSINESS_NAME_MAX ? 'too-long' : undefined,
  })
}

export function fieldErrorMessage(field: keyof SignUpInput, error: FieldError, content: ContentFn): string {
  switch (error) {
    case 'required':
      switch (field) {
        case 'name':
          return content('Enter your name.', 'আপনার নাম লিখুন।')
        case 'email':
          return content('Enter your email address.', 'আপনার ইমেইল ঠিকানা লিখুন।')
        case 'password':
          return content('Enter your password.', 'আপনার পাসওয়ার্ড লিখুন।')
        case 'businessName':
          return content('Enter your business name.', 'আপনার ব্যবসার নাম লিখুন।')
      }
      break
    case 'invalid-email':
      return content('Enter a valid email address.', 'একটি সঠিক ইমেইল ঠিকানা দিন।')
    case 'too-short':
      return content(
        `Use at least ${PASSWORD_MIN} characters.`,
        'কমপক্ষে ৮ অক্ষর ব্যবহার করুন।',
      )
    case 'too-long':
      return field === 'businessName'
        ? content(`Use at most ${BUSINESS_NAME_MAX} characters.`, 'সর্বোচ্চ ৮০ অক্ষর ব্যবহার করুন।')
        : content(`Use at most ${PASSWORD_MAX} characters.`, 'সর্বোচ্চ ১২৮ অক্ষর ব্যবহার করুন।')
  }
  return ''
}

/** Reads Better Auth's rate-limit header off a failed response. */
function captureRetryAfter() {
  const captured = { retryAfter: null as string | null }
  const onError = (ctx: { response: Response }) => {
    captured.retryAfter = ctx.response.headers.get('X-Retry-After')
  }
  return { captured, onError }
}

/** `POST /api/auth/sign-in/email`. Throws `AuthError` (network failures included). */
export async function signInWithEmail(input: SignInInput): Promise<void> {
  const { captured, onError } = captureRetryAfter()
  let result: Awaited<ReturnType<typeof authClient.signIn.email>>
  try {
    result = await authClient.signIn.email({ email: input.email.trim(), password: input.password }, { onError })
  } catch (thrown) {
    throw toAuthError(thrown)
  }
  if (result.error) throw authErrorFromResponse(result.error, captured.retryAfter)
}

/**
 * `POST /api/auth/sign-up/email` with the business name as `workspaceName`; the backend's sign-up hook
 * names the first workspace with it. `workspaceName` is not a Better Auth user field, so it isn't in
 * the typed first argument; it goes in `fetchOptions.body`, which the client merges into the JSON body
 * (`better-auth/dist/client/proxy.mjs`: `{ ...body, ...options.body }`). Better Auth signs the new user
 * in (autoSignIn), so the session cookie is set when this resolves.
 */
export async function signUpWithWorkspace(input: SignUpInput): Promise<void> {
  const { captured, onError } = captureRetryAfter()
  let result: Awaited<ReturnType<typeof authClient.signUp.email>>
  try {
    result = await authClient.signUp.email(
      { name: input.name.trim(), email: input.email.trim(), password: input.password },
      { body: { workspaceName: input.businessName.trim() }, onError },
    )
  } catch (thrown) {
    throw toAuthError(thrown)
  }
  if (result.error) throw authErrorFromResponse(result.error, captured.retryAfter)
}

/**
 * `POST /api/auth/sign-out` for the current session (normal log-out and the impersonation "Exit").
 * Better Auth answers 200 even when the session is already gone, so any error means the cookie may
 * still be live: 403 (untrusted Origin), 429, 5xx or a network failure. Throws `AuthError`.
 */
export async function signOutCurrentSession(): Promise<void> {
  const { captured, onError } = captureRetryAfter()
  let result: Awaited<ReturnType<typeof authClient.signOut>>
  try {
    result = await authClient.signOut({ fetchOptions: { onError } })
  } catch (thrown) {
    throw toAuthError(thrown)
  }
  if (result.error) throw authErrorFromResponse(result.error, captured.retryAfter)
}
