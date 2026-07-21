import { NoteType } from "@filen/sdk-rs"
import { type Note as TNote } from "@/types"
import { noteDisplayTitle } from "@/lib/decryption"
import { Menu as MenuComponent, type MenuButton } from "@/components/ui/menu"
import View from "@/components/ui/view"
import { useStringifiedClient } from "@/lib/auth"
import useNotesStore from "@/features/notes/store/useNotes.store"
import useNotesInflightStore from "@/features/notes/store/useNotesInflight.store"
import { useShallow } from "zustand/shallow"
import { runWithLoading } from "@/components/ui/fullScreenLoadingModal"
import notes from "@/features/notes/notes"
import prompts from "@/lib/prompts"
import { run } from "@filen/utils"
import alerts from "@/lib/alerts"
import { confirmedAction } from "@/lib/confirmedAction"
import { router } from "@/lib/router"
import { Platform } from "react-native"
import useAppStore from "@/stores/useApp.store"
import { shareTmpFile } from "@/lib/share"
import { serialize } from "@/lib/serializer"
import { t } from "@/lib/i18n"
import * as Clipboard from "expo-clipboard"
import logger from "@/lib/logger"

export type NoteMenuOrigin = "notes" | "search" | "content"

export type NoteTypeString = "text" | "checklist" | "code" | "rich" | "md"

type NoteTypeLabelKey = "note_type_text" | "note_type_checklist" | "note_type_code" | "note_type_richtext" | "note_type_markdown"

// Note-type → canonical label key. The static submenu and the dynamic `typeString`
// path both resolve through this map so a type renders one identical label everywhere.
export const NOTE_TYPE_LABEL_KEY: Record<NoteTypeString, NoteTypeLabelKey> = {
	text: "note_type_text",
	checklist: "note_type_checklist",
	code: "note_type_code",
	rich: "note_type_richtext",
	md: "note_type_markdown"
}

// The five note types in display order, typed so `typeString` is the narrow union
// (a plain array literal would widen it to `string` and break the label-key lookup).
export const NOTE_TYPE_OPTIONS: { type: NoteType; typeString: NoteTypeString }[] = [
	{
		type: NoteType.Text,
		typeString: "text"
	},
	{
		type: NoteType.Checklist,
		typeString: "checklist"
	},
	{
		type: NoteType.Code,
		typeString: "code"
	},
	{
		type: NoteType.Rich,
		typeString: "rich"
	},
	{
		type: NoteType.Md,
		typeString: "md"
	}
]

// Shared shape for confirmed destructive note actions (trash / delete / leave):
// prompt → guard cancel → runWithLoading(action) → guard failure → optionally pop
// back if we're sitting on the note's detail route. Returns the onPress handler.
function confirmedNoteAction({
	note,
	promptTitle,
	promptMessage,
	promptOkText,
	action,
	dismissOnSuccess
}: {
	note: TNote
	promptTitle: string
	promptMessage: string
	promptOkText: string
	// Return value is awaited then discarded (matches the original `await notes.X(...)`).
	action: () => Promise<unknown>
	dismissOnSuccess: boolean
}): () => Promise<void> {
	return confirmedAction({
		promptTitle,
		promptMessage,
		promptOkText,
		action,
		dismiss: dismissOnSuccess ? () => useAppStore.getState().pathname.startsWith(`/note/${note.uuid}`) : undefined
	})
}

// Maps a note's SDK NoteType to its menu icon. Shared by the notes header (create/convert
// submenus) and the single-note menu, so the 5-way mapping lives in one place.
export function noteTypeToIcon(type: NoteType): "text" | "checklist" | "code" | "richtext" | "markdown" | undefined {
	return type === NoteType.Text
		? "text"
		: type === NoteType.Checklist
			? "checklist"
			: type === NoteType.Code
				? "code"
				: type === NoteType.Rich
					? "richtext"
					: type === NoteType.Md
						? "markdown"
						: undefined
}

