import { useMutation, useQuery, useQueryClient, type UseMutationResult } from '@tanstack/react-query'
import { createFileRoute, Link, useNavigate, useRouter } from '@tanstack/react-router'
import { LoaderCircle, LogOut, UsersRound } from 'lucide-react'
import { useState, type FormEvent, type ReactNode } from 'react'
import { AuthAlert, AuthScreen, FormField } from '@/components/auth/auth-screen'
import { Button } from '@/components/ui/button'
import { useLanguage } from '@/hooks/use-language'
import { ApiError, toApiError } from '@/lib/api'
import type { AuthSession } from '@/lib/auth-client'
import { AuthError, authErrorMessage } from '@/lib/auth-errors'
import { fieldErrorMessage, PASSWORD_MIN, signOutCurrentSession, validateSignUp, type FieldErrors } from '@/lib/auth-forms'
import {
  acceptInvitation,
  invitationQueryOptions,
  inviteErrorMessage,
  isFinalInviteError,
  isInvitationId,
  notFoundError,
  signUpFromInvite,
  type InvitationDetails,
  type InviteSignUpInput,
} from '@/lib/invite'
import { sessionQueryOptions } from '@/lib/session'
import { roleLabel, type TeamRole } from '@/lib/team'
import { workspacesQueryKey, workspacesQueryOptions } from '@/lib/workspaces'

/**
 * Invite link (M7-T14; Module 7 D8 a, M7-D18 a, M7-D22 "generic page"). Public, outside `_app`.
 * Signed out: a generic "you've been invited" page with the sign-up form (sends `invitationId`, no
 * `workspaceName`, then accepts) and a log-in link that returns here. Signed in: the invite (workspace,
 * inviter, role from `get-invitation`) + Accept → active workspace → `/dashboard`.
 */
export const Route = createFileRoute('/invite/$invitationId')({
  beforeLoad: async ({ context }): Promise<{ session: AuthSession | null }> => {
    try {
      return { session: await context.queryClient.ensureQueryData(sessionQueryOptions) }
    } catch {
      return { session: null } // session check failed: show the signed-out page; sign-up reports the problem
    }
  },
  head: () => ({ meta: [{ title: 'Invitation | ShieldComment BD' }, { name: 'robots', content: 'noindex' }] }),
  component: InvitePage,
})

function InvitePage() {
  const { invitationId } = Route.useParams()
  const { session } = Route.useRouteContext()
  const queryClient = useQueryClient()
  const navigate = useNavigate()

  // Page-level so its state survives the switch from the sign-up form to the signed-in view.
  const accept = useMutation<void, ApiError>({
    mutationFn: async () => {
      try {
        await acceptInvitation(invitationId)
      } catch (error) {
        throw toApiError(error)
      }
    },
    onSuccess: async () => {
      // Same as the workspace switcher (M7-T11): fresh session, drop tenant data, then the dashboard.
      await queryClient.fetchQuery({ ...sessionQueryOptions, staleTime: 0 })
      queryClient.removeQueries({ queryKey: ['workspace'] })
      queryClient.removeQueries({ queryKey: workspacesQueryKey })
      await navigate({ to: '/dashboard', replace: true })
    },
  })

  return session ? (
    <SignedIn invitationId={invitationId} session={session} accept={accept} />
  ) : (
    <SignedOut invitationId={invitationId} onSignedUp={() => accept.mutate()} />
  )
}

type AcceptMutation = UseMutationResult<void, ApiError, void>

function InviteFrame({ footer, children }: { footer: ReactNode; children: ReactNode }) {
  const { content } = useLanguage()
  return (
    <AuthScreen
      title={content('You’ve been invited to a workspace', 'আপনাকে একটি ওয়ার্কস্পেসে আমন্ত্রণ জানানো হয়েছে')}
      description={content(
        'Join your team on ShieldComment to keep scam comments off your ads.',
        'অ্যাডে স্ক্যাম কমেন্ট ঠেকাতে ShieldComment-এ আপনার টিমে যোগ দিন।',
      )}
      footer={footer}
    >
      {children}
    </AuthScreen>
  )
}

const EMPTY: InviteSignUpInput = { name: '', email: '', password: '' }

