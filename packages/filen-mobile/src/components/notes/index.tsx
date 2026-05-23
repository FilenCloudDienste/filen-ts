import { Fragment, useState, memo, useCallback } from "react"
import { onlineManager } from "@tanstack/react-query"
import SafeAreaView from "@/components/ui/safeAreaView"
import StackHeader, { type HeaderItem } from "@/components/ui/header"
import useNotesWithContentQuery from "@/queries/useNotesWithContent.query"
import { notesSorter } from "@/lib/sort"
import VirtualList, { type ListRenderItemInfo } from "@/components/ui/virtualList"
import ListEmpty from "@/components/ui/listEmpty"
import { type Note as TNote, NoteType, type NoteTag } from "@filen/sdk-rs"
import { run, fastLocaleCompare, cn } from "@filen/utils"
import alerts from "@/lib/alerts"
import { Platform } from "react-native"
import { router, useLocalSearchParams, useFocusEffect } from "expo-router"
import { useResolveClassNames } from "uniwind"
import Note, { type ListItem as NoteListItem } from "@/components/notes/note"
import useNotesStore from "@/stores/useNotes.store"
import { useShallow } from "zustand/shallow"
import useNotesTagsQuery from "@/queries/useNotesTags.query"
import { runWithLoading } from "@/components/ui/fullScreenLoadingModal"
import prompts from "@/lib/prompts"
import notesLib from "@/lib/notes"
import * as FileSystem from "expo-file-system"
import { useSecureStore } from "@/lib/secureStore"
import Tag from "@/components/notes/tag"
import type { MenuButton } from "@/components/ui/menu"
import { useStringifiedClient } from "@/lib/auth"
import * as Sharing from "expo-sharing"
import * as DocumentPicker from "expo-document-picker"
import { runBulk } from "@/lib/bulkOps"
import { aggregateNoteSelectionFlags, aggregateNoteTagSelectionFlags } from "@/lib/notesSelectors"

