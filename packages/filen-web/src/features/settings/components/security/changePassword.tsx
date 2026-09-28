import { useState, type SubmitEvent } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { isPasswordStrongEnough, ratePasswordStrength } from "@filen/shared"
import { sdkApi } from "@/lib/sdk/client"
import { persistSession, clearSession } from "@/lib/sdk/session"
import { asErrorDTO } from "@/lib/sdk/errors"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { runChangePasswordAttempt } from "@/features/settings/components/security/changePassword.logic"
import { useCapsLock } from "@/features/auth/lib/useCapsLock"
import { useIsOnline } from "@/lib/useIsOnline"
import type { AccountQuerySuccess } from "@/queries/account"
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { StrengthMeter } from "@/features/auth/components/strengthMeter"
import { CapsLockWarning } from "@/features/auth/components/capsLockWarning"
import { SettingsRow } from "@/features/settings/components/settingsLayout"
import { FormDialog } from "@/components/dialogs/formDialog"

interface ChangePasswordRowProps {
	accountQuery: AccountQuerySuccess
}

// Current + new + confirm in a dialog, gated on the same minimum-strength rule as register/reset
// (isPasswordStrongEnough — weak is the only blocked tier). Submit runs runChangePasswordAttempt
// (changePassword.logic.ts), which owns the fingerprint re-sync law: it persists the
// RETURNED, post-mutation session blob before this component does anything else with the result.
function ChangePasswordRow({ accountQuery }: ChangePasswordRowProps) {
	const { t } = useTranslation(["auth", "settings", "common"])
	const isOnline = useIsOnline()
	const [open, setOpen] = useState(false)
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
						<CapsLockWarning active={currentPasswordCaps.capsLockOn} />
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
						<CapsLockWarning active={newPasswordCaps.capsLockOn} />
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
						<CapsLockWarning active={confirmPasswordCaps.capsLockOn} />
					</Field>
				</FieldGroup>
			</FormDialog>
		</SettingsRow>
	)
}

export { ChangePasswordRow }
