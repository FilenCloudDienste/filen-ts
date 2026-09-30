import { useState, type SubmitEvent } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { isPasswordStrongEnough, ratePasswordStrength } from "@filen/shared"
import { sdkApi } from "@/lib/sdk/client"
import { persistSession, clearSession } from "@/lib/sdk/session"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { runChangePasswordAttempt } from "@/features/settings/components/security/changePassword.logic"
import { useIsOnline } from "@/lib/useIsOnline"
import { markAccountStale } from "@/queries/account"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Button } from "@/components/ui/button"
import { StrengthMeter } from "@/features/auth/components/strengthMeter"
import { PasswordInput } from "@/features/auth/components/passwordInput"
import { SettingsRow } from "@/features/settings/components/settingsLayout"
import { FormDialog } from "@/components/dialogs/formDialog"

// Current + new + confirm in a dialog, gated on the same minimum-strength rule as register/reset
// (isPasswordStrongEnough — weak is the only blocked tier). Submit runs runChangePasswordAttempt
// (changePassword.logic.ts), which owns the fingerprint re-sync law: it persists the
// RETURNED, post-mutation session blob before this component does anything else with the result.
function ChangePasswordRow() {
	const { t } = useTranslation(["auth", "settings", "common"])
	const isOnline = useIsOnline()
	const [open, setOpen] = useState(false)
	const [currentPassword, setCurrentPassword] = useState("")
	const [newPassword, setNewPassword] = useState("")
	const [confirmPassword, setConfirmPassword] = useState("")
	const [pending, setPending] = useState(false)

	const passwordStrength = newPassword.length > 0 ? ratePasswordStrength(newPassword) : null
	const passwordsMatch = newPassword.length > 0 && newPassword === confirmPassword
	// Inline, non-blocking feedback for why the submit button below is disabled — gated on the
	// confirm field actually having content so an untouched empty form never shows red text.
	const passwordsMismatched = confirmPassword.length > 0 && !passwordsMatch
	const canSubmit = currentPassword.length > 0 && passwordsMatch && isPasswordStrongEnough(passwordStrength) && isOnline

	// A dismissed form never keeps a typed password around, nor resurfaces a stale draft on reopen.
	function close(): void {
		setOpen(false)
		setCurrentPassword("")
		setNewPassword("")
		setConfirmPassword("")
	}

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
					close()
					// Stale, not read now: the API can transiently report Unauthenticated right after a
					// password change (a known SDK-side race), and a failed read here would put the whole
					// page in its error state. The next focus or mount reads whatever the change touched.
					markAccountStale()
					break
				case "error":
					toast.error(errorLabel(outcome.dto))
					break
			}
		} catch (e) {
			toast.error(errorLabel(e))
		} finally {
			setPending(false)
		}
	}

	return (
		<SettingsRow
			label={t("settings:settingsPasswordRowTitle")}
			description={t("changePasswordDescription")}
		>
			<Button
				type="button"
				variant="outline"
				aria-label={t("changePasswordTitle")}
				onClick={() => {
					setOpen(true)
				}}
			>
				{t("settings:settingsRowChangeAction")}
			</Button>
			<FormDialog
				open={open}
				pending={pending}
				title={t("changePasswordTitle")}
				description={t("changePasswordDescription")}
				submitLabel={t("changePasswordSubmit")}
				cancelLabel={t("common:cancel")}
				canSubmit={canSubmit}
				submitTitle={!isOnline ? t("common:offlineActionDisabled") : undefined}
				onOpenChange={next => {
					if (!next) {
						close()
					}
				}}
				onSubmit={e => {
					void handleSubmit(e)
				}}
			>
				<FieldGroup>
					<Field>
						<FieldLabel htmlFor="current-password">{t("changePasswordCurrent")}</FieldLabel>
						<PasswordInput
							id="current-password"
							autoComplete="current-password"
							value={currentPassword}
							disabled={pending}
							onChange={e => {
								setCurrentPassword(e.target.value)
							}}
						/>
					</Field>
					<Field>
						<FieldLabel htmlFor="new-password">{t("changePasswordNew")}</FieldLabel>
						<PasswordInput
							id="new-password"
							autoComplete="new-password"
							value={newPassword}
							disabled={pending}
							onChange={e => {
								setNewPassword(e.target.value)
							}}
						>
							{passwordStrength && <StrengthMeter tier={passwordStrength} />}
						</PasswordInput>
					</Field>
					<Field>
						<FieldLabel htmlFor="confirm-new-password">{t("changePasswordConfirm")}</FieldLabel>
						<PasswordInput
							id="confirm-new-password"
							error={passwordsMismatched && t("passwordsDoNotMatch")}
							autoComplete="new-password"
							value={confirmPassword}
							disabled={pending}
							onChange={e => {
								setConfirmPassword(e.target.value)
							}}
						/>
					</Field>
				</FieldGroup>
			</FormDialog>
		</SettingsRow>
	)
}

export { ChangePasswordRow }
