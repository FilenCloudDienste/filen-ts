import { type Note as TNote, NoteType, type NoteTag, type NoteParticipant, type NoteHistory } from "@filen/sdk-rs"
import { Menu as MenuComponent, type MenuButton } from "@/components/ui/menu"
import { memo, useMemo, useCallback } from "@/lib/memo"
import View from "@/components/ui/view"
import { useStringifiedClient } from "@/lib/auth"
import useNotesStore from "@/stores/useNotes.store"
import { useShallow } from "zustand/shallow"
import { runWithLoading } from "@/components/ui/fullScreenLoadingModal"
import notes from "@/lib/notes"
import prompts from "@/lib/prompts"
import { run, fastLocaleCompare } from "@filen/utils"
import alerts from "@/lib/alerts"
import useNotesTagsQuery from "@/queries/useNotesTags.query"
import useNoteHistoryQuery from "@/queries/useNoteHistory.query"
import { simpleDate } from "@/lib/time"
import { router } from "expo-router"
import { actionSheet } from "@/providers/actionSheet.provider"
import { Paths } from "expo-file-system"
import { pack } from "@/lib/msgpack"
import { Buffer } from "react-native-quick-crypto"
import { Platform } from "react-native"
import { contactDisplayName } from "@/lib/utils"
import useAppStore from "@/stores/useApp.store"
import * as Sharing from "expo-sharing"

export type NoteMenuOrigin = "notes" | "search" | "content"

