import { useState, type SubmitEvent } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { ratePasswordStrength } from "@filen/utils"
import { sdkApi } from "@/lib/sdk/client"
import { persistSession, clearSession } from "@/lib/sdk/session"
import { asErrorDTO } from "@/lib/sdk/errors"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { isPasswordStrongEnough } from "@/lib/validate"
import { runChangePasswordAttempt } from "@/features/settings/components/security/changePassword.logic"
import { useCapsLock } from "@/features/auth/lib/useCapsLock"
import { useIsOnline } from "@/lib/useIsOnline"
import type { AccountQuerySuccess } from "@/queries/account"
import { Card, CardContent, CardFooter, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { StrengthMeter } from "@/features/auth/components/strengthMeter"

interface ChangePasswordCardProps {
	accountQuery: AccountQuerySuccess
}

// Current + new + confirm, gated on the same minimum-strength rule as register/reset
// (isPasswordStrongEnough — weak is the only blocked tier). Submit runs runChangePasswordAttempt
// (changePassword.logic.ts), which owns the fingerprint re-sync law: it persists the
// RETURNED, post-mutation session blob before this component does anything else with the result.
function ChangePasswordCard({ accountQuery }: ChangePasswordCardProps) {
	const { t } = useTranslation(["auth", "common"])
	const isOnline = useIsOnline()
	const [currentPassword, setCurrentPassword] = useState("")
	const [newPassword, setNewPassword] = useState("")
	const [confirmPassword, setConfirmPassword] = useState("")
	const [pending, setPending] = useState(false)
	const currentPasswordCaps = useCapsLock()
	const newPasswordCaps = useCapsLock()
	const confirmPasswordCaps = useCapsLock()

	const passwordStrength = newPassword.length > 0 ? ratePasswordStrength(newPassword) : null
	const passwordsMatch = newPassword.length > 0 && newPassword === confirmPassword
	// Inline, non-blocking feedback for why the submit button below is disabled — gated on the
	// confirm field actually having content so an untouched empty form never shows red text.
	const passwordsMismatched = confirmPassword.length > 0 && !passwordsMatch
	const canSubmit = currentPassword.length > 0 && passwordsMatch && isPasswordStrongEnough(passwordStrength) && isOnline

	async function handleSubmit(e: SubmitEvent): Promise<void> {
		e.preventDefault()

		if (!canSubmit) {
			return
		}

		setPending(true)

		try {
			const outcome = await runChangePasswordAttempt(
				{
					changePassword: params => sdkApi.changePassword(params),
					persist: persistSession,
					clearSession
				},
				{ currentPassword, newPassword }
			)

			switch (outcome.status) {
				case "success":
					if (!outcome.persisted) {
						toast.warning(t("changePasswordPersistFailed"))
					}
					toast.success(t("changePasswordSuccess"))
					setCurrentPassword("")
					setNewPassword("")
					setConfirmPassword("")
					// Best-effort: the API can transiently report Unauthenticated right after a password
					// change (a known SDK-side race, not a real failure). A genuine, lasting failure
					// surfaces through this SAME query's own error state elsewhere on the page via the
					// global query-cache error log (queries/client.ts) — never an auto-logout triggered
					// from here.
					void accountQuery.refetch()
					break
				case "error":
					toast.error(errorLabel(outcome.dto))
					break
			}
		} catch (e) {
			toast.error(errorLabel(asErrorDTO(e)))
		} finally {
			setPending(false)
		}
	}

	return (
		<Card>
			<CardHeader>
				<CardTitle>{t("changePasswordTitle")}</CardTitle>
				<CardDescription>{t("changePasswordDescription")}</CardDescription>
			</CardHeader>
			<CardContent>
				<form
					id="change-password-form"
					onSubmit={e => {
						void handleSubmit(e)
					}}
					className="flex flex-col gap-4"
				>
					<FieldGroup>
						<Field>
							<FieldLabel htmlFor="current-password">{t("changePasswordCurrent")}</FieldLabel>
							<Input
								id="current-password"
								type="password"
								autoComplete="current-password"
								value={currentPassword}
								disabled={pending}
								onChange={e => {
									setCurrentPassword(e.target.value)
								}}
								onKeyDown={currentPasswordCaps.onKeyDown}
								onKeyUp={currentPasswordCaps.onKeyUp}
								onBlur={currentPasswordCaps.onBlur}
							/>
							{/* Rendered unconditionally with only its TEXT toggled: a live region must already be in
							    the a11y tree when its content changes, so an already-populated role=status inserted
							    on demand is commonly missed by screen readers. Empty <p> collapses to zero height. */}
							<p
								role="status"
								className="text-xs text-yellow-500"
							>
								{currentPasswordCaps.capsLockOn ? t("capsLockOn") : ""}
							</p>
						</Field>
						<Field>
							<FieldLabel htmlFor="new-password">{t("changePasswordNew")}</FieldLabel>
							<Input
								id="new-password"
								type="password"
								autoComplete="new-password"
								value={newPassword}
								disabled={pending}
								onChange={e => {
									setNewPassword(e.target.value)
								}}
								onKeyDown={newPasswordCaps.onKeyDown}
								onKeyUp={newPasswordCaps.onKeyUp}
								onBlur={newPasswordCaps.onBlur}
							/>
							{passwordStrength && <StrengthMeter tier={passwordStrength.strength} />}
							<p
								role="status"
								className="text-xs text-yellow-500"
							>
								{newPasswordCaps.capsLockOn ? t("capsLockOn") : ""}
							</p>
						</Field>
						<Field>
							<FieldLabel htmlFor="confirm-new-password">{t("changePasswordConfirm")}</FieldLabel>
							<Input
								id="confirm-new-password"
								type="password"
								autoComplete="new-password"
								aria-invalid={passwordsMismatched}
								// Same condition the error below renders on — a describedby pointing at an id that
								// is not in the document describes nothing.
								aria-describedby={passwordsMismatched ? "confirm-new-password-error" : undefined}
								value={confirmPassword}
								disabled={pending}
								onChange={e => {
									setConfirmPassword(e.target.value)
								}}
								onKeyDown={confirmPasswordCaps.onKeyDown}
								onKeyUp={confirmPasswordCaps.onKeyUp}
								onBlur={confirmPasswordCaps.onBlur}
							/>
							{passwordsMismatched && <FieldError id="confirm-new-password-error">{t("passwordsDoNotMatch")}</FieldError>}
							<p
								role="status"
								className="text-xs text-yellow-500"
							>
								{confirmPasswordCaps.capsLockOn ? t("capsLockOn") : ""}
							</p>
						</Field>
					</FieldGroup>
				</form>
			</CardContent>
			<CardFooter>
				<Button
					type="submit"
					form="change-password-form"
					disabled={!canSubmit || pending}
					title={!isOnline ? t("common:offlineActionDisabled") : undefined}
				>
					{pending && <Spinner data-icon="inline-start" />}
					{t("changePasswordSubmit")}
				</Button>
			</CardFooter>
		</Card>
	)
}

export { ChangePasswordCard }