function SignedOut({ invitationId, onSignedUp }: { invitationId: string; onSignedUp: () => void }) {
  const { content, language } = useLanguage()
  const queryClient = useQueryClient()
  const router = useRouter()
  const [values, setValues] = useState<InviteSignUpInput>(EMPTY)
  const [fieldErrors, setFieldErrors] = useState<FieldErrors<keyof InviteSignUpInput>>({})
  const loginSearch = { redirect: `/invite/${invitationId}` }

  const signUp = useMutation<void, AuthError | ApiError, InviteSignUpInput>({
    mutationFn: (input) => (isInvitationId(invitationId) ? signUpFromInvite(invitationId, input) : Promise.reject(notFoundError())),
    onSuccess: async () => {
      // Signed in now (autoSignIn): drop the cached `null` session, re-run the guard, then accept.
      queryClient.removeQueries()
      await router.invalidate()
      onSignedUp()
    },
  })

  const update = (field: keyof InviteSignUpInput, value: string) => {
    setValues((current) => ({ ...current, [field]: value }))
    setFieldErrors((current) => ({ ...current, [field]: undefined }))
    if (signUp.isError) signUp.reset()
  }

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (signUp.isPending) return
    // Same rules as `/register` minus the business name (an invite creates no workspace).
    const { name, email, password } = validateSignUp({ ...values, businessName: 'x' })
    const errors = { name, email, password }
    setFieldErrors(errors)
    const first = (['name', 'email', 'password'] as const).find((field) => errors[field])
    if (first) {
      document.getElementById(first)?.focus()
      return
    }
    signUp.mutate(values)
  }

  const errorFor = (field: keyof InviteSignUpInput) => {
    const error = fieldErrors[field]
    return error ? fieldErrorMessage(field, error, content) : undefined
  }
  const error = signUp.error

  return (
    <InviteFrame
      footer={
        <p>
          {content('Already have an account?', 'আগে থেকেই অ্যাকাউন্ট আছে?')}{' '}
          <Link to="/login" search={loginSearch} className="font-medium text-primary underline-offset-4 hover:underline">
            {content('Log in', 'লগ ইন')}
          </Link>
        </p>
      }
    >
      <form className="flex flex-col gap-4" onSubmit={onSubmit} noValidate aria-busy={signUp.isPending}>
        <p className="text-sm text-muted-foreground">
          {content(
            'Create your account with the email address the invite was sent to. You’ll see the workspace after that.',
            'যে ইমেইল ঠিকানায় আমন্ত্রণ পাঠানো হয়েছে সেটি দিয়ে অ্যাকাউন্ট খুলুন। এরপর ওয়ার্কস্পেসটি দেখতে পাবেন।',
          )}
        </p>
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
            id="email"
            label={content('Email', 'ইমেইল')}
            type="email"
            autoComplete="email"
            inputMode="email"
            value={values.email}
            onChange={(e) => update('email', e.target.value)}
            error={errorFor('email')}
            hint={content('The address the invite was sent to.', 'যে ঠিকানায় আমন্ত্রণ পাঠানো হয়েছে।')}
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
        {error && (
          <AuthAlert id="invite-sign-up-error" kind={error instanceof AuthError ? error.kind : 'invalid-input'}>
            {error instanceof AuthError ? authErrorMessage(error, content) : inviteErrorMessage(error, content, language)}{' '}
            {error instanceof AuthError && error.kind === 'user-exists' && (
              <Link to="/login" search={loginSearch} className="font-medium text-primary underline-offset-4 hover:underline">
                {content('Go to login', 'লগইনে যান')}
              </Link>
            )}
          </AuthAlert>
        )}
        <Button type="submit" className="h-11 w-full" disabled={signUp.isPending}>
          {signUp.isPending && <LoaderCircle className="animate-spin motion-reduce:animate-none" aria-hidden />}
          {signUp.isPending
            ? content('Creating account…', 'অ্যাকাউন্ট খোলা হচ্ছে…')
            : content('Create account and join', 'অ্যাকাউন্ট খুলে যোগ দিন')}
        </Button>
      </form>
    </InviteFrame>
  )
}

