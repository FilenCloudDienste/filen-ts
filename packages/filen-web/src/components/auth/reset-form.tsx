import { useState, type SubmitEvent } from "react"
import { useTranslation } from "react-i18next"
import { useNavigate } from "@tanstack/react-router"
import { toast } from "sonner"
import { ratePasswordStrength } from "@filen/utils"
import { sdkApi } from "@/lib/sdk/client"
import { persistSession, broadcastAuth } from "@/lib/sdk/session"
import { asErrorDTO } from "@/lib/sdk/errors"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { i18n } from "@/lib/i18n"
import { isValidEmail } from "@/lib/auth/validate"
import { runResetAttempt } from "@/lib/auth/reset-attempt"
import { Button } from "@/components/ui/button"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { ConfirmDialog } from "@/components/dialogs/confirm-dialog"
import { TypedConfirmDialog } from "@/components/dialogs/typed-confirm-dialog"
import { StrengthMeter } from "@/components/auth/strength-meter"
import { MasterKeysFileField } from "@/components/auth/master-keys-file-field"
import { advanceSkipMasterKeysChain, type SkipMasterKeysStage } from "@/components/auth/skip-master-keys-chain.logic"

interface ResetFormProps {
	token: string
}

// Reset-completion form. With a master-keys file chosen, submit runs the reset directly; without one,
// submit walks the full 4-stage skip-master-keys ceremony first (see skip-master-keys-chain.logic.ts)
// — cancelling at ANY stage aborts the submit entirely, it never falls back a stage. Both paths end in
// the same attemptReset call, with masterKeysFileText simply omitted on the ceremony path — matching
// completePasswordReset's own optional recoverKey param.
function ResetForm({ token }: ResetFormProps) {
	const { t } = useTranslation("auth")
	const navigate = useNavigate()
	const [email, setEmail] = useState("")
	const [password, setPassword] = useState("")
	const [confirmPassword, setConfirmPassword] = useState("")
	const [masterKeysFileText, setMasterKeysFileText] = useState<string>()
	const [pending, setPending] = useState(false)
	const [chainStage, setChainStage] = useState<SkipMasterKeysStage | null>(null)

	const trimmedEmail = email.trim()
	const passwordStrength = password.length > 0 ? ratePasswordStrength(password) : null
	const passwordsMatch = password.length > 0 && password === confirmPassword
	// Display-only gate parity with the register form: the meter is informational only, no minimum
	// tier is enforced.
	const canSubmit = isValidEmail(email) && passwordsMatch && passwordStrength !== null
	const cancelLabel = i18n.t("cancel")

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
					await navigate({ to: "/drive" })
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
	// its onOpenChange (confirmed=false) — see skip-master-keys-chain.logic.ts for the transition rules.
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
						/>
						{passwordStrength && <StrengthMeter tier={passwordStrength.strength} />}
					</Field>
					<Field>
						<FieldLabel htmlFor="reset-confirm-password">{t("resetConfirmPassword")}</FieldLabel>
						<Input
							id="reset-confirm-password"
							type="password"
							autoComplete="new-password"
							value={confirmPassword}
							onChange={e => {
								setConfirmPassword(e.target.value)
							}}
						/>
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
				body={t("skipMasterKeysWarningStage4Body", { email: trimmedEmail })}
				matchLabel={t("skipMasterKeysWarningTypedConfirmLabel")}
				matchValue={trimmedEmail}
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
