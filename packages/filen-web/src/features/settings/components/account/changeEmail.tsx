import { useState, type SubmitEvent } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { isValidEmail } from "@filen/shared"
import { sdkApi } from "@/lib/sdk/client"
import { persistSession, clearSession } from "@/lib/sdk/session"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { runChangeEmailAttempt } from "@/features/settings/components/account/changeEmail.logic"
import { useIsOnline } from "@/lib/useIsOnline"
import type { AccountQuerySuccess } from "@/queries/account"
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { PasswordInput } from "@/features/auth/components/passwordInput"
import { SettingsRow } from "@/features/settings/components/settingsLayout"
import { FormDialog } from "@/components/dialogs/formDialog"

interface ChangeEmailRowProps {
	accountQuery: AccountQuerySuccess
}

// New + confirm + password in a dialog, same shape as ChangePasswordRow. Submit runs
// runChangeEmailAttempt (changeEmail.logic.ts), which mirrors that row's fingerprint re-sync law: it
// re-reads and re-persists the live client's session blob before this component does anything else
// with the result. SESSION-INVALIDATING (changes the login identity the harvested e2e session
// authenticates as) — never live-exercised in e2e, unit/render only.
function ChangeEmailRow({ accountQuery }: ChangeEmailRowProps) {
	const { t } = useTranslation(["settings", "common"])
	const isOnline = useIsOnline()
	const [open, setOpen] = useState(false)
	const [newEmail, setNewEmail] = useState("")
	const [confirmEmail, setConfirmEmail] = useState("")
	const [password, setPassword] = useState("")
	const [pending, setPending] = useState(false)

	const emailsMatch = newEmail.length > 0 && newEmail === confirmEmail
	const canSubmit = emailsMatch && isValidEmail(newEmail) && password.length > 0 && isOnline
	// Inline, non-blocking feedback for why the submit button below is disabled — both gated on the
	// field actually having content so an untouched empty form never shows red text on first render.
	const newEmailInvalid = newEmail.length > 0 && !isValidEmail(newEmail)
	const confirmEmailMismatched = confirmEmail.length > 0 && !emailsMatch

	// A dismissed form never keeps a typed password around, nor resurfaces a stale draft on reopen.
	function close(): void {
		setOpen(false)
		setNewEmail("")
		setConfirmEmail("")
		setPassword("")
	}

	async function handleSubmit(e: SubmitEvent): Promise<void> {
		e.preventDefault()

		if (!canSubmit) {
			return
		}

		setPending(true)

		try {
			const outcome = await runChangeEmailAttempt(
				{
					changeEmail: params => sdkApi.changeEmail(params.password, params.newEmail),
					toStringified: () => sdkApi.toStringified(),
					persist: persistSession,
					clearSession
				},
				{ password, newEmail: newEmail.trim() }
			)

			switch (outcome.status) {
				case "success":
					if (!outcome.persisted) {
						toast.warning(t("settingsChangeEmailPersistFailed"))
					}
					toast.success(t("settingsChangeEmailSuccess"))
					close()
					void accountQuery.refetch()
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
			label={t("settingsEmailTitle")}
			description={accountQuery.data.email}
		>
			<Button
				type="button"
				variant="outline"
				aria-label={t("settingsChangeEmailAction")}
				onClick={() => {
					setOpen(true)
				}}
			>
				{t("settingsRowChangeAction")}
			</Button>
			<FormDialog
				open={open}
				pending={pending}
				title={t("settingsChangeEmailAction")}
				description={t("settingsEmailDescription")}
				submitLabel={t("settingsChangeEmailAction")}
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
						<FieldLabel htmlFor="new-email">{t("settingsChangeEmailNew")}</FieldLabel>
						<Input
							id="new-email"
							type="email"
							autoComplete="email"
							aria-invalid={newEmailInvalid}
							// Same condition the error below renders on — a describedby pointing at an id that
							// is not in the document describes nothing.
							aria-describedby={newEmailInvalid ? "new-email-error" : undefined}
							value={newEmail}
							disabled={pending}
							onChange={e => {
								setNewEmail(e.target.value)
							}}
						/>
						{newEmailInvalid && <FieldError id="new-email-error">{t("settingsChangeEmailInvalid")}</FieldError>}
					</Field>
					<Field>
						<FieldLabel htmlFor="confirm-new-email">{t("settingsChangeEmailConfirm")}</FieldLabel>
						<Input
							id="confirm-new-email"
							type="email"
							autoComplete="email"
							aria-invalid={confirmEmailMismatched}
							aria-describedby={confirmEmailMismatched ? "confirm-new-email-error" : undefined}
							value={confirmEmail}
							disabled={pending}
							onChange={e => {
								setConfirmEmail(e.target.value)
							}}
						/>
						{confirmEmailMismatched && <FieldError id="confirm-new-email-error">{t("settingsChangeEmailMismatch")}</FieldError>}
					</Field>
					<Field>
						<FieldLabel htmlFor="change-email-password">{t("settingsChangeEmailPassword")}</FieldLabel>
						<PasswordInput
							id="change-email-password"
							autoComplete="current-password"
							value={password}
							disabled={pending}
							onChange={e => {
								setPassword(e.target.value)
							}}
						/>
					</Field>
				</FieldGroup>
			</FormDialog>
		</SettingsRow>
	)
}

export { ChangeEmailRow }
