import { type TFunction } from "i18next"
import { runWithLoading } from "@/components/ui/fullScreenLoadingModal"
import alerts from "@/lib/alerts"
import { inputPrompt } from "@/lib/promptFlow"
import contacts from "@/features/contacts/contacts"
import { type MenuButton } from "@/components/ui/menu"
import logger from "@/lib/logger"
import { confirmedAction } from "@/lib/confirmedAction"
import { contactsQueryGet } from "@/features/contacts/queries/useContacts.query"

/**
 * Prompt the user for a Filen email address and send a contact request.
 * Used by the header menu "add" item and the empty-state CTA — keep in sync.
 */
export async function addContactFlow({ t }: { t: TFunction }): Promise<void> {
	const email = await inputPrompt(
		{
			title: t("add_contact"),
			message: t("enter_contact_filen_email"),
			cancelText: t("cancel"),
			okText: t("add"),
			keyboardType: "email-address"
		},
		{ tag: "contacts", message: "addContactFlow prompt failed" },
		{ trim: true }
	)

	if (email === null) {
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
 * Builds a Block or Unblock menu action for a user, usable from contact and participant rows.
 * `timestamp` is cosmetic (blocked-list sort order) and self-heals on the next contacts refetch.
 */
export function buildBlockToggleMenuAction({
	t,
	isBlocked,
	target
}: {
	t: TFunction
	isBlocked: boolean
	target: {
		userId: bigint
		email: string
		avatar: string | undefined
		nickName: string | undefined
		timestamp: bigint
	}
}): MenuButton {
	if (isBlocked) {
		// Unblock is constructive (lifts a restriction), not destructive.
		return {
			id: "unblock",
			title: t("unblock"),
			icon: "restore",
			requiresOnline: true,
			onPress: async () => {
				// Resolved on press so rows never search the blocked list while rendering.
				const blockedUuid = contactsQueryGet()?.blocked.find(b => b.userId === target.userId)?.uuid

				if (!blockedUuid) {
					return
				}

				await confirmedAction({
					promptTitle: t("unblock_contact"),
					promptMessage: t("unblock_contact_confirmation"),
					promptOkText: t("unblock"),
					promptDestructive: false,
					action: () =>
						contacts.unblock({
							uuid: blockedUuid
						})
				})()
			}
		}
	}

	return {
		id: "block",
		title: t("block"),
		icon: "block",
		destructive: true,
		requiresOnline: true,
		onPress: confirmedAction({
			promptTitle: t("block_contact"),
			promptMessage: t("block_contact_confirmation"),
			promptOkText: t("block"),
			action: () =>
				contacts.block({
					userId: target.userId,
					email: target.email,
					avatar: target.avatar,
					nickName: target.nickName,
					timestamp: target.timestamp
				})
		})
	}
}
