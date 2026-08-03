import { useState, type SubmitEvent } from "react"
import { useTranslation } from "react-i18next"
import { useNavigate } from "@tanstack/react-router"
import { toast } from "sonner"
import { ratePasswordStrength } from "@filen/utils"
import { sdkApi } from "@/lib/sdk/client"
import { persistSession, broadcastAuth } from "@/lib/sdk/session"
import { asErrorDTO } from "@/lib/sdk/errors"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { isValidEmail, isPasswordStrongEnough } from "@/lib/validate"
import { runResetAttempt } from "@/features/auth/lib/resetAttempt"
import { useCapsLock } from "@/features/auth/lib/useCapsLock"
import { useIsOnline } from "@/lib/useIsOnline"
import { Button } from "@/components/ui/button"
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { ConfirmDialog } from "@/components/dialogs/confirmDialog"
import { TypedConfirmDialog } from "@/components/dialogs/typedConfirmDialog"
import { StrengthMeter } from "@/features/auth/components/strengthMeter"
import { MasterKeysFileField } from "@/features/auth/components/masterKeysFileField"
import { advanceSkipMasterKeysChain, type SkipMasterKeysStage } from "@/features/auth/components/skipMasterKeysChain.logic"

interface ResetFormProps {
	token: string
}

// Reset-completion form. With a master-keys file chosen, submit runs the reset directly; without one,
// submit walks the full 4-stage skip-master-keys ceremony first (see skipMasterKeysChain.logic.ts)
// — cancelling at ANY stage aborts the submit entirely, it never falls back a stage. Both paths end in
// the same attemptReset call, with masterKeysFileText simply omitted on the ceremony path — matching
// completePasswordReset's own optional recoverKey param.
function ResetForm({ token }: ResetFormProps) {
	// Both namespaces bound: the ceremony's cancel button reuses the generic common:cancel — a
	// single-ns bound `t` rejects cross-namespace keys under the typed catalog.
	const { t } = useTranslation(["auth", "common"])
	const isOnline = useIsOnline()
	const navigate = useNavigate()
	const [email, setEmail] = useState("")
	const [password, setPassword] = useState("")
	const [confirmPassword, setConfirmPassword] = useState("")
	const [masterKeysFileText, setMasterKeysFileText] = useState<string>()
	const [pending, setPending] = useState(false)
	const [chainStage, setChainStage] = useState<SkipMasterKeysStage | null>(null)
	// Set once a two-factor account blocked the automatic sign-in — terminal, never a resubmit (the
	// token is already spent).
	const [signInRequired, setSignInRequired] = useState(false)
	const passwordCaps = useCapsLock()
	const confirmPasswordCaps = useCapsLock()

	const trimmedEmail = email.trim()
	const passwordStrength = password.length > 0 ? ratePasswordStrength(password) : null
	const passwordsMatch = password.length > 0 && password === confirmPassword
	// Inline, non-blocking feedback for why the submit button below is disabled — gated on the
	// confirm field actually having content so an untouched empty form never shows red text.
	const passwordsMismatched = confirmPassword.length > 0 && !passwordsMatch
	// Minimum-strength gate, shared with the register form via isPasswordStrongEnough (weak is the
	// only blocked tier — the meter's weak state explains why).
	const canSubmit = isValidEmail(email) && passwordsMatch && isPasswordStrongEnough(passwordStrength) && isOnline
	const cancelLabel = t("common:cancel")
	// Resolved ONCE: the stage-4 body copy ({{phrase}}) and its matchValue both read THIS string, so
	// the phrase the user is told to type and the phrase the input is checked against cannot drift.
	const typedConfirmPhrase = t("skipMasterKeysWarningTypedConfirmPhrase")

	// The single call site for both the direct (with-file) and ceremony (without-file) submit paths.
	async function attemptReset(masterKeys: string | undefined): Promise<void> {
		setPending(true)
		try {
			const outcome = await runResetAttempt(
				{
					completeReset: params =>
						sdkApi.completePasswordReset({
							token: params.token,
							email: params.email,
							newPassword: params.newPassword,
							// The ONLY place the SDK's recoverKey param name appears — everywhere else in this
							// app the concept is masterKeysFileText, never recoverKey/recoveryKey.
							...(params.masterKeysFileText !== undefined ? { recoverKey: params.masterKeysFileText } : {})
						}),
					persist: persistSession,
					broadcast: () => {
						broadcastAuth("login")
					}
				},
				{
					token,
					email: trimmedEmail,
					newPassword: password,
					...(masterKeys !== undefined ? { masterKeysFileText: masterKeys } : {})
				}
			)
			switch (outcome.status) {
				case "success":
					setChainStage(null)
					if (!outcome.persisted) {
						toast.warning(t("sessionPersistFailed"))
					}
					await navigate({ to: "/drive/$", params: { _splat: "" } })
					break
				case "two-factor-terminal":
					// The reset landed; only the automatic sign-in didn't. Close the ceremony and replace the
					// form — re-submitting would re-post the reset with a spent token.
					setChainStage(null)
					setSignInRequired(true)
					break
				case "error":
					// Expired/invalid token arrives as a generic server error here — LABEL-FIRST surfaces its
					// serverMessage; a rejected master-keys file gets errors.ts's mapped BadRecoveryKey label.
					toast.error(errorLabel(outcome.dto))
					break
			}
		} catch (e) {
			toast.error(errorLabel(asErrorDTO(e)))
		} finally {
			setPending(false)
		}
	}

	// Fires from a ceremony dialog's onConfirm (confirmed=true) or any dismissal route funneled through
	// its onOpenChange (confirmed=false) — see skipMasterKeysChain.logic.ts for the transition rules.
	function handleStageOutcome(stage: SkipMasterKeysStage, confirmed: boolean): void {
		const outcome = advanceSkipMasterKeysChain(stage, confirmed)
		switch (outcome.status) {
			case "aborted":
				setChainStage(null)
				break
			case "advance":
				setChainStage(outcome.stage)
				break
			case "complete":
				// Stays on stage4 — its own `pending` prop now gates it, so a failed attempt surfaces its
				// error there and stays open to retry, mirroring the forgot-password dialog's pattern.
				void attemptReset(undefined)
				break
		}
	}

	function handleSubmit(e: SubmitEvent): void {
		e.preventDefault()
		if (!canSubmit) {
			return
		}
		if (masterKeysFileText !== undefined) {
			void attemptReset(masterKeysFileText)
		} else {
			setChainStage("stage1")
		}
	}

	// Replaces the form outright, and deliberately does NOT toast: this panel is the only place the user
	// learns what became of their reset, and a toast is dismissible.
	if (signInRequired) {
		return (
			<div className="flex flex-col gap-4 text-center">
				<p className="text-sm font-medium">{t("resetTwoFactorSignInTitle")}</p>
				<p className="text-sm text-muted-foreground">{t("resetTwoFactorSignInBody")}</p>
				<Button
					type="button"
					className="w-full"
					onClick={() => {
						void navigate({ to: "/login" })
					}}
				>
					{t("resetGoToSignIn")}
				</Button>
			</div>
		)
	}

	return (
		<div className="flex flex-col gap-6">
			<form
				onSubmit={handleSubmit}
				className="flex flex-col gap-6"
			>
				<FieldGroup>
					<Field>
						<FieldLabel htmlFor="reset-email">{t("resetEmail")}</FieldLabel>
						<Input
							id="reset-email"
							type="email"
							autoComplete="email"
							value={email}
							onChange={e => {
								setEmail(e.target.value)
							}}
						/>
					</Field>
					<Field>
						<FieldLabel htmlFor="reset-new-password">{t("resetNewPassword")}</FieldLabel>
						<Input
							id="reset-new-password"
							type="password"
							autoComplete="new-password"
							value={password}
							onChange={e => {
								setPassword(e.target.value)
							}}
							onKeyDown={passwordCaps.onKeyDown}
							onKeyUp={passwordCaps.onKeyUp}
							onBlur={passwordCaps.onBlur}
						/>
						{passwordStrength && <StrengthMeter tier={passwordStrength.strength} />}
						{/* Rendered unconditionally with only its TEXT toggled: a live region must already be in
						    the a11y tree when its content changes, so an already-populated role=status inserted
						    on demand is commonly missed by screen readers. Empty <p> collapses to zero height. */}
						<p
							role="status"
							className="text-xs text-yellow-500"
						>
							{passwordCaps.capsLockOn ? t("capsLockOn") : ""}
						</p>
					</Field>
					<Field>
						<FieldLabel htmlFor="reset-confirm-password">{t("resetConfirmPassword")}</FieldLabel>
						<Input
							id="reset-confirm-password"
							type="password"
							autoComplete="new-password"
							aria-invalid={passwordsMismatched}
							// Same condition the error below renders on — a describedby pointing at an id that is
							// not in the document describes nothing.
							aria-describedby={passwordsMismatched ? "reset-confirm-password-error" : undefined}
							value={confirmPassword}
							onChange={e => {
								setConfirmPassword(e.target.value)
							}}
							onKeyDown={confirmPasswordCaps.onKeyDown}
							onKeyUp={confirmPasswordCaps.onKeyUp}
							onBlur={confirmPasswordCaps.onBlur}
						/>
						{passwordsMismatched && <FieldError id="reset-confirm-password-error">{t("passwordsDoNotMatch")}</FieldError>}
						<p
							role="status"
							className="text-xs text-yellow-500"
						>
							{confirmPasswordCaps.capsLockOn ? t("capsLockOn") : ""}
						</p>
					</Field>
					<MasterKeysFileField
						disabled={pending}
						onChange={setMasterKeysFileText}
					/>
				</FieldGroup>
				<Button
					type="submit"
					className="w-full"
					disabled={!canSubmit || pending}
					title={!isOnline ? t("common:offlineActionDisabled") : undefined}
				>
					{pending && <Spinner data-icon="inline-start" />}
					{t("resetSubmit")}
				</Button>
			</form>

			<ConfirmDialog
				open={chainStage === "stage1"}
				pending={false}
				title={t("skipMasterKeysWarningStage1Title")}
				body={t("skipMasterKeysWarningStage1Body")}
				confirmLabel={t("skipMasterKeysWarningStage1Continue")}
				cancelLabel={cancelLabel}
				destructive
				onOpenChange={open => {
					if (!open) {
						handleStageOutcome("stage1", false)
					}
				}}
				onConfirm={() => {
					handleStageOutcome("stage1", true)
				}}
			/>
			<ConfirmDialog
				open={chainStage === "stage2"}
				pending={false}
				title={t("skipMasterKeysWarningStage2Title")}
				body={t("skipMasterKeysWarningStage2Body")}
				confirmLabel={t("skipMasterKeysWarningStage2Continue")}
				cancelLabel={cancelLabel}
				destructive
				onOpenChange={open => {
					if (!open) {
						handleStageOutcome("stage2", false)
					}
				}}
				onConfirm={() => {
					handleStageOutcome("stage2", true)
				}}
			/>
			<ConfirmDialog
				open={chainStage === "stage3"}
				pending={false}
				title={t("skipMasterKeysWarningStage3Title")}
				body={t("skipMasterKeysWarningStage3Body")}
				confirmLabel={t("skipMasterKeysWarningStage3Continue")}
				cancelLabel={cancelLabel}
				destructive
				onOpenChange={open => {
					if (!open) {
						handleStageOutcome("stage3", false)
					}
				}}
				onConfirm={() => {
					handleStageOutcome("stage3", true)
				}}
			/>
			<TypedConfirmDialog
				open={chainStage === "stage4"}
				pending={pending}
				title={t("skipMasterKeysWarningStage4Title")}
				body={t("skipMasterKeysWarningStage4Body", { phrase: typedConfirmPhrase })}
				matchLabel={t("skipMasterKeysWarningTypedConfirmLabel")}
				matchValue={typedConfirmPhrase}
				confirmLabel={t("skipMasterKeysWarningStage4Confirm")}
				cancelLabel={cancelLabel}
				destructive
				onOpenChange={open => {
					if (!open) {
						handleStageOutcome("stage4", false)
					}
				}}
				onConfirm={() => {
					handleStageOutcome("stage4", true)
				}}
			/>
		</div>
	)
}

export { ResetForm }