export function createMenuButtons({
	note,
	isSelected = false,
	writeAccess,
	origin,
	isOwner,
	hideCompletedChecklistItems = false,
	onToggleHideCompletedChecklistItems
}: {
	note: TNote
	// Optional: detail-route callers (origin === "content") don't have a meaningful
	// selection state — the select/deselect entry is hidden for them anyway, so
	// they can omit it. List-row callers still pass it.
	isSelected?: boolean
	writeAccess: boolean
	origin: NoteMenuOrigin
	isOwner: boolean
	// Client-side "hide completed items" view toggle — only surfaced in the checklist editor
	// (origin === "content"). Omitted by list/search callers, so the entry never appears there.
	hideCompletedChecklistItems?: boolean
	onToggleHideCompletedChecklistItems?: () => void
}): MenuButton[] {
	const buttons: MenuButton[] = []

	if (note.undecryptable) {
		if (note.trash) {
			buttons.push({
				id: "restore",
				requiresOnline: true,
				title: t("restore"),
				icon: "restore",
				onPress: async () => {
					const result = await runWithLoading(async () => {
						await notes.restore({
							note
						})
					})

					if (!result.success) {
						logger.error("notes", "restore undecryptable note failed", { error: result.error, noteUuid: note.uuid })
						alerts.error(result.error)

						return
					}
				}
			})

			buttons.push({
				id: "delete",
				requiresOnline: true,
				title: t("delete"),
				icon: "delete",
				destructive: true,
				onPress: confirmedNoteAction({
					note,
					promptTitle: t("delete_note"),
					promptMessage: t("are_you_sure_delete_note"),
					promptOkText: t("delete"),
					action: () => notes.delete({ note }),
					dismissOnSuccess: true
				})
			})
		} else if (isOwner) {
			buttons.push({
				id: "trash",
				requiresOnline: true,
				title: t("trash"),
				icon: "trash",
				destructive: true,
				onPress: confirmedNoteAction({
					note,
					promptTitle: t("trash_note"),
					promptMessage: t("are_you_sure_trash_note"),
					promptOkText: t("trash"),
					action: () => notes.trash({ note }),
					dismissOnSuccess: true
				})
			})
		} else {
			buttons.push({
				id: "leave",
				requiresOnline: true,
				title: t("leave"),
				icon: "exit",
				destructive: true,
				onPress: confirmedNoteAction({
					note,
					promptTitle: t("leave_note"),
					promptMessage: t("are_you_sure_leave_note"),
					promptOkText: t("leave"),
					action: () => notes.leave({ note }),
					dismissOnSuccess: true
				})
			})
		}

		return buttons
	}

	if (origin === "notes" || origin === "search") {
		buttons.push({
			id: isSelected ? "deselect" : "select",
			title: isSelected ? t("deselect") : t("select"),
			icon: "select",
			checked: isSelected,
			onPress: () => {
				useNotesStore.getState().toggleSelectedNote(note)
			}
		})
	}

	// Toggles (pin / favorite) sit first — they're one-tap and the most-tapped
	// actions in the menu.
	buttons.push({
		id: note.pinned ? "unpin" : "pin",
		title: note.pinned ? t("unpin") : t("pin"),
		icon: "pin",
		requiresOnline: true,
		onPress: async () => {
			const result = await runWithLoading(async () => {
				await notes.setPinned({
					note,
					pinned: !note.pinned
				})
			})

			if (!result.success) {
				logger.error("notes", "set note pinned failed", { error: result.error, noteUuid: note.uuid })
				alerts.error(result.error)

				return
			}
		}
	})

	buttons.push({
		id: note.favorite ? "unfavorite" : "favorite",
		title: note.favorite ? t("unfavorite") : t("favorite"),
		icon: "heart",
		requiresOnline: true,
		onPress: async () => {
			const result = await runWithLoading(async () => {
				await notes.setFavorited({
					note,
					favorite: !note.favorite
				})
			})

			if (!result.success) {
				logger.error("notes", "set note favorited failed", { error: result.error, noteUuid: note.uuid })
				alerts.error(result.error)

				return
			}
		}
	})

	if (origin === "content" && note.noteType === NoteType.Checklist && onToggleHideCompletedChecklistItems) {
		buttons.push({
			id: "hideCompletedChecklistItems",
			title: t("hide_completed_items"),
			icon: "eye",
			checked: hideCompletedChecklistItems,
			onPress: onToggleHideCompletedChecklistItems
		})
	}

	if (writeAccess) {
		buttons.push({
			id: "type",
			title: t("type"),
			icon: noteTypeToIcon(note.noteType),
			subButtons: NOTE_TYPE_OPTIONS.map(
				({ type, typeString }) =>
					({
						id: `type_${typeString}`,
						title: t(NOTE_TYPE_LABEL_KEY[typeString]),
						checked: note.noteType === type,
						disabled: note.noteType === type,
						requiresOnline: true,
						icon: noteTypeToIcon(type),
						keepMenuOpenOnPress: Platform.OS === "android",
						onPress: async () => {
							const result = await runWithLoading(async () => {
								const content = await notes.getContent({
									note
								})

								await notes.setType({
									note,
									type,
									knownContent: content
								})
							})

							if (!result.success) {
								logger.error("notes", "set note type failed", { error: result.error, noteUuid: note.uuid })
								alerts.error(result.error)

								return
							}
						}
					}) satisfies MenuButton
			)
		})
	}

	buttons.push({
		id: "tags",
		title: t("tags"),
		icon: "tag",
		onPress: () => {
			router.push({
				pathname: "/noteTags",
				params: {
					// /noteTags accepts an array (single-note callers wrap as a one-
					// element array). Keeps the route uniform between per-item edits
					// and bulk tag edits from the notes list.
					notes: serialize([note])
				}
			})
		}
	})

	if (writeAccess) {
		buttons.push({
			id: "rename",
			requiresOnline: true,
			title: t("rename"),
			icon: "edit",
			onPress: async () => {
				const promptResult = await run(async () => {
					return await prompts.input({
						title: t("rename_note"),
						message: t("enter_new_name"),
						defaultValue: noteDisplayTitle(note),
						cancelText: t("cancel"),
						okText: t("rename")
					})
				})

				if (!promptResult.success) {
					logger.error("notes", "rename note prompt failed", { error: promptResult.error, noteUuid: note.uuid })
					alerts.error(promptResult.error)

					return
				}

				if (promptResult.data.cancelled || promptResult.data.type !== "string") {
					return
				}

				const newTitle = promptResult.data.value.trim()

				if (newTitle.length === 0) {
					return
				}

				const result = await runWithLoading(async () => {
					await notes.setTitle({
						note,
						newTitle
					})
				})

				if (!result.success) {
					logger.error("notes", "rename note failed", { error: result.error, noteUuid: note.uuid })
					alerts.error(result.error)

					return
				}
			}
		})
	}

	buttons.push({
		id: "duplicate",
		requiresOnline: true,
		title: t("duplicate"),
		icon: "duplicate",
		onPress: async () => {
			const result = await runWithLoading(async () => {
				await notes.duplicate({
					note
				})
			})

			if (!result.success) {
				logger.error("notes", "duplicate note failed", { error: result.error, noteUuid: note.uuid })
				alerts.error(result.error)

				return
			}
		}
	})

	buttons.push({
		id: "export",
		requiresOnline: true,
		title: t("export"),
		icon: "export",
		onPress: async () => {
			const exportResult = await runWithLoading(async () => {
				return await notes.export({
					note
				})
			})

			if (!exportResult.success) {
				logger.error("notes", "export note failed", { error: exportResult.error, noteUuid: note.uuid })
				alerts.error(exportResult.error)

				return
			}

			const result = await shareTmpFile({
				uri: exportResult.data.file.uri,
				name: exportResult.data.file.name,
				mimeType: exportResult.data.mimeType,
				cleanup: () => {
					exportResult.data.cleanup()
				}
			})

			if (!result.success) {
				logger.error("notes", "share exported note failed", { error: result.error, noteUuid: note.uuid })
				alerts.error(result.error)

				return
			}
		}
	})

	buttons.push({
		id: "copy_content",
		requiresOnline: true,
		title: t("copy_content"),
		icon: "copy",
		onPress: async () => {
			const result = await runWithLoading(async () => {
				return await notes.getContent({
					note
				})
			})

			if (!result.success) {
				logger.error("notes", "copy note content failed", { error: result.error, noteUuid: note.uuid })
				alerts.error(result.error)

				return
			}

			await Clipboard.setStringAsync(result.data ?? "")
			alerts.normal(t("copied_to_clipboard"))
		}
	})

	buttons.push({
		id: "participants",
		title: t("participants"),
		icon: "users",
		onPress: () => {
			router.push({
				pathname: "/noteParticipants",
				params: {
					note: serialize(note)
				}
			})
		}
	})

	if (writeAccess) {
		buttons.push({
			id: "history",
			requiresOnline: true,
			title: t("history"),
			icon: "clock",
			onPress: () => {
				router.push({
					pathname: "/noteHistory",
					params: {
						note: serialize(note)
					}
				})
			}
		})
	}

	if (isOwner) {
		if (!note.archive && !note.trash) {
			buttons.push({
				id: "archive",
				requiresOnline: true,
				title: t("archive"),
				icon: "archive",
				onPress: async () => {
					const result = await runWithLoading(async () => {
						await notes.archive({
							note
						})
					})

					if (!result.success) {
						logger.error("notes", "archive note failed", { error: result.error, noteUuid: note.uuid })
						alerts.error(result.error)

						return
					}
				}
			})
		}

		if (note.archive || note.trash) {
			buttons.push({
				id: "restore",
				requiresOnline: true,
				title: t("restore"),
				icon: "restore",
				onPress: async () => {
					const result = await runWithLoading(async () => {
						await notes.restore({
							note
						})
					})

					if (!result.success) {
						logger.error("notes", "restore note failed", { error: result.error, noteUuid: note.uuid })
						alerts.error(result.error)

						return
					}
				}
			})
		}

		if (!note.trash) {
			buttons.push({
				id: "trash",
				requiresOnline: true,
				title: t("trash"),
				icon: "trash",
				destructive: true,
				onPress: confirmedNoteAction({
					note,
					promptTitle: t("trash_note"),
					promptMessage: t("are_you_sure_trash_note"),
					promptOkText: t("trash"),
					action: () => notes.trash({ note }),
					dismissOnSuccess: true
				})
			})
		}

		if (note.trash) {
			buttons.push({
				id: "delete",
				requiresOnline: true,
				title: t("delete"),
				icon: "delete",
				destructive: true,
				onPress: confirmedNoteAction({
					note,
					promptTitle: t("delete_note"),
					promptMessage: t("are_you_sure_delete_note"),
					promptOkText: t("delete"),
					action: () => notes.delete({ note }),
					dismissOnSuccess: true
				})
			})
		}
	} else {
		buttons.push({
			id: "leave",
			requiresOnline: true,
			title: t("leave"),
			icon: "exit",
			destructive: true,
			onPress: confirmedNoteAction({
				note,
				promptTitle: t("leave_note"),
				promptMessage: t("are_you_sure_leave_note"),
				promptOkText: t("leave"),
				// Leaving is an irreversible loss of access (until re-invited) — styled
				// destructive like the bulk-leave and undecryptable-leave variants.
				action: () => notes.leave({ note }),
				dismissOnSuccess: true
			})
		})
	}

	return buttons
}

