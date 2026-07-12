import { useRef, useState, type SubmitEvent } from "react"
import { useTranslation } from "react-i18next"
import { useNavigate } from "@tanstack/react-router"
import { toast } from "sonner"
import { sdkApi } from "@/lib/sdk/client"
import { persistSession, broadcastAuth } from "@/lib/sdk/session"
import { asErrorDTO } from "@/lib/sdk/errors"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { isValidEmail } from "@/lib/validate"
import { runLoginAttempt } from "@/features/auth/lib/loginAttempt"
import { useIsOnline } from "@/lib/useIsOnline"
import { Button } from "@/components/ui/button"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { TwoFactorDialog } from "@/features/auth/components/twoFactorDialog"

// Forgot-password dialog: small enough to live as a private sibling of the login form rather than
// its own file. Re-seeds its email field from the login form's current value on every open (the
// dialog stays mounted across open/close so a plain `useState` initializer would only ever run once).
function ForgotPasswordDialog({
	open,
	initialEmail,
	onOpenChange
}: {
	open: boolean
	initialEmail: string
	onOpenChange: (open: boolean) => void
}) {
	const { t } = useTranslation(["auth", "common"])
	const isOnline = useIsOnline()
	const [pending, setPending] = useState(false)
	// Re-seed on the open TRANSITION only, adjusting state during render (React's documented pattern
	// for "reset state when a prop changes") rather than in an effect — an effect's setState would
	// commit an extra render pass and trips react-hooks/set-state-in-effect.
	const [wasOpen, setWasOpen] = useState(open)
	const [email, setEmail] = useState(initialEmail)
	if (open !== wasOpen) {
		setWasOpen(open)
		if (open) {
			setEmail(initialEmail)
		}
	}

	async function handleSubmit(e: SubmitEvent): Promise<void> {
		e.preventDefault()
		setPending(true)
		try {
			await sdkApi.startPasswordReset(email.trim())
			onOpenChange(false)
			// Non-revealing by design: this fires on ANY resolve, never confirming account existence.
			toast.success(t("passwordResetEmailSent"))
		} catch (err) {
			// A network/server failure is not "email sent" — LABEL-FIRST, dialog stays open to retry.
			toast.error(errorLabel(asErrorDTO(err)))
		} finally {
			setPending(false)
		}
	}

	return (
		<Dialog
			open={open}
			onOpenChange={onOpenChange}
		>
			<DialogContent>
				<form
					onSubmit={e => {
						void handleSubmit(e)
					}}
					className="flex flex-col gap-6"
				>
					<DialogHeader>
						<DialogTitle>{t("forgotPasswordTitle")}</DialogTitle>
						<DialogDescription>{t("forgotPasswordBody")}</DialogDescription>
					</DialogHeader>
					<Field>
						<FieldLabel htmlFor="forgot-password-email">{t("forgotPasswordEmail")}</FieldLabel>
						<Input
							id="forgot-password-email"
							type="email"
							autoComplete="email"
							value={email}
							onChange={e => {
								setEmail(e.target.value)
							}}
						/>
					</Field>
					<DialogFooter>
						<Button
							type="submit"
							disabled={pending || !isValidEmail(email) || !isOnline}
							title={!isOnline ? t("common:offlineActionDisabled") : undefined}
						>
							{pending && <Spinner data-icon="inline-start" />}
							{t("forgotPasswordSubmit")}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	)
}

