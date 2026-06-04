import { Fragment, useState, memo, useCallback } from "react"
import { onlineManager } from "@tanstack/react-query"
import SafeAreaView from "@/components/ui/safeAreaView"
import StackHeader, { type HeaderItem } from "@/components/ui/header"
import useNotesWithContentQuery from "@/features/notes/queries/useNotesWithContent.query"
import { notesSorter } from "@/lib/sort"
import VirtualList, { type ListRenderItemInfo } from "@/components/ui/virtualList"
import ListEmpty from "@/components/ui/listEmpty"
import { NoteType } from "@filen/sdk-rs"
import { type Note as TNote, type NoteTag } from "@/types"
import { run, fastLocaleCompare, cn } from "@filen/utils"
import { noteDisplayTitle, tagDisplayName } from "@/lib/decryption"
import alerts from "@/lib/alerts"
import { Platform } from "react-native"
import { router, useLocalSearchParams, useFocusEffect } from "expo-router"
import { useResolveClassNames } from "uniwind"
import Note, { type ListItem as NoteListItem } from "@/features/notes/components/note"
import useNotesStore from "@/features/notes/store/useNotes.store"
import { useShallow } from "zustand/shallow"
import useNotesTagsQuery from "@/features/notes/queries/useNotesTags.query"
import { runWithLoading } from "@/components/ui/fullScreenLoadingModal"
import prompts from "@/lib/prompts"
import notesLib from "@/features/notes/notes"
import * as FileSystem from "expo-file-system"
import { useSecureStore } from "@/lib/secureStore"
import Tag from "@/features/notes/components/tag"
import type { MenuButton } from "@/components/ui/menu"
import { useStringifiedClient } from "@/lib/auth"
import * as Sharing from "expo-sharing"
import * as DocumentPicker from "expo-document-picker"
import { runBulk } from "@/lib/bulkOps"
import { aggregateNoteSelectionFlags, aggregateNoteTagSelectionFlags } from "@/features/notes/notesSelectors"
import { serialize } from "@/lib/serializer"
import { useTranslation } from "react-i18next"
import { NOTE_TYPE_LABEL_KEY, NOTE_TYPE_OPTIONS } from "@/features/notes/components/note/menu"

