import { useMutation } from '@tanstack/react-query'
import { createFileRoute, Link, redirect } from '@tanstack/react-router'
import { LoaderCircle } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { AuthAlert, AuthScreen, FormField } from '@/components/auth/auth-screen'
import { AgreeToTerms } from '@/components/legal/legal-links'
import { CheckInbox } from '@/components/auth/check-inbox'
import { Button } from '@/components/ui/button'
import { useLanguage } from '@/hooks/use-language'
import { authErrorMessage, type AuthError } from '@/lib/auth-errors'
import {
  fieldErrorMessage,
  PASSWORD_MIN,
  signUpWithWorkspace,
  validateSignUp,
  type FieldErrors,
  type SignUpInput,
} from '@/lib/auth-forms'
import { checkoutTarget, validateCheckoutIntent } from '@/lib/billing'
import { sessionQueryOptions } from '@/lib/session'

/**
 * C2 sign-up (M3-T8, decision D13): name, email, password + business name (= the first workspace's
 * name). Since M9-T5/T6 (D10 b) sign-up sets no session: the page turns into "check your inbox" (resend
 * button) and `/verify-email` signs the user in. D11 (M8-T11): a signed-in visitor with
 * `?plan=<slug>&interval=month|year` from a "Choose plan" button goes to that checkout; the intent only
 * rides along on the links (after verification the account lands on `/plans`, it has no plan yet).
 */
export const Route = createFileRoute('/register')({
  validateSearch: validateCheckoutIntent,
  beforeLoad: async ({ context, search }) => {
    let session: unknown = null
    try {
      session = await context.queryClient.ensureQueryData(sessionQueryOptions)
    } catch {
      return // session check failed: show the form; sign-up reports the problem
    }
    if (session) throw redirect({ href: checkoutTarget(search) ?? '/dashboard', replace: true })
  },
  head: () => ({ meta: [{ title: 'Create account | ShieldComment BD' }, { name: 'robots', content: 'noindex' }] }),
  component: RegisterPage,
})

const EMPTY: SignUpInput = { name: '', email: '', password: '', businessName: '' }

function RegisterPage() {
  const intent = Route.useSearch()
  const { content } = useLanguage()
  const [values, setValues] = useState<SignUpInput>(EMPTY)
  const [fieldErrors, setFieldErrors] = useState<FieldErrors<keyof SignUpInput>>({})

  const signUp = useMutation<void, AuthError, SignUpInput>({ mutationFn: signUpWithWorkspace })

  const update = (field: keyof SignUpInput, value: string) => {
    setValues((current) => ({ ...current, [field]: value }))
    setFieldErrors((current) => ({ ...current, [field]: undefined }))
    if (signUp.isError) signUp.reset()
  }

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (signUp.isPending) return
    const errors = validateSignUp(values)
    setFieldErrors(errors)
    if (Object.keys(errors).length > 0) {
      const first = (['name', 'businessName', 'email', 'password'] as const).find((field) => errors[field])
      if (first) document.getElementById(first)?.focus()
      return
    }
    signUp.mutate(values)
  }

  const errorFor = (field: keyof SignUpInput) => {
    const error = fieldErrors[field]
    return error ? fieldErrorMessage(field, error, content) : undefined
  }

  if (signUp.isSuccess) {
    return (
      <CheckInbox
        email={signUp.variables.email.trim()}
        reason="sign-up"
        footer={
          <p>
            {content('Already verified?', 'যাচাই করা হয়ে গেছে?')}{' '}
            <Link to="/login" search={intent} className="font-medium text-primary underline-offset-4 hover:underline">
              {content('Log in', 'লগ ইন')}
            </Link>
          </p>
        }
      />
    )
  }

  return (
    <AuthScreen
      title={content('Create your account', 'আপনার অ্যাকাউন্ট খুলুন')}
      description={content(
        'Protect your Facebook and Instagram ads from scam comments.',
        'আপনার ফেসবুক ও ইনস্টাগ্রাম অ্যাডকে স্ক্যাম কমেন্ট থেকে সুরক্ষিত রাখুন।',
      )}
      footer={
        <p>
          {content('Already have an account?', 'আগে থেকেই অ্যাকাউন্ট আছে?')}{' '}
          <Link to="/login" search={intent} className="font-medium text-primary underline-offset-4 hover:underline">
            {content('Log in', 'লগ ইন')}
          </Link>
        </p>
      }
    >
      <form className="flex flex-col gap-4" onSubmit={onSubmit} noValidate aria-busy={signUp.isPending}>
        <fieldset className="flex flex-col gap-4" disabled={signUp.isPending}>
          <FormField
            id="name"
            label={content('Your name', 'আপনার নাম')}
            autoComplete="name"
            value={values.name}
            onChange={(e) => update('name', e.target.value)}
            error={errorFor('name')}
          />
          <FormField
            id="businessName"
            label={content('Business name', 'ব্যবসার নাম')}
            autoComplete="organization"
            value={values.businessName}
            onChange={(e) => update('businessName', e.target.value)}
            error={errorFor('businessName')}
            hint={content('Shown as your workspace name.', 'এটি আপনার ওয়ার্কস্পেসের নাম হিসেবে দেখাবে।')}
          />
          <FormField
            id="email"
            label={content('Email', 'ইমেইল')}
            type="email"
            autoComplete="email"
            inputMode="email"
            value={values.email}
            onChange={(e) => update('email', e.target.value)}
            error={errorFor('email')}
          />
          <FormField
            id="password"
            label={content('Password', 'পাসওয়ার্ড')}
            type="password"
            autoComplete="new-password"
            value={values.password}
            onChange={(e) => update('password', e.target.value)}
            error={errorFor('password')}
            hint={content(`At least ${PASSWORD_MIN} characters.`, 'কমপক্ষে ৮ অক্ষর।')}
          />
        </fieldset>
        {signUp.error && (
          <AuthAlert id="sign-up-error" kind={signUp.error.kind}>
            {authErrorMessage(signUp.error, content)}
          </AuthAlert>
        )}
        <Button type="submit" className="h-11 w-full" disabled={signUp.isPending}>
          {signUp.isPending && <LoaderCircle className="animate-spin motion-reduce:animate-none" aria-hidden />}
          {signUp.isPending
            ? content('Creating account…', 'অ্যাকাউন্ট খোলা হচ্ছে…')
            : content('Create account', 'অ্যাকাউন্ট খুলুন')}
        </Button>
        <AgreeToTerms />
      </form>
    </AuthScreen>
  )
}
