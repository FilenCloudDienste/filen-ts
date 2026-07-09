import { useState, type SubmitEvent } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { ratePasswordStrength } from "@filen/utils"
import { sdkApi } from "@/lib/sdk/client"
import { asErrorDTO } from "@/lib/sdk/errors"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { isValidEmail, isPasswordStrongEnough } from "@/lib/validate"
import { getReferral } from "@/features/auth/lib/referral"
import { useRegisterCheckQuery } from "@/features/auth/queries/registerCheck"
import { Button } from "@/components/ui/button"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { StrengthMeter } from "@/features/auth/components/strengthMeter"

const REGISTER_CHECK_LEARN_MORE_URL = "https://filen.io/hub/free-10-gb-at-signup-eligibility-check-before-creating-an-account/"

// Self-contained: decides on its own whether it has anything to show, so the form never needs to
// know the query exists. Renders only on POSITIVE eligibility — a failed check and a genuine
// ineligible result collapse to the same "show nothing" outcome (see register-check.ts), so this
// never asserts a negative the check couldn't actually confirm.
function EligibilityBanner() {
	const { t } = useTranslation("auth")
	const registerCheckQuery = useRegisterCheckQuery()

	if (!registerCheckQuery.data?.ok) {
		return null
	}

	return (
		<div className="flex items-center gap-3 rounded-2xl bg-muted px-3 py-2 text-sm">
			<p className="flex-1">{t("registerCheckEligible")}</p>
			<a
				href={REGISTER_CHECK_LEARN_MORE_URL}
				target="_blank"
				rel="noreferrer"
				className="shrink-0 text-primary underline-offset-4 hover:underline"
			>
				{t("registerCheckLearnMore")}
			</a>
		</div>
	)
}

function RegisterForm() {
	const { t } = useTranslation("auth")
	const [email, setEmail] = useState("")
	const [password, setPassword] = useState("")
	const [confirmPassword, setConfirmPassword] = useState("")
	const [pending, setPending] = useState(false)
	const [resendPending, setResendPending] = useState(false)
	const [registered, setRegistered] = useState(false)

	const emailValid = isValidEmail(email)
	const passwordStrength = password.length > 0 ? ratePasswordStrength(password) : null
	const passwordsMatch = password.length > 0 && password === confirmPassword
	// Minimum-strength gate, shared with the reset form via isPasswordStrongEnough (weak is the only
	// blocked tier — the meter's weak state explains why). No `isOnline` term: this slice ships no
	// connectivity infra, a real network failure surfaces as the SDK's own error toast instead.
	const canSubmit = emailValid && passwordsMatch && isPasswordStrongEnough(passwordStrength)

	async function handleSubmit(e: SubmitEvent): Promise<void> {
		e.preventDefault()

		if (!canSubmit) {
			return
		}

		setPending(true)

		try {
			await sdkApi.register({
				email: email.trim(),
				password,
				...getReferral()
			})
			setRegistered(true)
		} catch (err) {
			toast.error(errorLabel(asErrorDTO(err)))
		} finally {
			setPending(false)
		}
	}

	async function handleResend(): Promise<void> {
		setResendPending(true)

		try {
			await sdkApi.resendRegistrationConfirmation(email.trim())
			// Non-revealing by design: fires on ANY resolve, never confirming account existence or
			// confirmation status.
			toast.success(t("resendConfirmationSent"))
		} catch (err) {
			// A network/server failure is not "email sent" — LABEL-FIRST.
			toast.error(errorLabel(asErrorDTO(err)))
		} finally {
			setResendPending(false)
		}
	}

	if (registered) {
		return (
			<div className="flex flex-col items-center gap-4 text-center">
				<p className="text-sm text-muted-foreground">{t("accountCreatedCheckEmail")}</p>
				<Button
					type="button"
					variant="outline"
					className="w-full"
					disabled={resendPending}
					onClick={() => {
						void handleResend()
					}}
				>
					{resendPending && <Spinner data-icon="inline-start" />}
					{t("resendConfirmation")}
				</Button>
			</div>
		)
	}

	return (
		<div className="flex flex-col gap-6">
			<form
				onSubmit={e => {
					void handleSubmit(e)
				}}
				className="flex flex-col gap-6"
			>
				<FieldGroup>
					<Field>
						<FieldLabel htmlFor="register-email">{t("registerEmail")}</FieldLabel>
						<Input
							id="register-email"
							type="email"
							autoComplete="email"
							placeholder={t("registerEmailPlaceholder")}
							value={email}
							onChange={e => {
								setEmail(e.target.value)
							}}
						/>
					</Field>
					<Field>
						<FieldLabel htmlFor="register-password">{t("registerPassword")}</FieldLabel>
						<Input
							id="register-password"
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
						<FieldLabel htmlFor="register-confirm-password">{t("registerConfirmPassword")}</FieldLabel>
						<Input
							id="register-confirm-password"
							type="password"
							autoComplete="new-password"
							value={confirmPassword}
							onChange={e => {
								setConfirmPassword(e.target.value)
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
					{t("registerSubmit")}
				</Button>
			</form>
			<EligibilityBanner />
		</div>
	)
}

export { RegisterForm }
