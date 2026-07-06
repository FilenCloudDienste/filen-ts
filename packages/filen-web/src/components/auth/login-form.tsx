import { useState, type SubmitEvent } from "react"
import { useTranslation } from "react-i18next"
import { useNavigate } from "@tanstack/react-router"
import { toast } from "sonner"
import { sdkApi } from "@/lib/sdk/client"
import { persistSession, broadcastAuth } from "@/lib/sdk/session"
import { asErrorDTO } from "@/lib/sdk/errors"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { isValidEmail } from "@/lib/auth/validate"
import { Button } from "@/components/ui/button"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { TwoFactorDialog } from "@/components/auth/two-factor-dialog"

// Forgot-password dialog: not its own file (only login-form.tsx/two-factor-dialog.tsx are new
// components per the task scope) — small enough to live as a private sibling here. Re-seeds its
// email field from the login form's current value on every open (the dialog stays mounted across
// open/close so a plain `useState` initializer would only ever run once).
function ForgotPasswordDialog({
	open,
	initialEmail,
	onOpenChange
}: {
	open: boolean
	initialEmail: string
	onOpenChange: (open: boolean) => void
}) {
	const { t } = useTranslation("auth")
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
							disabled={pending || !isValidEmail(email)}
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
	const { t } = useTranslation("auth")
	const navigate = useNavigate()
	const [email, setEmail] = useState("")
	const [password, setPassword] = useState("")
	const [pending, setPending] = useState(false)
	const [twoFactorOpen, setTwoFactorOpen] = useState(false)
	const [twoFactorError, setTwoFactorError] = useState<string>()
	const [forgotOpen, setForgotOpen] = useState(false)

	// Shared by the first (code-less) attempt and every two-factor retry — the DTO's `kind` is the
	// only thing that differs between them. A failed attempt never destroys an existing worker client
	// (T1 guarantees this; nothing here compensates for it).
	async function attemptLogin(twoFactorCode?: string): Promise<void> {
		setPending(true)
		try {
			const trimmedEmail = email.trim()
			const blob = await sdkApi.login(
				twoFactorCode !== undefined ? { email: trimmedEmail, password, twoFactorCode } : { email: trimmedEmail, password }
			)
			setTwoFactorOpen(false)
			await persistSession(blob)
			broadcastAuth("login")
			await navigate({ to: "/drive" })
		} catch (e) {
			const dto = asErrorDTO(e)
			if (dto.kind === "Enter2fa" || dto.kind === "Wrong2fa") {
				// Enter2fa = first, code-less attempt (nothing to blame yet); Wrong2fa only ever arrives
				// on a retry that DID send a code, so it always gets the inline "wrong code" copy.
				setTwoFactorError(dto.kind === "Wrong2fa" ? t("twoFactorWrongCode") : undefined)
				setTwoFactorOpen(true)
			} else {
				setTwoFactorOpen(false)
				toast.error(errorLabel(dto))
			}
		} finally {
			setPending(false)
		}
	}

	const canSubmit = isValidEmail(email) && password.length > 0

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
				onOpenChange={setTwoFactorOpen}
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