const Menu = ({
	children,
	origin,
	note,
	...rest
}: {
	children: React.ReactNode
	note: TNote
	origin: NoteMenuOrigin
} & React.ComponentPropsWithoutRef<typeof MenuComponent>) => {
	const stringifiedClient = useStringifiedClient()
	const isSelected = useNotesStore(useShallow(state => state.selectedNotes.some(selectedNote => selectedNote.uuid === note.uuid)))
	const isInflight = useNotesInflightStore(useShallow(state => (state.inflightContent[note.uuid] ?? []).length > 0))

	const writeAccess =
		note.ownerId === stringifiedClient?.userId ||
		note.participants.some(p => p.userId === stringifiedClient?.userId && p.permissionsWrite)

	const isOwner = note.ownerId === stringifiedClient?.userId

	const onOpenMenu = () => {
		useNotesStore.getState().setActiveNote(note)
	}

	const onCloseMenu = () => {
		useNotesStore.getState().setActiveNote(null)
	}

	const buttons =
		rest.disabled || isInflight
			? []
			: createMenuButtons({
					note,
					isSelected,
					writeAccess,
					origin,
					isOwner
				})

	if (buttons.length === 0 || rest.disabled) {
		return <View className={rest.className}>{children}</View>
	}

	return (
		<MenuComponent
			key={`note-menu-${note.uuid}`}
			buttons={buttons}
			onOpenMenu={onOpenMenu}
			onCloseMenu={onCloseMenu}
			{...rest}
		>
			{children}
		</MenuComponent>
	)
}

export default Menu
