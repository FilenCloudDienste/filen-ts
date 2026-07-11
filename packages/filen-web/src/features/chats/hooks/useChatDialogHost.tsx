import { type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { useNavigate } from "@tanstack/react-router"
import { toast } from "sonner"
import type { Chat } from "@filen/sdk-rs"
import { useDialogHost } from "@/lib/useDialogHost"
import { renameChat, leaveChat, deleteChat } from "@/features/chats/lib/actions"
import { type ChatActionDialogKind } from "@/features/chats/components/chatMenu.logic"
import { ChatParticipantsDialog } from "@/features/chats/components/chatParticipantsDialog"
import { CreateChatDialog } from "@/features/chats/components/createChatDialog"
import { InputDialog } from "@/components/dialogs/inputDialog"
import { ConfirmDialog } from "@/components/dialogs/confirmDialog"
import { errorLabel } from "@/lib/i18n/errorLabel"

// Discriminates on `kind` alone, mirrors notes' ActiveNoteDialog split: the four per-chat kinds carry
// a Chat; "create" carries nothing (there is no chat yet — that's the whole point of the dialog).
type ActiveChatDialog = { kind: ChatActionDialogKind; chat: Chat } | { kind: "create" }

export interface ChatDialogHost {
	isDialogOpen: boolean
	openChatDialog: (kind: ChatActionDialogKind, chat: Chat) => void
	openCreateChatDialog: () => void
	renderActiveDialog: () => ReactNode
}

export interface UseChatDialogHostParams {
	// The uuid currently shown in this surface's thread route ("" when none) — leave/delete navigate
	// away from THIS uuid before removing the chat from cache, so the route never briefly resolves to a
	// gone conversation (mirrors notes' useNoteDialogHost currentUuid/navigateAwayIfCurrent).
	currentUuid: string
}

// One instance of whichever dialog `ChatActionDialogKind` (or "create") names is rendered at a time —
// the chat-menu counterpart to notes' useNoteDialogHost, sized to the five kinds the chat surfaces
// ever dispatch (rename/delete/leave/participants/create).
export function useChatDialogHost({ currentUuid }: UseChatDialogHostParams): ChatDialogHost {
	const { t } = useTranslation(["chats", "common"])
	const navigate = useNavigate()
	const { activeDialog, setActiveDialog, dialogPending, setDialogPending, isDialogOpen, closeActiveDialog } =
		useDialogHost<ActiveChatDialog>()

	function openChatDialog(kind: ChatActionDialogKind, chat: Chat): void {
		setActiveDialog({ kind, chat })
	}

	function openCreateChatDialog(): void {
		setActiveDialog({ kind: "create" })
	}

	function navigateAwayIfCurrent(chat: Chat): void {
		if (chat.uuid === currentUuid) {
			void navigate({ to: "/chats" })
		}
	}

	async function handleRenameSubmit(chat: Chat, value: string): Promise<void> {
		setDialogPending(true)
		const outcome = await renameChat(chat, value)
		setDialogPending(false)

		if (outcome.status === "error") {
			toast.error(errorLabel(outcome.dto))
			return
		}

		closeActiveDialog()
	}

	async function handleDeleteConfirm(chat: Chat): Promise<void> {
		setDialogPending(true)
		const outcome = await deleteChat(chat, {
			beforeCacheRemoval: () => {
				navigateAwayIfCurrent(chat)
			}
		})
		setDialogPending(false)

		if (outcome.status === "error") {
			toast.error(errorLabel(outcome.dto))
			return
		}

		closeActiveDialog()
	}

	async function handleLeaveConfirm(chat: Chat): Promise<void> {
		setDialogPending(true)
		const outcome = await leaveChat(chat, {
			beforeCacheRemoval: () => {
				navigateAwayIfCurrent(chat)
			}
		})
		setDialogPending(false)

		if (outcome.status === "error") {
			toast.error(errorLabel(outcome.dto))
			return
		}

		closeActiveDialog()
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
			case "participants":
				return (
					<ChatParticipantsDialog
						chat={activeDialog.chat}
						onClose={closeActiveDialog}
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
		}
	}

	return { isDialogOpen, openChatDialog, openCreateChatDialog, renderActiveDialog }
}
