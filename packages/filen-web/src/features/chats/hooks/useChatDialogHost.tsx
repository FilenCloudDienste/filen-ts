import { type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { singleOrCountKey } from "@/lib/i18n"
import { useNavigate, useRouter } from "@tanstack/react-router"
import type { Chat } from "@filen/sdk-rs"
import { useDialogHost } from "@/lib/useDialogHost"
import { renameChat, leaveChat, deleteChat } from "@/features/chats/lib/actions"
import { deleteChatsPermanently, leaveChats } from "@/features/chats/lib/bulk"
import { CHATS_DELETE, CHATS_LEAVE, chatsActivity } from "@/features/chats/lib/activity"
import { selectedChatUuidFromPath } from "@/features/chats/components/chatsSidebar.logic"
import { type ChatActionDialogKind } from "@/features/chats/components/chatMenu.logic"
import { type ChatBulkDialogActionKind } from "@/features/chats/components/chatsBulkActionBar.logic"
import { openChatInfo } from "@/features/chats/store/useChatInfoStore"
import { CreateChatDialog } from "@/features/chats/components/createChatDialog"
import { InputDialog } from "@/components/dialogs/inputDialog"
import { ConfirmDialog } from "@/components/dialogs/confirmDialog"

// Discriminates on `kind` alone, mirrors notes' ActiveNoteDialog split: the three per-chat dialog kinds carry a
// Chat; "create" carries nothing (there is no chat yet — that's the whole point of the dialog); the two
// bulk kinds (ChatBulkDialogActionKind) carry the LIVE selection array instead. "participants" is no dialog: it
// opens the chat info panel (openChatDialog below).
type ActiveChatDialog =
	| { kind: Exclude<ChatActionDialogKind, "participants">; chat: Chat }
	| { kind: "create" }
	| { kind: ChatBulkDialogActionKind; chats: Chat[] }

export interface ChatDialogHost {
	isDialogOpen: boolean
	openChatDialog: (kind: ChatActionDialogKind, chat: Chat) => void
	openCreateChatDialog: () => void
	openBulkDialog: (kind: ChatBulkDialogActionKind, chats: Chat[]) => void
	renderActiveDialog: () => ReactNode
}

// One instance of whichever dialog `ChatActionDialogKind` (or "create") names is rendered at a time —
// the chat-menu counterpart to notes' useNoteDialogHost, sized to the kinds the chat surfaces ever
// dispatch (rename/delete/leave/create and the bulk confirms).
export function useChatDialogHost(): ChatDialogHost {
	const { t } = useTranslation(["chats", "common"])
	const navigate = useNavigate()
	const router = useRouter()
	const { activeDialog, setActiveDialog, dialogPending, isDialogOpen, closeActiveDialog, runDialogOutcome, runBulkDialogActivity } =
		useDialogHost<ActiveChatDialog>()

	// "participants" opens the chat info panel beside the conversation, opening the conversation first when the
	// entry came from another one's row (or from the bare list).
	function openChatDialog(kind: ChatActionDialogKind, chat: Chat): void {
		if (kind !== "participants") {
			setActiveDialog({ kind, chat })

			return
		}

		openChatInfo(chat.uuid)

		if (chat.uuid !== selectedChatUuidFromPath(router.state.location.pathname)) {
			void navigate({ to: "/chats/$uuid", params: { uuid: chat.uuid } })
		}
	}

	function openCreateChatDialog(): void {
		setActiveDialog({ kind: "create" })
	}

	function openBulkDialog(kind: ChatBulkDialogActionKind, chats: Chat[]): void {
		setActiveDialog({ kind, chats })
	}

	// Leave/delete navigate away from the open conversation before removing it from the cache, so the
	// route never briefly resolves to a gone conversation. Read live: a bulk run (or its Try again) can
	// settle after the user has opened another conversation.
	function navigateAwayIfCurrent(chat: Chat): void {
		if (chat.uuid === selectedChatUuidFromPath(router.state.location.pathname)) {
			void navigate({ to: "/chats" })
		}
	}

	async function handleRenameSubmit(chat: Chat, value: string): Promise<void> {
		await runDialogOutcome(() => renameChat(chat, value))
	}

	async function handleDeleteConfirm(chat: Chat): Promise<void> {
		await runDialogOutcome(() =>
			deleteChat(chat, {
				beforeCacheRemoval: () => {
					navigateAwayIfCurrent(chat)
				}
			})
		)
	}

	async function handleLeaveConfirm(chat: Chat): Promise<void> {
		await runDialogOutcome(() =>
			leaveChat(chat, {
				beforeCacheRemoval: () => {
					navigateAwayIfCurrent(chat)
				}
			})
		)
	}

	async function handleDeleteSelectedConfirm(chats: Chat[]): Promise<void> {
		await runBulkDialogActivity(
			chatsActivity(chats, CHATS_DELETE, (targets, onSettled) =>
				deleteChatsPermanently(targets, { beforeCacheRemoval: navigateAwayIfCurrent }, onSettled)
			)
		)
	}

	async function handleLeaveSelectedConfirm(chats: Chat[]): Promise<void> {
		await runBulkDialogActivity(
			chatsActivity(chats, CHATS_LEAVE, (targets, onSettled) =>
				leaveChats(targets, { beforeCacheRemoval: navigateAwayIfCurrent }, onSettled)
			)
		)
	}

	async function handleCreated(chat: Chat): Promise<void> {
		closeActiveDialog()
		await navigate({ to: "/chats/$uuid", params: { uuid: chat.uuid } })
	}

	function renderActiveDialog(): ReactNode {
		if (!activeDialog) {
			return null
		}

		switch (activeDialog.kind) {
			case "rename":
				return (
					<InputDialog
						open
						pending={dialogPending}
						title={t("chatRenameDialogTitle")}
						body={t("chatRenameDialogBody")}
						label={t("chatRenameDialogLabel")}
						initialValue={activeDialog.chat.name ?? ""}
						submitLabel={t("chatRenameDialogSubmit")}
						validate={value => value.trim().length > 0}
						onOpenChange={open => {
							if (!open) {
								closeActiveDialog()
							}
						}}
						onSubmit={value => {
							void handleRenameSubmit(activeDialog.chat, value)
						}}
					/>
				)
			case "delete":
				return (
					<ConfirmDialog
						open
						pending={dialogPending}
						title={t("chatDeleteDialogTitle")}
						body={t("chatDeleteDialogBody")}
						confirmLabel={t("chatActionDelete")}
						cancelLabel={t("common:cancel")}
						destructive
						onOpenChange={open => {
							if (!open) {
								closeActiveDialog()
							}
						}}
						onConfirm={() => {
							void handleDeleteConfirm(activeDialog.chat)
						}}
					/>
				)
			case "leave":
				return (
					<ConfirmDialog
						open
						pending={dialogPending}
						title={t("chatLeaveDialogTitle")}
						body={t("chatLeaveDialogBody")}
						confirmLabel={t("chatActionLeave")}
						cancelLabel={t("common:cancel")}
						destructive
						onOpenChange={open => {
							if (!open) {
								closeActiveDialog()
							}
						}}
						onConfirm={() => {
							void handleLeaveConfirm(activeDialog.chat)
						}}
					/>
				)
			case "create":
				return (
					<CreateChatDialog
						onClose={closeActiveDialog}
						onCreated={chat => {
							void handleCreated(chat)
						}}
					/>
				)
			case "deleteSelected":
				return (
					<ConfirmDialog
						open
						pending={dialogPending}
						title={t("chatsDeleteSelectedConfirmTitle")}
						body={t(
							singleOrCountKey(
								activeDialog.chats.length,
								"chatsDeleteSelectedConfirmBodySingle",
								"chatsDeleteSelectedConfirmBody"
							),
							{ count: activeDialog.chats.length }
						)}
						confirmLabel={t("chatActionDelete")}
						cancelLabel={t("common:cancel")}
						destructive
						onOpenChange={open => {
							if (!open) {
								closeActiveDialog()
							}
						}}
						onConfirm={() => {
							void handleDeleteSelectedConfirm(activeDialog.chats)
						}}
					/>
				)
			case "leaveSelected":
				return (
					<ConfirmDialog
						open
						pending={dialogPending}
						title={t("chatsLeaveSelectedConfirmTitle")}
						body={t(
							singleOrCountKey(
								activeDialog.chats.length,
								"chatsLeaveSelectedConfirmBodySingle",
								"chatsLeaveSelectedConfirmBody"
							),
							{ count: activeDialog.chats.length }
						)}
						confirmLabel={t("chatActionLeave")}
						cancelLabel={t("common:cancel")}
						destructive
						onOpenChange={open => {
							if (!open) {
								closeActiveDialog()
							}
						}}
						onConfirm={() => {
							void handleLeaveSelectedConfirm(activeDialog.chats)
						}}
					/>
				)
		}
	}

	return { isDialogOpen, openChatDialog, openCreateChatDialog, openBulkDialog, renderActiveDialog }
}
