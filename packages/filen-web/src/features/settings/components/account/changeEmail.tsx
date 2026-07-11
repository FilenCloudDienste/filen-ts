import { useState, type SubmitEvent } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { sdkApi } from "@/lib/sdk/client"
import { persistSession, clearSession } from "@/lib/sdk/session"
import { asErrorDTO } from "@/lib/sdk/errors"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { isValidEmail } from "@/lib/validate"
import { runChangeEmailAttempt } from "@/features/settings/components/account/changeEmail.logic"
import type { AccountQuerySuccess } from "@/queries/account"
import { Card, CardContent, CardFooter, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"

interface ChangeEmailCardProps {
	accountQuery: AccountQuerySuccess
}

// New + confirm + password, same shape as ChangePasswordCard. Submit runs runChangeEmailAttempt
// (changeEmail.logic.ts), which mirrors that card's fingerprint re-sync law: it re-reads and
// re-persists the live client's session blob before this component does anything else with the
// result. SESSION-INVALIDATING (changes the login identity the harvested e2e session authenticates
// as) — never live-exercised in e2e, unit/render only.
function ChangeEmailCard({ accountQuery }: ChangeEmailCardProps) {
	const { t } = useTranslation("settings")
	const [newEmail, setNewEmail] = useState("")
	const [confirmEmail, setConfirmEmail] = useState("")
	const [password, setPassword] = useState("")
	const [pending, setPending] = useState(false)

	const emailsMatch = newEmail.length > 0 && newEmail === confirmEmail
	const canSubmit = emailsMatch && isValidEmail(newEmail) && password.length > 0

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
					setNewEmail("")
					setConfirmEmail("")
					setPassword("")
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
				<CardTitle>{t("settingsEmailTitle")}</CardTitle>
				<CardDescription>{t("settingsEmailDescription")}</CardDescription>
			</CardHeader>
			<CardContent>
				<p className="mb-4 text-sm text-muted-foreground">
					{t("settingsEmailCurrentLabel")}: <span className="text-foreground">{accountQuery.data.email}</span>
				</p>
				<form
					id="change-email-form"
					onSubmit={e => {
						void handleSubmit(e)
					}}
					className="flex flex-col gap-4"
				>
					<FieldGroup>
						<Field>
							<FieldLabel htmlFor="new-email">{t("settingsChangeEmailNew")}</FieldLabel>
							<Input
								id="new-email"
								type="email"
								autoComplete="email"
								value={newEmail}
								disabled={pending}
								onChange={e => {
									setNewEmail(e.target.value)
								}}
							/>
						</Field>
						<Field>
							<FieldLabel htmlFor="confirm-new-email">{t("settingsChangeEmailConfirm")}</FieldLabel>
							<Input
								id="confirm-new-email"
								type="email"
								autoComplete="email"
								value={confirmEmail}
								disabled={pending}
								onChange={e => {
									setConfirmEmail(e.target.value)
								}}
							/>
						</Field>
						<Field>
							<FieldLabel htmlFor="change-email-password">{t("settingsChangeEmailPassword")}</FieldLabel>
							<Input
								id="change-email-password"
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
				</form>
			</CardContent>
			<CardFooter>
				<Button
					type="submit"
					form="change-email-form"
					disabled={!canSubmit || pending}
				>
					{pending && <Spinner data-icon="inline-start" />}
					{t("settingsChangeEmailAction")}
				</Button>
			</CardFooter>
		</Card>
	)
}

export { ChangeEmailCard }