export function createMenuButtons({
	note,
	isSelected,
	writeAccess,
	origin,
	noteHistory,
	userId,
	notesTags,
	isOwner
}: {
	note: TNote
	isSelected: boolean
	writeAccess: boolean
	origin: NoteMenuOrigin
	noteHistory: NoteHistory[]
	userId: bigint
	notesTags: NoteTag[]
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

	if (writeAccess && noteHistory.length > 0) {
		buttons.push({
			id: "history",
			title: "tbd_history",
			icon: "clock",
			subButtons: noteHistory.map(
				historyItem =>
					({
						id: `history_${historyItem.id}`,
						title: simpleDate(Number(historyItem.editedTimestamp)),
						keepMenuOpenOnPress: Platform.OS === "android",
						onPress: () => {
							router.push({
								pathname: Paths.join("/", "note", note.uuid),
								params: {
									historyItemPacked: Buffer.from(pack(historyItem)).toString("base64")
								}
							})
						}
					}) satisfies MenuButton
			)
		})
	}

	if (writeAccess) {
		buttons.push({
			id: "participants",
			title: "tbd_participants",
			icon: "users",
			subButtons: (
				[
					{
						type: "add" as const
					},
					...note.participants
						.filter(participant => participant.userId !== userId)
						.map(participant => ({
							type: "participant" as const,
							participant
						}))
						.sort((a, b) => fastLocaleCompare(a.participant.email, b.participant.email))
				] satisfies (
					| {
							type: "add"
					  }
					| {
							type: "participant"
							participant: NoteParticipant
					  }
				)[]
			).map(subButton => {
				if (subButton.type === "add") {
					return {
						id: "addParticipant",
						title: "tbd_addParticipant",
						keepMenuOpenOnPress: Platform.OS === "android",
						icon: "plus",
						onPress: async () => {
							// TODO: Add participant
						}
					} satisfies MenuButton
				}

				return {
					id: `participant_${subButton.participant.userId}`,
					title: Platform.select({
						ios: contactDisplayName(subButton.participant),
						default: subButton.participant.email
					}),
					subTitle: subButton.participant.email,
					keepMenuOpenOnPress: Platform.OS === "android",
					icon: subButton.participant.permissionsWrite ? "edit" : "eye",
					destructive: note.ownerId === subButton.participant.userId,
					onPress: () => {
						actionSheet.show({
							buttons: [
								{
									title: subButton.participant.permissionsWrite ? "tbd_set_read_only" : "tbd_set_read_write",
									onPress: async () => {
										const result = await runWithLoading(async () => {
											await notes.setParticipantPermission({
												note,
												participant: subButton.participant,
												permissionsWrite: !subButton.participant.permissionsWrite
											})
										})

										if (!result.success) {
											console.error(result.error)
											alerts.error(result.error)

											return
										}
									}
								},
								{
									title: "tbd_remove_participant",
									destructive: true,
									onPress: async () => {
										const promptResult = await run(async () => {
											return await prompts.alert({
												title: "tbd_remove_participant",
												message: "tbd_are_you_sure_remove_participant",
												cancelText: "tbd_cancel",
												okText: "tbd_remove"
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
											await notes.removeParticipant({
												note,
												participantUserId: subButton.participant.userId
											})
										})

										if (!result.success) {
											console.error(result.error)
											alerts.error(result.error)

											return
										}
									}
								},
								{
									title: "tbd_cancel",
									cancel: true
								}
							]
						})
					}
				} satisfies MenuButton
			})
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
		subButtons: (
			[
				{
					type: "create" as const
				},
				...notesTags.map(tag => ({
					type: "tag" as const,
					tag
				}))
			] satisfies (
				| {
						type: "create"
				  }
				| {
						type: "tag"
						tag: NoteTag
				  }
			)[]
		).map(subButton => {
			if (subButton.type === "create") {
				return {
					id: "createTag",
					title: "tbd_createTag",
					icon: "plus",
					keepMenuOpenOnPress: Platform.OS === "android",
					onPress: async () => {
						const promptResult = await run(async () => {
							return await prompts.input({
								title: "tbd_create_tag",
								message: "tbd_enter_tag_name",
								cancelText: "tbd_cancel",
								okText: "tbd_create"
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

						const newName = promptResult.data.value.trim()

						if (newName.length === 0) {
							return
						}

						const result = await runWithLoading(async () => {
							await notes.createTag({
								name: newName
							})
						})

						if (!result.success) {
							console.error(result.error)
							alerts.error(result.error)

							return
						}
					}
				} satisfies MenuButton
			}

			const tagged = note.tags.some(t => t.uuid === subButton.tag.uuid)

			return {
				id: `tag_${subButton.tag.uuid}`,
				title: subButton.tag.name ?? subButton.tag.uuid,
				checked: tagged,
				icon: "tag",
				keepMenuOpenOnPress: Platform.OS === "android",
				onPress: async () => {
					const result = await runWithLoading(async () => {
						if (tagged) {
							await notes.removeTag({
								note,
								tag: subButton.tag
							})

							return
						}

						await notes.addTag({
							note,
							tag: subButton.tag
						})
					})

					if (!result.success) {
						console.error(result.error)
						alerts.error(result.error)

						return
					}
				}
			} satisfies MenuButton
		})
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

export const Menu = memo(
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
		const isActive = useNotesStore(useShallow(state => state.activeNote?.uuid === note.uuid))
		const isInflight = useNotesStore(useShallow(state => (state.inflightContent[note.uuid] ?? []).length > 0))

		const notesTagsQuery = useNotesTagsQuery({
			enabled: false
		})

		const noteHistoryQuery = useNoteHistoryQuery(
			{
				uuid: note.uuid
			},
			{
				enabled: isActive
			}
		)

		const noteHistory = useMemo(() => {
			if (noteHistoryQuery.status !== "success") {
				return []
			}

			return noteHistoryQuery.data.sort((a, b) => Number(b.editedTimestamp) - Number(a.editedTimestamp))
		}, [noteHistoryQuery.data, noteHistoryQuery.status])

		const notesTags = useMemo(() => {
			if (notesTagsQuery.status !== "success") {
				return []
			}

			return notesTagsQuery.data
		}, [notesTagsQuery.data, notesTagsQuery.status])

		const writeAccess = useMemo(() => {
			return (
				note.ownerId === stringifiedClient?.userId ||
				note.participants.some(p => p.userId === stringifiedClient?.userId && p.permissionsWrite)
			)
		}, [note.ownerId, note.participants, stringifiedClient?.userId])

		const isOwner = useMemo(() => {
			return note.ownerId === stringifiedClient?.userId
		}, [note.ownerId, stringifiedClient?.userId])

		const onOpenMenu = useCallback(() => {
			useNotesStore.getState().setActiveNote(note)
		}, [note])

		const onCloseMenu = useCallback(() => {
			useNotesStore.getState().setActiveNote(null)
		}, [])

		const buttons = useMemo(() => {
			if (rest.disabled || isInflight) {
				return []
			}

			return createMenuButtons({
				note,
				isSelected,
				writeAccess,
				origin,
				noteHistory,
				userId: stringifiedClient?.userId ?? BigInt(0),
				notesTags,
				isOwner
			})
		}, [origin, writeAccess, rest.disabled, isSelected, note, notesTags, isOwner, noteHistory, stringifiedClient, isInflight])

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