const Header = memo(({ setSearchQuery }: { setSearchQuery: React.Dispatch<React.SetStateAction<string>> }) => {
	const stringifiedClient = useStringifiedClient()
	const textForeground = useResolveClassNames("text-foreground")
	const textMutedForeground = useResolveClassNames("text-muted-foreground")
	const selectedNotes = useNotesStore(useShallow(state => state.selectedNotes))
	const selectedTags = useNotesStore(useShallow(state => state.selectedTags))
	const [notesViewMode, setNotesViewMode] = useSecureStore<"notes" | "tags">("notesViewMode", "notes")
	const { tagUuid } = useLocalSearchParams<{
		tagUuid?: string
	}>()
	const noteFlags = aggregateNoteSelectionFlags(selectedNotes, stringifiedClient?.userId)
	const tagFlags = aggregateNoteTagSelectionFlags(selectedTags)

	const notesTagsQuery = useNotesTagsQuery({
		enabled: false
	})

	const notesQuery = useNotesWithContentQuery({
		enabled: false
	})

	const tag = (() => {
		if (notesTagsQuery.status !== "success" || !tagUuid) {
			return null
		}

		return notesTagsQuery.data.find(t => t.uuid === tagUuid) ?? null
	})()

	const viewMode = tag ? "notes" : notesViewMode

	const notes =
		notesQuery.status === "success"
			? notesSorter.group({
					notes: notesQuery.data,
					groupArchived: true,
					groupTrashed: true,
					groupFavorited: true,
					groupPinned: true,
					tag: tag ?? undefined
				})
			: []

	const onlyNotes = notes.filter(n => n.type === "note")

	const notesTags =
		notesTagsQuery.status === "success" ? notesTagsQuery.data.sort((a, b) => fastLocaleCompare(a.name ?? a.uuid, b.name ?? b.uuid)) : []

	const createNote = async (type: NoteType) => {
		const result = await run(async () => {
			return await prompts.input({
				title: "tbd_create_note",
				message: "tbd_enter_note_name",
				cancelText: "tbd_cancel",
				okText: "tbd_create"
			})
		})

		if (!result.success) {
			console.error(result.error)
			alerts.error(result.error)

			return
		}

		if (result.data.cancelled || result.data.type !== "string") {
			return
		}

		const title = result.data.value.trim()

		if (title.length === 0) {
			return
		}

		const createResult = await runWithLoading(async () => {
			const newNote = await notesLib.create({
				title,
				content: "",
				type
			})

			if (tag) {
				await notesLib.addTag({
					note: newNote,
					tag
				})
			}

			return newNote
		})

		if (!createResult.success) {
			console.error(createResult.error)
			alerts.error(createResult.error)

			return
		}

		router.push(`/note/${createResult.data.uuid}`)
	}

	const headerRightItems = (() => {
		const items: HeaderItem[] = []
		const menuButtons: MenuButton[] = []

		if (viewMode === "notes") {
			if (onlyNotes.length > 0) {
				menuButtons.push({
					id: "selectAll",
					title: selectedNotes.length === onlyNotes.length ? "tbd_deselect_all" : "tbd_select_all",
					icon: "select",
					onPress: () => {
						if (selectedNotes.length === onlyNotes.length) {
							useNotesStore.getState().clearSelectedNotes()

							return
						}

						useNotesStore.getState().selectAllNotes(onlyNotes)
					}
				})
			}

			if (selectedNotes.length === 0) {
				menuButtons.push({
					id: "create",
					title: "tbd_create_note",
					icon: "plus",
					subButtons: [
						{
							title: "tbd_text",
							id: "text",
							icon: "text",
							onPress: async () => {
								await createNote(NoteType.Text)
							}
						},
						{
							title: "tbd_checklist",
							id: "checklist",
							icon: "checklist",
							onPress: async () => {
								await createNote(NoteType.Checklist)
							}
						},
						{
							title: "tbd_markdown",
							id: "markdown",
							icon: "markdown",
							onPress: async () => {
								await createNote(NoteType.Md)
							}
						},
						{
							title: "tbd_code",
							id: "code",
							icon: "code",
							onPress: async () => {
								await createNote(NoteType.Code)
							}
						},
						{
							title: "tbd_richtext",
							id: "richtext",
							icon: "richtext",
							onPress: async () => {
								await createNote(NoteType.Rich)
							}
						}
					]
				})

				menuButtons.push({
					id: "import",
					title: "tbd_import_note",
					icon: "export",
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
								onPress: () => {
									run(async defer => {
										const documentPickerResult = await run(async () => {
											return await DocumentPicker.getDocumentAsync({
												type: "text/plain",
												multiple: false,
												copyToCacheDirectory: true,
												base64: false
											})
										})

										if (!documentPickerResult.success) {
											console.error(documentPickerResult.error)
											alerts.error(documentPickerResult.error)

											return
										}

										if (documentPickerResult.data.canceled) {
											return
										}

										const asset = documentPickerResult.data.assets[0]

										if (!asset) {
											alerts.error("tbd_file_not_found")

											return
										}

										const assetFile = new FileSystem.File(asset.uri)

										if (!assetFile.exists || assetFile.size === 0) {
											alerts.error("tbd_file_not_found_or_empty")

											return
										}

										defer(() => {
											if (assetFile.exists) {
												assetFile.delete()
											}
										})

										const promptResult = await run(async () => {
											return await prompts.input({
												title: "tbd_import_note",
												message: "tbd_enter_note_name",
												cancelText: "tbd_cancel",
												okText: "tbd_import"
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

										const createResult = await runWithLoading(async () => {
											return await notesLib.create({
												title: newName,
												content: await assetFile.text(),
												type
											})
										})

										if (!createResult.success) {
											console.error(createResult.error)
											alerts.error(createResult.error)

											return
										}

										router.push(`/note/${createResult.data.uuid}`)
									})
								}
							}) satisfies MenuButton
					)
				})
			}

			if (selectedNotes.length > 0) {
				// Toggles (pin / favorite) sit first — one-tap, most-tapped.
				menuButtons.push({
					id: "bulkPin",
					title: noteFlags.includesPinned ? "tbd_unpin_selected" : "tbd_pin_selected",
					icon: "pin",
					requiresOnline: true,
					onPress: async () => {
						await runBulk({
							items: selectedNotes,
							clearSelection: () => useNotesStore.getState().clearSelectedNotes(),
							op: n => notesLib.setPinned({ note: n, pinned: !noteFlags.includesPinned })
						})
					}
				})

				menuButtons.push({
					id: "bulkFavorite",
					title: noteFlags.includesFavorited ? "tbd_unfavorite_selected" : "tbd_favorite_selected",
					icon: "heart",
					requiresOnline: true,
					onPress: async () => {
						await runBulk({
							items: selectedNotes,
							clearSelection: () => useNotesStore.getState().clearSelectedNotes(),
							op: n => notesLib.setFavorited({ note: n, favorite: !noteFlags.includesFavorited })
						})
					}
				})

				if (noteFlags.hasWriteAccessToAll) {
					menuButtons.push({
						id: "type",
						title: "tbd_type_change_selected",
						icon: "text",
						requiresOnline: true,
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
									requiresOnline: true,
									onPress: async () => {
										await runBulk({
											items: selectedNotes,
											clearSelection: () => useNotesStore.getState().clearSelectedNotes(),
											op: async n => {
												const content = await notesLib.getContent({ note: n })

												await notesLib.setType({ note: n, type, knownContent: content })
											}
										})
									}
								}) satisfies MenuButton
						)
					})
				}

				menuButtons.push({
					id: "bulkTag",
					title: "tbd_bulk_tag_selected",
					icon: "tag",
					requiresOnline: true,
					subButtons: notesTags.map(subButton => {
						return {
							id: `bulkTag_${subButton.uuid}`,
							title: subButton.name ?? subButton.uuid,
							icon: "tag",
							keepMenuOpenOnPress: Platform.OS === "android",
							requiresOnline: true,
							onPress: async () => {
								await runBulk({
									items: selectedNotes,
									clearSelection: () => useNotesStore.getState().clearSelectedNotes(),
									op: n => notesLib.addTag({ note: n, tag: subButton })
								})
							}
						}
					})
				})

				menuButtons.push({
					id: "bulkDuplicate",
					title: "tbd_duplicate_selected",
					icon: "duplicate",
					requiresOnline: true,
					onPress: async () => {
						await runBulk({
							items: selectedNotes,
							clearSelection: () => useNotesStore.getState().clearSelectedNotes(),
							op: n => notesLib.duplicate({ note: n })
						})
					}
				})

				menuButtons.push({
					id: "bulkExport",
					title: "tbd_export_selected",
					icon: "export",
					requiresOnline: true,
					onPress: async () => {
						const exportResult = await runWithLoading(async () => {
							if (selectedNotes.length === 1 && selectedNotes[0]) {
								return await notesLib.export({
									note: selectedNotes[0]
								})
							}

							return await notesLib.exportMultiple({
								notes: selectedNotes
							})
						})

						if (!exportResult.success) {
							console.error(exportResult.error)
							alerts.error(exportResult.error)

							return
						}

						useNotesStore.getState().clearSelectedNotes()

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

				if (noteFlags.everyOwned) {
					// State machine for notes:
					//   active  (!archive, !trash) → archive | trash
					//   archived (archive, !trash) → restore | trash
					//   trashed (trash)             → restore | delete-permanently
					//
					// Bulk gating must only enable an action when EVERY selected
					// note is in a state where that action is valid. The lib
					// guards each op so mixed-state slips would be silent no-ops,
					// but UX-wise we hide invalid actions instead.

					// Archive: every note must be active (no archived, no trashed).
					if (!noteFlags.includesArchived && !noteFlags.includesTrashed) {
						menuButtons.push({
							id: "bulkArchive",
							title: "tbd_archive_selected",
							icon: "archive",
							requiresOnline: true,
							onPress: async () => {
								await runBulk({
									items: selectedNotes,
									clearSelection: () => useNotesStore.getState().clearSelectedNotes(),
									op: n => notesLib.archive({ note: n })
								})
							}
						})
					}

					// Restore: every note must be archived OR trashed (no active).
					if (noteFlags.everyArchivedOrTrashed) {
						menuButtons.push({
							id: "bulkRestore",
							title: "tbd_restore_selected",
							icon: "restore",
							requiresOnline: true,
							onPress: async () => {
								await runBulk({
									items: selectedNotes,
									clearSelection: () => useNotesStore.getState().clearSelectedNotes(),
									op: n => notesLib.restore({ note: n })
								})
							}
						})
					}

					// Trash: every note must be active OR archived (no trashed).
					if (!noteFlags.includesTrashed) {
						menuButtons.push({
							id: "bulkTrash",
							title: "tbd_trash_selected",
							icon: "trash",
							destructive: true,
							requiresOnline: true,
							onPress: async () => {
								await runBulk({
									items: selectedNotes,
									clearSelection: () => useNotesStore.getState().clearSelectedNotes(),
									confirm: {
										title: "tbd_trash_selected",
										message: "tbd_are_you_sure_trash_selected_notes",
										okText: "tbd_trash",
										cancelText: "tbd_cancel",
										destructive: true
									},
									op: n => notesLib.trash({ note: n })
								})
							}
						})
					}

					// Permanent delete: every note must already be trashed.
					if (noteFlags.everyTrashed) {
						menuButtons.push({
							id: "bulkDelete",
							title: "tbd_delete_selected",
							icon: "delete",
							destructive: true,
							requiresOnline: true,
							onPress: async () => {
								await runBulk({
									items: selectedNotes,
									clearSelection: () => useNotesStore.getState().clearSelectedNotes(),
									confirm: {
										title: "tbd_delete_selected",
										message: "tbd_are_you_sure_delete_selected_notes",
										okText: "tbd_delete",
										cancelText: "tbd_cancel",
										destructive: true
									},
									op: n => notesLib.delete({ note: n })
								})
							}
						})
					}
				}

				if (noteFlags.participantOfEveryAndNotOwner) {
					menuButtons.push({
						id: "bulkLeave",
						title: "tbd_leave_selected",
						icon: "exit",
						destructive: true,
						requiresOnline: true,
						onPress: async () => {
							await runBulk({
								items: selectedNotes,
								clearSelection: () => useNotesStore.getState().clearSelectedNotes(),
								confirm: {
									title: "tbd_leave_selected",
									message: "tbd_are_you_sure_leave_selected_notes",
									okText: "tbd_leave",
									cancelText: "tbd_cancel",
									destructive: true
								},
								op: n => notesLib.leave({ note: n })
							})
						}
					})
				}
			}
		} else {
			if (notesTags.length > 0) {
				menuButtons.push({
					id: "selectAll",
					title: selectedTags.length === notesTags.length ? "tbd_deselect_all" : "tbd_select_all",
					icon: "select",
					onPress: () => {
						if (selectedTags.length === notesTags.length) {
							useNotesStore.getState().clearSelectedTags()

							return
						}

						useNotesStore.getState().selectAllTags(notesTags)
					}
				})
			}

			if (selectedTags.length > 0) {
				menuButtons.push({
					id: "bulkFavorite",
					title: tagFlags.includesFavorited ? "tbd_unfavorite_selected" : "tbd_favorite_selected",
					icon: "heart",
					requiresOnline: true,
					onPress: async () => {
						await runBulk({
							items: selectedTags,
							clearSelection: () => useNotesStore.getState().clearSelectedTags(),
							op: t => notesLib.favoriteTag({ tag: t, favorite: !tagFlags.includesFavorited })
						})
					}
				})

				menuButtons.push({
					id: "bulkDelete",
					title: "tbd_delete_selected",
					icon: "delete",
					destructive: true,
					requiresOnline: true,
					onPress: async () => {
						await runBulk({
							items: selectedTags,
							clearSelection: () => useNotesStore.getState().clearSelectedTags(),
							confirm: {
								title: "tbd_delete_all_tags",
								message: "tbd_delete_all_tags_confirmation",
								okText: "tbd_delete_all",
								cancelText: "tbd_cancel",
								destructive: true
							},
							op: t => notesLib.deleteTag({ tag: t })
						})
					}
				})
			}
		}

		if (selectedNotes.length === 0 && selectedTags.length === 0) {
			menuButtons.push({
				id: "createTag",
				title: "tbd_create_tag",
				icon: "tag",
				onPress: async () => {
					const result = await run(async () => {
						return await prompts.input({
							title: "tbd_create_tag",
							message: "tbd_enter_tag_name",
							cancelText: "tbd_cancel",
							okText: "tbd_create"
						})
					})

					if (!result.success) {
						console.error(result.error)
						alerts.error(result.error)

						return
					}

					if (result.data.cancelled || result.data.type !== "string") {
						return
					}

					const tagName = result.data.value.trim()

					if (tagName.length === 0) {
						return
					}

					const createResult = await runWithLoading(async () => {
						return await notesLib.createTag({
							name: tagName
						})
					})

					if (!createResult.success) {
						console.error(createResult.error)
						alerts.error(createResult.error)

						return
					}
				}
			})
		}

		if (!tag && selectedNotes.length === 0 && selectedTags.length === 0) {
			menuButtons.push({
				id: "viewMode",
				title: "tbd_viewMode",
				icon: notesViewMode === "notes" ? "list" : "tag",
				subButtons: [
					{
						title: "tbd_notes_view",
						id: "notesView",
						icon: "list",
						checked: notesViewMode === "notes",
						onPress: () => {
							useNotesStore.getState().clearSelectedNotes()
							useNotesStore.getState().clearSelectedTags()

							setNotesViewMode("notes")
						}
					},
					{
						title: "tbd_tags_view",
						id: "tagsView",
						icon: "tag",
						checked: notesViewMode === "tags",
						onPress: () => {
							useNotesStore.getState().clearSelectedNotes()
							useNotesStore.getState().clearSelectedTags()

							setNotesViewMode("tags")
						}
					}
				]
			})
		}

		if (menuButtons.length > 0) {
			items.push({
				type: "menu",
				props: {
					type: "dropdown",
					hitSlop: 20,
					buttons: menuButtons
				},
				triggerProps: {
					hitSlop: 20
				},
				icon: {
					name: "ellipsis-horizontal",
					size: 24,
					color: textForeground.color
				}
			})
		}

		return items
	})()

	const headerLeftItems = (() => {
		if (selectedNotes.length === 0 && selectedTags.length === 0) {
			return []
		}

		return [
			{
				type: "button",
				icon: {
					name: "close-outline",
					color: textForeground.color,
					size: 20
				},
				props: {
					onPress: () => {
						useNotesStore.getState().clearSelectedNotes()
						useNotesStore.getState().clearSelectedTags()
					}
				}
			}
		] satisfies HeaderItem[]
	})()

	const title = (() => {
		if (viewMode === "notes") {
			if (selectedNotes.length > 0) {
				return `${selectedNotes.length} tbd_selected`
			}

			return "tbd_notes"
		} else {
			if (selectedTags.length > 0) {
				return `${selectedTags.length} tbd_selected`
			}

			return "tbd_tags"
		}
	})()

	return (
		<StackHeader
			transparent={Platform.OS === "ios"}
			title={title}
			leftItems={headerLeftItems}
			rightItems={headerRightItems}
			searchBarOptions={{
				placement: "integratedButton",
				placeholder: viewMode === "notes" ? "tbd_search_notes" : "tbd_search_tags",
				onChangeText: e => setSearchQuery(e.nativeEvent.text),
				onCancelButtonPress: () => setSearchQuery(""),
				onClose: () => setSearchQuery(""),
				onOpen: () => setSearchQuery(""),
				allowToolbarIntegration: false,
				headerIconColor: textForeground.color,
				textColor: textForeground.color,
				barTintColor: "transparent",
				tintColor: textForeground.color,
				hintTextColor: textMutedForeground.color,
				shouldShowHintSearchIcon: true,
				hideNavigationBar: false,
				hideWhenScrolling: false,
				inputType: "text"
			}}
		/>
	)
})

const Notes = memo(() => {
	const notesQuery = useNotesWithContentQuery()
	const [notesViewMode] = useSecureStore<"notes" | "tags">("notesViewMode", "notes")
	const { tagUuid } = useLocalSearchParams<{
		tagUuid?: string
	}>()
	const notesTagsQuery = useNotesTagsQuery()
	const [searchQuery, setSearchQuery] = useState<string>("")

	const tag = (() => {
		if (notesTagsQuery.status !== "success" || !tagUuid) {
			return null
		}

		return notesTagsQuery.data.find(t => t.uuid === tagUuid) ?? null
	})()

	const notes = ((): NoteListItem[] => {
		if (notesQuery.status !== "success") {
			return []
		}

		let notes = notesSorter.group({
			notes: notesQuery.data,
			groupArchived: true,
			groupTrashed: true,
			groupFavorited: true,
			groupPinned: true,
			tag: tag ?? undefined
		})

		if (searchQuery.length > 0) {
			const searchQueryNormalized = searchQuery.trim().toLowerCase()

			notes = notes.filter(note => {
				if (note.type === "header") {
					return false
				}

				if (note.title && note.title.toLowerCase().includes(searchQueryNormalized)) {
					return true
				}

				if (note.content && note.content.toLowerCase().includes(searchQueryNormalized)) {
					return true
				}

				return false
			})
		}

		return notes
	})()

	const notesTags = (() => {
		if (notesTagsQuery.status !== "success") {
			return []
		}

		let notesTags = notesTagsQuery.data.sort((a, b) => fastLocaleCompare(a.name ?? a.uuid, b.name ?? b.uuid))

		if (searchQuery.length > 0) {
			const searchQueryNormalized = searchQuery.trim().toLowerCase()

			notesTags = notesTags.filter(tag => {
				if (tag.name && tag.name.toLowerCase().includes(searchQueryNormalized)) {
					return true
				}

				return false
			})
		}

		return notesTags
	})()

	const notesForTag = (() => {
		if (notesQuery.status !== "success" || notesTagsQuery.status !== "success") {
			return {}
		}

		const index: Record<string, TNote[]> = {}

		for (const tag of notesTagsQuery.data) {
			index[tag.uuid] = []
		}

		for (const note of notesQuery.data) {
			for (const tag of note.tags) {
				const tagNotes = index[tag.uuid]

				if (tagNotes) {
					tagNotes.push(note)
				}
			}
		}

		return index
	})()

	const renderItemNotesView = (info: ListRenderItemInfo<NoteListItem>) => {
		return (
			<Note
				info={info}
				nextNote={notes[info.index + 1]}
				prevNote={notes[info.index - 1]}
			/>
		)
	}

	const renderItemTagsView = (info: ListRenderItemInfo<NoteTag>) => {
		return (
			<Tag
				info={info}
				notesForTag={notesForTag[info.item.uuid] ?? []}
			/>
		)
	}

	const keyExtractorNotesView = (note: NoteListItem) => {
		return note.type === "header" ? note.id : note.uuid
	}

	const keyExtractorTagsView = (tag: NoteTag) => {
		return tag.uuid
	}

	const onRefresh = async () => {
		if (!onlineManager.isOnline()) {
			return
		}

		const result = await run(async () => {
			await notesQuery.refetch()
		})

		if (!result.success) {
			console.error(result.error)
			alerts.error(result.error)
		}
	}

	const viewMode = tag ? "notes" : notesViewMode

	useFocusEffect(
		useCallback(() => {
			useNotesStore.getState().clearSelectedNotes()
			useNotesStore.getState().clearSelectedTags()

			return () => {
				useNotesStore.getState().clearSelectedNotes()
				useNotesStore.getState().clearSelectedTags()
			}
		}, [])
	)

	const notesEmptyComponent = () => (
		<ListEmpty
			icon="document-text-outline"
			title="tbd_no_notes"
		/>
	)

	const tagsEmptyComponent = () => (
		<ListEmpty
			icon="pricetag-outline"
			title="tbd_no_tags"
		/>
	)

	return (
		<Fragment>
			<Header setSearchQuery={setSearchQuery} />
			<SafeAreaView edges={["left", "right"]}>
				{viewMode === "notes" ? (
					<VirtualList
						className="flex-1"
						contentInsetAdjustmentBehavior="automatic"
						contentContainerClassName={cn("pb-40", Platform.OS === "android" && "pb-96")}
						keyExtractor={keyExtractorNotesView}
						data={notes}
						renderItem={renderItemNotesView}
						loading={notesQuery.status !== "success"}
						onRefresh={onRefresh}
						emptyComponent={notesEmptyComponent}
					/>
				) : (
					<VirtualList
						className="flex-1"
						contentInsetAdjustmentBehavior="automatic"
						contentContainerClassName={cn("pb-40", Platform.OS === "android" && "pb-96")}
						keyExtractor={keyExtractorTagsView}
						data={notesTags}
						loading={notesTagsQuery.status !== "success"}
						renderItem={renderItemTagsView}
						onRefresh={onRefresh}
						emptyComponent={tagsEmptyComponent}
					/>
				)}
			</SafeAreaView>
		</Fragment>
	)
})

export default Notes
