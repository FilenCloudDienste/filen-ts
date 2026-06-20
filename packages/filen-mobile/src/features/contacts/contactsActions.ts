import { type TFunction } from "i18next"
import { runWithLoading } from "@/components/ui/fullScreenLoadingModal"
import alerts from "@/lib/alerts"
import prompts from "@/lib/prompts"
import contacts from "@/features/contacts/contacts"
import { run } from "@filen/utils"
import { type MenuButton } from "@/components/ui/menu"
import logger from "@/lib/logger"

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
		logger.warn("contacts", "addContactFlow prompt failed", { error: promptResult.error })
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
		logger.error("contacts", "sendRequest failed", { email, error: result.error })
		alerts.error(result.error)
	}
}

/**
 * Builds a Block or Unblock menu action for a user identified by id + email, usable from any
 * participant row (chat / note). `blockedUuid` is required to unblock (the BlockedContact uuid).
 * `timestamp` is cosmetic (blocked-list sort order) and self-heals on the next contacts refetch.
 */
export function buildBlockToggleMenuAction(params: {
	t: TFunction
	isBlocked: boolean
	blockedUuid: string | undefined
	userId: bigint
	email: string
	avatar: string | undefined
	nickName: string | undefined
	timestamp: bigint
}): MenuButton {
	const { t, isBlocked, blockedUuid, userId, email, avatar, nickName, timestamp } = params

	if (isBlocked) {
		return {
			id: "unblock",
			title: t("unblock"),
			icon: "restore",
			requiresOnline: true,
			onPress: async () => {
				if (!blockedUuid) {
					return
				}

				const promptResponse = await run(async () => {
					return await prompts.alert({
						title: t("unblock_contact"),
						message: t("unblock_contact_confirmation"),
						cancelText: t("cancel"),
						okText: t("unblock")
					})
				})

				if (!promptResponse.success) {
					logger.warn("contacts", "unblock confirmation prompt failed", { error: promptResponse.error })
					alerts.error(promptResponse.error)

					return
				}

				if (promptResponse.data.cancelled) {
					return
				}

				const result = await runWithLoading(async () => {
					await contacts.unblock({
						uuid: blockedUuid
					})
				})

				if (!result.success) {
					logger.error("contacts", "unblock failed", { blockedUuid, error: result.error })
					alerts.error(result.error)
				}
			}
		}
	}

	return {
		id: "block",
		title: t("block"),
		icon: "block",
		destructive: true,
		requiresOnline: true,
		onPress: async () => {
			const promptResponse = await run(async () => {
				return await prompts.alert({
					title: t("block_contact"),
					message: t("block_contact_confirmation"),
					cancelText: t("cancel"),
					okText: t("block"),
					destructive: true
				})
			})

			if (!promptResponse.success) {
				logger.warn("contacts", "block confirmation prompt failed", { error: promptResponse.error })
				alerts.error(promptResponse.error)

				return
			}

			if (promptResponse.data.cancelled) {
				return
			}

			const result = await runWithLoading(async () => {
				await contacts.block({
					userId,
					email,
					avatar,
					nickName,
					timestamp
				})
			})

			if (!result.success) {
				logger.error("contacts", "block failed", { email, error: result.error })
				alerts.error(result.error)
			}
		}
	}
}