function LoginForm() {
	const { t } = useTranslation(["auth", "common"])
	const isOnline = useIsOnline()
	const navigate = useNavigate()
	const [email, setEmail] = useState("")
	const [password, setPassword] = useState("")
	const [pending, setPending] = useState(false)
	const [twoFactorOpen, setTwoFactorOpen] = useState(false)
	const [twoFactorError, setTwoFactorError] = useState<string>()
	const [forgotOpen, setForgotOpen] = useState(false)
	// Cancellation counter for in-flight attempts: bumped on every two-factor dialog dismissal, so an
	// attempt that started under an older value is stale when it settles and its result is discarded
	// (no dialog reopen, no toast, no navigation — a late success is logged out by the helper).
	const attemptGeneration = useRef(0)

	function handleTwoFactorOpenChange(open: boolean): void {
		if (!open) {
			// Dismissing cancels the in-flight retry, not just the dialog.
			attemptGeneration.current += 1
			setTwoFactorError(undefined)
		}
		setTwoFactorOpen(open)
	}

	// Shared by the first (code-less) attempt and every two-factor retry — the DTO's `kind` is the
	// only thing that differs between them. The worker keeps any existing client when a login attempt
	// fails, so a failed attempt needs no compensation here.
	async function attemptLogin(twoFactorCode?: string): Promise<void> {
		setPending(true)
		try {
			const trimmedEmail = email.trim()
			const outcome = await runLoginAttempt(
				{
					login: params => sdkApi.login(params),
					logout: () => sdkApi.logout(),
					persist: persistSession,
					broadcast: () => {
						broadcastAuth("login")
					},
					generation: () => attemptGeneration.current
				},
				twoFactorCode !== undefined ? { email: trimmedEmail, password, twoFactorCode } : { email: trimmedEmail, password }
			)
			switch (outcome.status) {
				case "stale":
					// Dismissed while in flight — the helper already discarded the result.
					break
				case "success":
					setTwoFactorOpen(false)
					if (!outcome.persisted) {
						// Signed in but not saved: the in-tab session is fully functional, only
						// resume-after-close is lost — navigating beats failing a successful login.
						toast.warning(t("sessionPersistFailed"))
					}
					await navigate({ to: "/drive/$", params: { _splat: "" } })
					break
				case "two-factor":
					setTwoFactorError(outcome.wrongCode ? t("twoFactorWrongCode") : undefined)
					setTwoFactorOpen(true)
					break
				case "error":
					setTwoFactorOpen(false)
					toast.error(errorLabel(outcome.dto))
					break
			}
		} catch (e) {
			// Only reachable from past the helper (it never throws) — e.g. a navigation failure.
			toast.error(errorLabel(asErrorDTO(e)))
		} finally {
			// Unconditional reset is safe: every submit affordance is disabled while pending, so
			// attempts can never overlap — this only ever clears THIS attempt's flag.
			setPending(false)
		}
	}

	const canSubmit = isValidEmail(email) && password.length > 0 && isOnline

	return (
		<>
			<form
				onSubmit={e => {
					e.preventDefault()
					void attemptLogin()
				}}
				className="flex flex-col gap-6"
			>
				<FieldGroup>
					<Field>
						<FieldLabel htmlFor="email">{t("loginEmail")}</FieldLabel>
						<Input
							id="email"
							type="email"
							autoComplete="email"
							placeholder={t("loginEmailPlaceholder")}
							value={email}
							disabled={pending}
							onChange={e => {
								setEmail(e.target.value)
							}}
						/>
					</Field>
					<Field>
						<FieldLabel htmlFor="password">{t("loginPassword")}</FieldLabel>
						<Input
							id="password"
							type="password"
							autoComplete="current-password"
							value={password}
							disabled={pending}
							onChange={e => {
								setPassword(e.target.value)
							}}
						/>
					</Field>
				</FieldGroup>
				<Button
					type="submit"
					className="w-full"
					disabled={!canSubmit || pending}
					title={!isOnline ? t("common:offlineActionDisabled") : undefined}
				>
					{pending && <Spinner data-icon="inline-start" />}
					{t("loginSubmit")}
				</Button>
			</form>
			<Button
				type="button"
				variant="link"
				className="h-auto w-full text-xs"
				onClick={() => {
					setForgotOpen(true)
				}}
			>
				{t("forgotPasswordLink")}
			</Button>
			<TwoFactorDialog
				open={twoFactorOpen}
				pending={pending}
				error={twoFactorError}
				onOpenChange={handleTwoFactorOpenChange}
				onSubmit={code => {
					void attemptLogin(code)
				}}
			/>
			<ForgotPasswordDialog
				open={forgotOpen}
				initialEmail={email}
				onOpenChange={setForgotOpen}
			/>
		</>
	)
}

export { LoginForm }