function SignedIn({ invitationId, session, accept }: { invitationId: string; session: AuthSession; accept: AcceptMutation }) {
  const { content, language } = useLanguage()
  const queryClient = useQueryClient()
  const router = useRouter()
  const validId = isInvitationId(invitationId)
  // Not while accepting (or after): the accepted invite would read as "not found".
  const details = useQuery({ ...invitationQueryOptions(invitationId), enabled: validId && (accept.isIdle || accept.isError) })
  const workspaces = useQuery({ ...workspacesQueryOptions, enabled: details.isSuccess })

  const signOut = useMutation<void, AuthError>({
    mutationFn: signOutCurrentSession,
    onSuccess: async () => {
      queryClient.clear()
      await router.invalidate()
    },
  })

  const readError = validId ? (details.error ? toApiError(details.error) : null) : notFoundError()
  const error = readError ?? accept.error
  const wrongEmail = error?.code === 'YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION'
  const alreadyMember =
    details.data && workspaces.data?.some((workspace) => workspace.id === details.data.organizationId)
  const canAccept = details.isSuccess && !alreadyMember && !(error && isFinalInviteError(error))

  return (
    <InviteFrame
      footer={
        <p>
          {content('Signed in as', 'লগ ইন করা আছে')} <span className="font-medium text-foreground">{session.user.email}</span>
        </p>
      }
    >
      <div className="flex flex-col gap-4" aria-busy={details.isLoading || accept.isPending}>
        {details.isLoading && validId && (
          <p role="status" className="flex items-center justify-center gap-2 py-4 text-sm text-muted-foreground">
            <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" aria-hidden />
            {content('Loading the invite…', 'আমন্ত্রণ লোড হচ্ছে…')}
          </p>
        )}
        {details.data && <InviteSummary invite={details.data} />}
        {alreadyMember && (
          <p role="status" className="rounded-2xl bg-muted px-4 py-3 text-sm">
            {content('You’re already a member of this workspace.', 'আপনি আগে থেকেই এই ওয়ার্কস্পেসের সদস্য।')}{' '}
            <Link to="/dashboard" className="font-medium text-primary underline-offset-4 hover:underline">
              {content('Go to dashboard', 'ড্যাশবোর্ডে যান')}
            </Link>
          </p>
        )}
        {error && (
          <AuthAlert id="invite-error" kind={error.isNetwork ? 'network' : 'invalid-input'}>
            {inviteErrorMessage(error, content, language)}
          </AuthAlert>
        )}
        {signOut.error && <AuthAlert kind={signOut.error.kind}>{authErrorMessage(signOut.error, content)}</AuthAlert>}
        {canAccept && (
          <Button className="h-11 w-full" disabled={accept.isPending} onClick={() => accept.mutate()}>
            {accept.isPending && <LoaderCircle className="animate-spin motion-reduce:animate-none" aria-hidden />}
            {accept.isPending ? content('Joining…', 'যোগ দেওয়া হচ্ছে…') : content('Accept invite', 'আমন্ত্রণ গ্রহণ করুন')}
          </Button>
        )}
        {accept.isPending && !details.data && (
          <p role="status" className="flex items-center justify-center gap-2 py-4 text-sm text-muted-foreground">
            <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" aria-hidden />
            {content('Joining the workspace…', 'ওয়ার্কস্পেসে যোগ দেওয়া হচ্ছে…')}
          </p>
        )}
        {readError && !isFinalInviteError(readError) && (
          <Button variant="outline" className="h-11 w-full" onClick={() => void details.refetch()}>
            {content('Try again', 'আবার চেষ্টা করুন')}
          </Button>
        )}
        {wrongEmail && (
          <Button variant="outline" className="h-11 w-full" disabled={signOut.isPending} onClick={() => signOut.mutate()}>
            {signOut.isPending ? (
              <LoaderCircle className="animate-spin motion-reduce:animate-none" aria-hidden />
            ) : (
              <LogOut aria-hidden />
            )}
            {content('Log out and use another account', 'লগ আউট করে অন্য অ্যাকাউন্ট ব্যবহার করুন')}
          </Button>
        )}
      </div>
    </InviteFrame>
  )
}

function InviteSummary({ invite }: { invite: InvitationDetails }) {
  const { content } = useLanguage()
  const role = invite.role === 'admin' || invite.role === 'moderator' ? roleLabel(invite.role as TeamRole, content) : invite.role
  return (
    <div className="flex items-start gap-3 rounded-2xl bg-muted px-4 py-3">
      <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
        <UsersRound className="size-5" aria-hidden />
      </span>
      <div className="grid min-w-0 gap-0.5 text-sm">
        <p className="truncate text-base font-semibold" data-testid="invite-workspace">
          {invite.organizationName}
        </p>
        <p className="text-muted-foreground">
          {content('Invited by', 'আমন্ত্রণ জানিয়েছেন')} <span className="text-foreground">{invite.inviterEmail}</span>
        </p>
        <p className="text-muted-foreground">
          {content('Role', 'রোল')}: <span className="text-foreground">{role}</span>
        </p>
      </div>
    </div>
  )
}