const Header = memo(({ setSearchQuery }: { setSearchQuery: React.Dispatch<React.SetStateAction<string>> }) => {
	const { t } = useTranslation()
	const stringifiedClient = useStringifiedClient()
	const textForeground = useResolveClassNames("text-foreground")
	const textMutedForeground = useResolveClassNames("text-muted-foreground")
	const selectedNotes = useNotesStore(useShallow(state => state.selectedNotes))
	const selectedTags = useNotesStore(useShallow(state => state.selectedTags))
	const [notesViewMode, setNotesViewMode] = useSecureStore<"notes" | "tags">("notesViewMode", "notes")
	const { tagUuid } = useLocalSearchParams<{
		tagUuid?: string
	}>()
	const tagFlags = aggregateNoteTagSelectionFlags(selectedTags)

	const notesTagsQuery = useNotesTagsQuery({
		enabled: false
	})

	const notesQuery = useNotesWithContentQuery({
		enabled: false
	})

	const liveNotes = notesQuery.status === "success" ? notesQuery.data : []
	const selectedNotesLive = selectedNotes.map(sel => liveNotes.find(live => live.uuid === sel.uuid) ?? sel)
	const noteFlags = aggregateNoteSelectionFlags(selectedNotesLive, stringifiedClient?.userId)

	const tag = (() => {
		if (notesTagsQuery.status !== "success" || !tagUuid) {
			return null
		}

		return notesTagsQuery.data.find(noteTag => noteTag.uuid === tagUuid) ?? null
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
		notesTagsQuery.status === "success"
			? [...notesTagsQuery.data].sort((a, b) => fastLocaleCompare(tagDisplayName(a), tagDisplayName(b)))
			: []

	const createNote = async (type: NoteType) => {
		const result = await run(async () => {
			return await prompts.input({
				title: t("create_note"),
				message: t("enter_note_name"),
				cancelText: t("cancel"),
				okText: t("create")
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
					title: selectedNotes.length === onlyNotes.length ? t("deselect_all") : t("select_all"),
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
					title: t("create_note"),
					icon: "plus",
					subButtons: [
						{
							title: t("note_type_text"),
							id: "text",
							icon: "text",
							onPress: async () => {
								await createNote(NoteType.Text)
							}
						},
						{
							title: t("note_type_checklist"),
							id: "checklist",
							icon: "checklist",
							onPress: async () => {
								await createNote(NoteType.Checklist)
							}
						},
						{
							title: t("note_type_markdown"),
							id: "markdown",
							icon: "markdown",
							onPress: async () => {
								await createNote(NoteType.Md)
							}
						},
						{
							title: t("note_type_code"),
							id: "code",
							icon: "code",
							onPress: async () => {
								await createNote(NoteType.Code)
							}
						},
						{
							title: t("note_type_richtext"),
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
					title: t("import_note"),
					icon: "export",
					subButtons: NOTE_TYPE_OPTIONS.map(
						({ type, typeString }) =>
							({
								id: `type_${typeString}`,
								title: t(NOTE_TYPE_LABEL_KEY[typeString]),
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
											alerts.error(t("import_file_not_found"))

											return
										}

										const assetFile = new FileSystem.File(asset.uri)

										if (!assetFile.exists || assetFile.size === 0) {
											alerts.error(t("import_file_not_found_or_empty"))

											return
										}

										defer(() => {
											if (assetFile.exists) {
												assetFile.delete()
											}
										})

										const promptResult = await run(async () => {
											return await prompts.input({
												title: t("import_note"),
												message: t("enter_note_name"),
												cancelText: t("cancel"),
												okText: t("import")
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
				// Non-destructive bulk actions (pin / favorite / type / tag / duplicate /
				// export) need decrypted metadata. Hide them when any selected note is
				// undecryptable. Trash / delete / restore-from-trash / leave appear below
				// and operate by uuid alone, so they stay visible for undecryptable too.
				if (!noteFlags.includesUndecryptable) {
					// Toggles (pin / favorite) sit first — one-tap, most-tapped.
					menuButtons.push({
						id: "bulkPin",
						title: noteFlags.includesPinned ? t("unpin_selected") : t("pin_selected"),
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
						title: noteFlags.includesFavorited ? t("unfavorite_selected") : t("favorite_selected"),
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
							title: t("type_change_selected"),
							icon: "text",
							requiresOnline: true,
							subButtons: NOTE_TYPE_OPTIONS.map(
								({ type, typeString }) =>
									({
										id: `type_${typeString}`,
										title: t(NOTE_TYPE_LABEL_KEY[typeString]),
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

					// Bulk tag goes through the same /noteTags screen as per-note tag
					// editing — the route accepts an array, computes tri-state per tag
					// (all / some / none selected), and lets the user add OR remove tags
					// across the whole selection. Add-only inline submenu was divergent
					// from the per-note flow and lacked a removal path.
					menuButtons.push({
						id: "bulkTag",
						title: t("bulk_tag_selected"),
						icon: "tag",
						requiresOnline: true,
						onPress: () => {
							router.push({
								pathname: "/noteTags",
								params: {
									notes: serialize(selectedNotes)
								}
							})
						}
					})

					menuButtons.push({
						id: "bulkDuplicate",
						title: t("duplicate_selected"),
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
						title: t("export_selected"),
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
				}

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

					// Archive: every note must be active (no archived, no trashed) AND no
					// undecryptable in the selection — the per-item undecryptable menu drops
					// archive too, so the bulk mirror does the same.
					if (!noteFlags.includesArchived && !noteFlags.includesTrashed && !noteFlags.includesUndecryptable) {
						menuButtons.push({
							id: "bulkArchive",
							title: t("archive_selected"),
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

					// Restore: every note must be archived OR trashed (no active). For an
					// undecryptable selection the per-item menu only offers restore when the
					// note is trashed (archive isn't possible on undecryptable items), so the
					// bulk mirror requires everyTrashed when undecryptable is in the mix.
					if (noteFlags.everyArchivedOrTrashed && (!noteFlags.includesUndecryptable || noteFlags.everyTrashed)) {
						menuButtons.push({
							id: "bulkRestore",
							title: t("restore_selected"),
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
							title: t("trash_selected"),
							icon: "trash",
							destructive: true,
							requiresOnline: true,
							onPress: async () => {
								await runBulk({
									items: selectedNotes,
									clearSelection: () => useNotesStore.getState().clearSelectedNotes(),
									confirm: {
										title: t("trash_selected"),
										message: t("are_you_sure_trash_selected_notes"),
										okText: t("trash"),
										cancelText: t("cancel"),
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
							title: t("delete_selected"),
							icon: "delete",
							destructive: true,
							requiresOnline: true,
							onPress: async () => {
								await runBulk({
									items: selectedNotes,
									clearSelection: () => useNotesStore.getState().clearSelectedNotes(),
									confirm: {
										title: t("delete_selected"),
										message: t("are_you_sure_delete_selected_notes"),
										okText: t("delete"),
										cancelText: t("cancel"),
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
						title: t("leave_selected"),
						icon: "exit",
						destructive: true,
						requiresOnline: true,
						onPress: async () => {
							await runBulk({
								items: selectedNotes,
								clearSelection: () => useNotesStore.getState().clearSelectedNotes(),
								confirm: {
									title: t("leave_selected"),
									message: t("are_you_sure_leave_selected_notes"),
									okText: t("leave"),
									cancelText: t("cancel"),
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
					title: selectedTags.length === notesTags.length ? t("deselect_all") : t("select_all"),
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
					title: tagFlags.includesFavorited ? t("unfavorite_selected") : t("favorite_selected"),
					icon: "heart",
					requiresOnline: true,
					onPress: async () => {
						await runBulk({
							items: selectedTags,
							clearSelection: () => useNotesStore.getState().clearSelectedTags(),
							op: selectedTag => notesLib.favoriteTag({ tag: selectedTag, favorite: !tagFlags.includesFavorited })
						})
					}
				})

				menuButtons.push({
					id: "bulkDelete",
					title: t("delete_selected"),
					icon: "delete",
					destructive: true,
					requiresOnline: true,
					onPress: async () => {
						await runBulk({
							items: selectedTags,
							clearSelection: () => useNotesStore.getState().clearSelectedTags(),
							confirm: {
								title: t("delete_all_tags_title"),
								message: t("delete_all_tags_confirmation"),
								okText: t("delete_all_tags"),
								cancelText: t("cancel"),
								destructive: true
							},
							op: selectedTag => notesLib.deleteTag({ tag: selectedTag })
						})
					}
				})
			}
		}

		if (selectedNotes.length === 0 && selectedTags.length === 0) {
			menuButtons.push({
				id: "createTag",
				title: t("create_tag"),
				icon: "tag",
				onPress: async () => {
					const result = await run(async () => {
						return await prompts.input({
							title: t("create_tag"),
							message: t("enter_tag_name"),
							cancelText: t("cancel"),
							okText: t("create")
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
				title: t("view_mode"),
				icon: notesViewMode === "notes" ? "list" : "tag",
				subButtons: [
					{
						title: t("notes_view"),
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
						title: t("tags_view"),
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
				return t("selected", { count: selectedNotes.length })
			}

			return t("notes")
		} else {
			if (selectedTags.length > 0) {
				return t("selected", { count: selectedTags.length })
			}

			return t("tags")
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
				placeholder: viewMode === "notes" ? t("search_notes") : t("search_tags"),
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
	const { t } = useTranslation()
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

		return notesTagsQuery.data.find(noteTag => noteTag.uuid === tagUuid) ?? null
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

				if (noteDisplayTitle(note).toLowerCase().includes(searchQueryNormalized)) {
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

		let notesTags = [...notesTagsQuery.data].sort((a, b) => fastLocaleCompare(tagDisplayName(a), tagDisplayName(b)))

		if (searchQuery.length > 0) {
			const searchQueryNormalized = searchQuery.trim().toLowerCase()

			notesTags = notesTags.filter(tag => {
				if (tagDisplayName(tag).toLowerCase().includes(searchQueryNormalized)) {
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
			title={t("no_notes")}
		/>
	)

	const tagsEmptyComponent = () => (
		<ListEmpty
			icon="pricetag-outline"
			title={t("no_tags")}
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
