import { isValidEmail } from "@filen/shared"
import { type TFunction } from "i18next"
import alerts from "@/lib/alerts"
import { inputPrompt } from "@/lib/promptFlow"
import { runWithLoading } from "@/components/ui/fullScreenLoadingModal"
import logger from "@/lib/logger"

// Prompts for an account email (prefilled), validates it, runs `action` behind the loader and toasts on success.
export async function promptEmailAndRun({
	t,
	title,
	message,
	okText,
	defaultValue,
	logLabel,
	action,
	successMessage
}: {
	t: TFunction
	title: string
	message: string
	okText: string
	defaultValue: string
	logLabel: string
	action: (email: string) => Promise<void>
	successMessage: string
}): Promise<void> {
	const targetEmail = await inputPrompt(
		{
			title,
			message,
			placeholder: t("email_placeholder_hint"),
			cancelText: t("cancel"),
			okText,
			defaultValue,
			keyboardType: "email-address"
		},
		{ tag: "auth", message: `${logLabel} prompt failed` },
		{ trim: true, allowEmpty: true }
	)

	if (targetEmail === null) {
		return
	}

	if (!isValidEmail(targetEmail)) {
		alerts.error(t("please_enter_valid_email"))

		return
	}

	const result = await runWithLoading(async () => {
		await action(targetEmail)
	})

	if (!result.success) {
		logger.warn("auth", `${logLabel} failed`, { error: result.error })
		alerts.error(result.error)

		return
	}

	alerts.normal(successMessage)
}
