import { NoteType } from "@filen/sdk-rs"
import { type Note as TNote } from "@/types"
import { noteDisplayTitle } from "@/lib/decryption"
import { Menu as MenuComponent, type MenuButton } from "@/components/ui/menu"
import { memo } from "react"
import View from "@/components/ui/view"
import { useStringifiedClient } from "@/lib/auth"
import useNotesStore from "@/features/notes/store/useNotes.store"
import { useShallow } from "zustand/shallow"
import { runWithLoading } from "@/components/ui/fullScreenLoadingModal"
import notes from "@/features/notes/notes"
import prompts from "@/lib/prompts"
import { run } from "@filen/utils"
import alerts from "@/lib/alerts"
import { router } from "expo-router"
import { Platform } from "react-native"
import useAppStore from "@/stores/useApp.store"
import * as Sharing from "expo-sharing"
import { serialize } from "@/lib/serializer"
import { t } from "@/lib/i18n"

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

export function createMenuButtons({
	note,
	isSelected = false,
	writeAccess,
	origin,
	isOwner
}: {
	note: TNote
	// Optional: detail-route callers (origin === "content") don't have a meaningful
	// selection state — the select/deselect entry is hidden for them anyway, so
	// they can omit it. List-row callers still pass it.
	isSelected?: boolean
	writeAccess: boolean
	origin: NoteMenuOrigin
	isOwner: boolean
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
						console.error(result.error)
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
				onPress: async () => {
					const promptResult = await run(async () => {
						return await prompts.alert({
							title: t("delete_note"),
							message: t("are_you_sure_delete_note"),
							cancelText: t("cancel"),
							okText: t("delete"),
							destructive: true
						})
					})

					if (!promptResult.success) {
						console.error(promptResult.error)
						alerts.error(promptResult.error)

						return
					}

					if (promptResult.data.cancelled) {
						return
					}

					const result = await runWithLoading(async () => {
						await notes.delete({
							note
						})
					})

					if (!result.success) {
						console.error(result.error)
						alerts.error(result.error)

						return
					}

					if (useAppStore.getState().pathname.startsWith(`/note/${note.uuid}`) && router.canGoBack()) {
						router.back()
					}
				}
			})
		} else if (isOwner) {
			buttons.push({
				id: "trash",
				requiresOnline: true,
				title: t("trash"),
				icon: "trash",
				destructive: true,
				onPress: async () => {
					const promptResult = await run(async () => {
						return await prompts.alert({
							title: t("trash_note"),
							message: t("are_you_sure_trash_note"),
							cancelText: t("cancel"),
							okText: t("trash"),
							destructive: true
						})
					})

					if (!promptResult.success) {
						console.error(promptResult.error)
						alerts.error(promptResult.error)

						return
					}

					if (promptResult.data.cancelled) {
						return
					}

					const result = await runWithLoading(async () => {
						await notes.trash({
							note
						})
					})

					if (!result.success) {
						console.error(result.error)
						alerts.error(result.error)

						return
					}

					if (useAppStore.getState().pathname.startsWith(`/note/${note.uuid}`) && router.canGoBack()) {
						router.back()
					}
				}
			})
		} else {
			buttons.push({
				id: "leave",
				requiresOnline: true,
				title: t("leave"),
				icon: "exit",
				destructive: true,
				onPress: async () => {
					const promptResult = await run(async () => {
						return await prompts.alert({
							title: t("leave_note"),
							message: t("are_you_sure_leave_note"),
							cancelText: t("cancel"),
							okText: t("leave"),
							destructive: true
						})
					})

					if (!promptResult.success) {
						console.error(promptResult.error)
						alerts.error(promptResult.error)

						return
					}

					if (promptResult.data.cancelled) {
						return
					}

					const result = await runWithLoading(async () => {
						await notes.leave({
							note
						})
					})

					if (!result.success) {
						console.error(result.error)
						alerts.error(result.error)

						return
					}

					if (useAppStore.getState().pathname.startsWith(`/note/${note.uuid}`) && router.canGoBack()) {
						router.back()
					}
				}
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
				console.error(result.error)
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
				console.error(result.error)
				alerts.error(result.error)

				return
			}
		}
	})

	if (writeAccess) {
		buttons.push({
			id: "type",
			title: t("type"),
			icon:
				note.noteType === NoteType.Text
					? "text"
					: note.noteType === NoteType.Checklist
						? "checklist"
						: note.noteType === NoteType.Code
							? "code"
							: note.noteType === NoteType.Rich
								? "richtext"
								: note.noteType === NoteType.Md
									? "markdown"
									: undefined,
			subButtons: NOTE_TYPE_OPTIONS.map(
				({ type, typeString }) =>
					({
						id: `type_${typeString}`,
						title: t(NOTE_TYPE_LABEL_KEY[typeString]),
						checked: note.noteType === type,
						disabled: note.noteType === type,
						requiresOnline: true,
						icon:
							type === NoteType.Text
								? "text"
								: type === NoteType.Checklist
									? "checklist"
									: type === NoteType.Code
										? "code"
										: type === NoteType.Rich
											? "richtext"
											: type === NoteType.Md
												? "markdown"
												: undefined,
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
								console.error(result.error)
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
					console.error(promptResult.error)
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
					console.error(result.error)
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
				console.error(result.error)
				alerts.error(result.error)

				return
			}
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

	buttons.push({
		id: "export",
		title: t("export"),
		icon: "export",
		onPress: async () => {
			const exportResult = await runWithLoading(async () => {
				return await notes.export({
					note
				})
			})

			if (!exportResult.success) {
				console.error(exportResult.error)
				alerts.error(exportResult.error)

				return
			}

			const result = await run(async defer => {
				defer(() => {
					exportResult.data.cleanup()
				})

				// Small delay to ensure file is fully written before sharing
				await new Promise<void>(resolve => setTimeout(resolve, 100))

				await Sharing.shareAsync(exportResult.data.file.uri, {
					mimeType: "text/plain",
					dialogTitle: exportResult.data.file.name
				})
			})

			if (!result.success) {
				console.error(result.error)
				alerts.error(result.error)

				return
			}
		}
	})

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
						console.error(result.error)
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
						console.error(result.error)
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
				onPress: async () => {
					const promptResult = await run(async () => {
						return await prompts.alert({
							title: t("trash_note"),
							message: t("are_you_sure_trash_note"),
							cancelText: t("cancel"),
							okText: t("trash"),
							destructive: true
						})
					})

					if (!promptResult.success) {
						console.error(promptResult.error)
						alerts.error(promptResult.error)

						return
					}

					if (promptResult.data.cancelled) {
						return
					}

					const result = await runWithLoading(async () => {
						await notes.trash({
							note
						})
					})

					if (!result.success) {
						console.error(result.error)
						alerts.error(result.error)

						return
					}

					if (useAppStore.getState().pathname.startsWith(`/note/${note.uuid}`) && router.canGoBack()) {
						router.back()
					}
				}
			})
		}

		if (note.trash) {
			buttons.push({
				id: "delete",
				requiresOnline: true,
				title: t("delete"),
				icon: "delete",
				destructive: true,
				onPress: async () => {
					const promptResult = await run(async () => {
						return await prompts.alert({
							title: t("delete_note"),
							message: t("are_you_sure_delete_note"),
							cancelText: t("cancel"),
							okText: t("delete"),
							destructive: true
						})
					})

					if (!promptResult.success) {
						console.error(promptResult.error)
						alerts.error(promptResult.error)

						return
					}

					if (promptResult.data.cancelled) {
						return
					}

					const result = await runWithLoading(async () => {
						await notes.delete({
							note
						})
					})

					if (!result.success) {
						console.error(result.error)
						alerts.error(result.error)

						return
					}

					if (useAppStore.getState().pathname.startsWith(`/note/${note.uuid}`) && router.canGoBack()) {
						router.back()
					}
				}
			})
		}
	} else {
		buttons.push({
			id: "leave",
			requiresOnline: true,
			title: t("leave"),
			icon: "exit",
			destructive: true,
			onPress: async () => {
				const promptResult = await run(async () => {
					return await prompts.alert({
						title: t("leave_note"),
						message: t("are_you_sure_leave_note"),
						cancelText: t("cancel"),
						okText: t("leave")
					})
				})

				if (!promptResult.success) {
					console.error(promptResult.error)
					alerts.error(promptResult.error)

					return
				}

				if (promptResult.data.cancelled) {
					return
				}

				const result = await runWithLoading(async () => {
					await notes.leave({
						note
					})
				})

				if (!result.success) {
					console.error(result.error)
					alerts.error(result.error)

					return
				}

				if (useAppStore.getState().pathname.startsWith(`/note/${note.uuid}`) && router.canGoBack()) {
					router.back()
				}
			}
		})
	}

	return buttons
}

const Menu = memo(
	({
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
		const isInflight = useNotesStore(useShallow(state => (state.inflightContent[note.uuid] ?? []).length > 0))

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
)

export default Menu
