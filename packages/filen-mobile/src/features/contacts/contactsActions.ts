import { type TFunction } from "i18next"
import { runWithLoading } from "@/components/ui/fullScreenLoadingModal"
import alerts from "@/lib/alerts"
import prompts from "@/lib/prompts"
import contacts from "@/features/contacts/contacts"
import { run } from "@filen/utils"

/**
 * Prompt the user for a Filen email address and send a contact request.
 * Used by the header menu "add" item and the empty-state CTA — keep in sync.
 */
export async function addContactFlow({ t }: { t: TFunction }): Promise<void> {
	const promptResult = await run(async () => {
		return await prompts.input({
			title: t("add_contact"),
			message: t("enter_contact_filen_email"),
			cancelText: t("cancel"),
			okText: t("add")
		})
	})

	if (!promptResult.success) {
		console.error(promptResult.error)
		alerts.error(promptResult.error)

		return
	}

	if (promptResult.data.cancelled || promptResult.data.type !== "string") {
		return
	}

	const email = promptResult.data.value.trim()

	if (email.length === 0) {
		return
	}

	const result = await runWithLoading(async () => {
		await contacts.sendRequest({ email })
	})

	if (!result.success) {
		console.error(result.error)
		alerts.error(result.error)
	}
}
