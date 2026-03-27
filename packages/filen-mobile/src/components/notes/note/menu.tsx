import { type Note as TNote, NoteType } from "@filen/sdk-rs"
import { Menu as MenuComponent, type MenuButton } from "@/components/ui/menu"
import { memo } from "react"
import View from "@/components/ui/view"
import { useStringifiedClient } from "@/lib/auth"
import useNotesStore from "@/stores/useNotes.store"
import { useShallow } from "zustand/shallow"
import { runWithLoading } from "@/components/ui/fullScreenLoadingModal"
import notes from "@/lib/notes"
import prompts from "@/lib/prompts"
import { run } from "@filen/utils"
import alerts from "@/lib/alerts"
import { router } from "expo-router"
import { Platform } from "react-native"
import useAppStore from "@/stores/useApp.store"
import * as Sharing from "expo-sharing"

export type NoteMenuOrigin = "notes" | "search" | "content"

export function createMenuButtons({
	note,
	isSelected,
	writeAccess,
	origin,
	isOwner
}: {
	note: TNote
	isSelected: boolean
	writeAccess: boolean
	origin: NoteMenuOrigin
	isOwner: boolean
}): MenuButton[] {
	const buttons: MenuButton[] = []

	if (origin === "notes" || origin === "search") {
		buttons.push({
			id: isSelected ? "deselect" : "select",
			title: isSelected ? "tbd_deselect" : "tbd_select",
			icon: "select",
			checked: isSelected,
			onPress: () => {
				useNotesStore.getState().setSelectedNotes(prev => {
					if (isSelected) {
						return prev.filter(n => n.uuid !== note.uuid)
					} else {
						return [...prev.filter(n => n.uuid !== note.uuid), note]
					}
				})
			}
		})
	}

	if (writeAccess) {
		buttons.push({
			id: "history",
			title: "tbd_history",
			icon: "clock",
			onPress: () => {
				router.push({
					pathname: "/noteHistory/[uuid]",
					params: {
						uuid: note.uuid
					}
				})
			}
		})
	}

	if (writeAccess) {
		buttons.push({
			id: "participants",
			title: "tbd_participants",
			icon: "users",
			onPress: () => {
				router.push({
					pathname: "/noteParticipants/[uuid]",
					params: {
						uuid: note.uuid
					}
				})
			}
		})
	}

	if (writeAccess) {
		buttons.push({
			id: "type",
			title: "tbd_type",
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
			subButtons: [
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
			].map(
				({ type, typeString }) =>
					({
						id: `type_${typeString}`,
						title: `tbd_${typeString}`,
						checked: note.noteType === type,
						disabled: note.noteType === type,
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
		id: note.pinned ? "unpin" : "pin",
		title: note.pinned ? "tbd_unpin" : "tbd_pin",
		icon: "pin",
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
		title: note.favorite ? "tbd_unfavorite" : "tbd_favorite",
		icon: "heart",
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

	buttons.push({
		id: "tags",
		title: "tbd_tags",
		icon: "tag",
		onPress: () => {
			// TODO: open bottom sheet to show tags with ability to add/remove tags from note
		}
	})

	if (writeAccess) {
		buttons.push({
			id: "rename",
			title: "tbd_rename",
			icon: "edit",
			onPress: async () => {
				const promptResult = await run(async () => {
					return await prompts.input({
						title: "tbd_rename_note",
						message: "tbd_enter_new_name",
						defaultValue: note.title,
						cancelText: "tbd_cancel",
						okText: "tbd_rename"
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
		title: "tbd_duplicate",
		icon: "copy",
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
		id: "export",
		title: "tbd_export",
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
				title: "tbd_archive",
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
				title: "tbd_restore",
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
				title: "tbd_trash",
				icon: "trash",
				destructive: true,
				onPress: async () => {
					const promptResult = await run(async () => {
						return await prompts.alert({
							title: "tbd_trash_note",
							message: "tbd_are_you_sure_trash_note",
							cancelText: "tbd_cancel",
							okText: "tbd_dtrash"
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
				title: "tbd_delete",
				icon: "delete",
				destructive: true,
				onPress: async () => {
					const promptResult = await run(async () => {
						return await prompts.alert({
							title: "tbd_delete_note",
							message: "tbd_are_you_sure_delete_note",
							cancelText: "tbd_cancel",
							okText: "tbd_delete"
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
			title: "tbd_leave",
			icon: "exit",
			destructive: true,
			onPress: async () => {
				const promptResult = await run(async () => {
					return await prompts.alert({
						title: "tbd_leave_note",
						message: "tbd_are_you_sure_leave_note",
						cancelText: "tbd_cancel",
						okText: "tbd_leave"
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
