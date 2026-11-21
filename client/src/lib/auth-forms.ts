import { authClient } from '@/lib/auth-client'
import { authErrorFromResponse, toAuthError, type AuthClientError, type ContentFn } from '@/lib/auth-errors'

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

export type FieldError = 'required' | 'invalid-email' | 'too-short' | 'too-long' | 'mismatch'
export type FieldErrors<K extends string> = Partial<Record<K, FieldError>>

export function emailError(email: string): FieldError | undefined {
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
function passwordError(password: string): FieldError | undefined {
  if (!password) return 'required'
  if (password.length < PASSWORD_MIN) return 'too-short'
  return password.length > PASSWORD_MAX ? 'too-long' : undefined
}

export interface NewPasswordInput {
  password: string
  confirmPassword: string
}

/** `/reset-password`: the sign-up password rules + the confirmation must match. */
export function validateNewPassword(input: NewPasswordInput): FieldErrors<keyof NewPasswordInput> {
  return compact({
    password: passwordError(input.password),
    confirmPassword: !input.confirmPassword
      ? 'required'
      : input.confirmPassword !== input.password
        ? 'mismatch'
        : undefined,
  })
}

export function validateSignUp(input: SignUpInput): FieldErrors<keyof SignUpInput> {
  const businessName = input.businessName.trim()
  return compact({
    name: input.name.trim() ? undefined : 'required',
    email: emailError(input.email),
    password: passwordError(input.password),
    businessName: !businessName ? 'required' : businessName.length > BUSINESS_NAME_MAX ? 'too-long' : undefined,
  })
}

export function fieldErrorMessage(
  field: keyof SignUpInput | keyof NewPasswordInput,
  error: FieldError,
  content: ContentFn,
): string {
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
        case 'confirmPassword':
          return content('Enter the new password again.', 'নতুন পাসওয়ার্ডটি আবার লিখুন।')
      }
      break
    case 'mismatch':
      return content('The passwords don’t match.', 'পাসওয়ার্ড দুটি মিলছে না।')
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

/**
 * Runs one Better Auth client call: a thrown fetch becomes `AuthError('network')`, an `{ error }` result
 * an `AuthError` (with Better Auth's `X-Retry-After` read off the failed response).
 */
async function authCall(
  call: (onError: (ctx: { response: Response }) => void) => Promise<{ error: AuthClientError | null }>,
): Promise<void> {
  let retryAfter: string | null = null
  let result: { error: AuthClientError | null }
  try {
    result = await call((ctx) => {
      retryAfter = ctx.response.headers.get('X-Retry-After')
    })
  } catch (thrown) {
    throw toAuthError(thrown)
  }
  if (result.error) throw authErrorFromResponse(result.error, retryAfter)
}

/** `POST /api/auth/sign-in/email`. Throws `AuthError` (network failures included). */
export const signInWithEmail = (input: SignInInput) =>
  authCall((onError) => authClient.signIn.email({ email: input.email.trim(), password: input.password }, { onError }))

/**
 * `POST /api/auth/sign-up/email` with the business name as `workspaceName`; the backend's sign-up hook
 * names the first workspace with it. `workspaceName` is not a Better Auth user field, so it isn't in
 * the typed first argument; it goes in `fetchOptions.body`, which the client merges into the JSON body
 * (`better-auth/dist/client/proxy.mjs`: `{ ...body, ...options.body }`). Since M9-T5 (D10 b) sign-up
 * sets no session: the backend emails a verification link (a taken email answers the same 200).
 */
export const signUpWithWorkspace = (input: SignUpInput) =>
  authCall((onError) =>
    authClient.signUp.email(
      { name: input.name.trim(), email: input.email.trim(), password: input.password },
      { body: { workspaceName: input.businessName.trim() }, onError },
    ),
  )

/**
 * `POST /api/auth/sign-out` for the current session (normal log-out and the impersonation "Exit").
 * Better Auth answers 200 even when the session is already gone, so any error means the cookie may
 * still be live: 403 (untrusted Origin), 429, 5xx or a network failure. Throws `AuthError`.
 */
export const signOutCurrentSession = () => authCall((onError) => authClient.signOut({ fetchOptions: { onError } }))

/** `POST /api/auth/request-password-reset`: 200 whether or not the account exists (no enumeration). */
export const requestPasswordReset = (email: string) =>
  authCall((onError) => authClient.requestPasswordReset({ email: email.trim() }, { onError }))

/** `POST /api/auth/reset-password`: revokes every session; a bad, used or expired token → `invalid-token`. */
export const resetPassword = (token: string, newPassword: string) =>
  authCall((onError) => authClient.resetPassword({ token, newPassword }, { onError }))

/** `POST /api/auth/send-verification-email`: 200 for unknown or already verified emails too. */
export const sendVerificationEmail = (email: string) =>
  authCall((onError) => authClient.sendVerificationEmail({ email: email.trim() }, { onError }))

/**
 * `GET /api/auth/verify-email?token=`: the first use sets the session cookie (auto sign-in); a replay
 * answers 200 without one. Bad or expired → `invalid-token`.
 */
export const verifyEmail = (token: string) =>
  authCall((onError) => authClient.verifyEmail({ query: { token } }, { onError }))
