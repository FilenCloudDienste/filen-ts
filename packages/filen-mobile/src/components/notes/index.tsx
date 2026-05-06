import { Fragment, useState, memo, useCallback } from "react"
import SafeAreaView from "@/components/ui/safeAreaView"
import StackHeader, { type HeaderItem } from "@/components/ui/header"
import useNotesWithContentQuery from "@/queries/useNotesWithContent.query"
import { notesSorter } from "@/lib/sort"
import VirtualList, { type ListRenderItemInfo } from "@/components/ui/virtualList"
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
import View from "@/components/ui/view"
import Text from "@/components/ui/text"
import type { MenuButton } from "@/components/ui/menu"
import { useStringifiedClient } from "@/lib/auth"
import * as Sharing from "expo-sharing"
import * as DocumentPicker from "expo-document-picker"

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
	const selectedNotesIncludesFavorited = useNotesStore(useShallow(state => state.selectedNotes.some(n => n.favorite)))
	const selectedNotesIncludesPinned = useNotesStore(useShallow(state => state.selectedNotes.some(n => n.pinned)))
	const selectedTagsIncludesFavorited = useNotesStore(useShallow(state => state.selectedTags.some(t => t.favorite)))
	const hasWriteAccessToAllSelectedNotes = useNotesStore(
		useShallow(state =>
			state.selectedNotes.every(
				n =>
					n.ownerId === stringifiedClient?.userId ||
					n.participants.some(p => p.userId === stringifiedClient?.userId && p.permissionsWrite)
			)
		)
	)
	const everySelectedNoteTrashed = useNotesStore(useShallow(state => state.selectedNotes.every(n => n.trash)))
	const everySelectedNoteArchived = useNotesStore(useShallow(state => state.selectedNotes.every(n => n.archive)))
	const everySelectedNoteOwned = useNotesStore(
		useShallow(state => state.selectedNotes.every(n => n.ownerId === stringifiedClient?.userId))
	)
	const selectedNotesIncludesTrashed = useNotesStore(useShallow(state => state.selectedNotes.some(n => n.trash)))
	const participantOfEverySelectedNote = useNotesStore(
		useShallow(state =>
			state.selectedNotes.every(
				n => n.participants.some(p => p.userId === stringifiedClient?.userId) && n.ownerId !== stringifiedClient?.userId
			)
		)
	)

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
							useNotesStore.getState().setSelectedNotes([])

							return
						}

						useNotesStore.getState().setSelectedNotes(onlyNotes)
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
				if (hasWriteAccessToAllSelectedNotes) {
					menuButtons.push({
						id: "type",
						title: "tbd_type_change_selected",
						icon: "text",
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
									onPress: async () => {
										const result = await runWithLoading(async defer => {
											defer(() => {
												useNotesStore.getState().setSelectedNotes([])
											})

											return await Promise.all(
												selectedNotes.map(async n => {
													const content = await notesLib.getContent({
														note: n
													})

													await notesLib.setType({
														note: n,
														type,
														knownContent: content
													})
												})
											)
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

				menuButtons.push({
					id: "bulkPin",
					title: selectedNotesIncludesPinned ? "tbd_unpin_selected" : "tbd_pin_selected",
					icon: "pin",
					onPress: async () => {
						const result = await runWithLoading(async defer => {
							defer(() => {
								useNotesStore.getState().setSelectedNotes([])
							})

							return await Promise.all(
								selectedNotes.map(n =>
									notesLib.setPinned({
										note: n,
										pinned: !selectedNotesIncludesPinned
									})
								)
							)
						})

						if (!result.success) {
							console.error(result.error)
							alerts.error(result.error)

							return
						}
					}
				})

				menuButtons.push({
					id: "bulkFavorite",
					title: selectedNotesIncludesFavorited ? "tbd_unfavorite_selected" : "tbd_favorite_selected",
					icon: "heart",
					onPress: async () => {
						const result = await runWithLoading(async defer => {
							defer(() => {
								useNotesStore.getState().setSelectedNotes([])
							})

							return await Promise.all(
								selectedNotes.map(n =>
									notesLib.setFavorited({
										note: n,
										favorite: !selectedNotesIncludesFavorited
									})
								)
							)
						})

						if (!result.success) {
							console.error(result.error)
							alerts.error(result.error)

							return
						}
					}
				})

				menuButtons.push({
					id: "bulkTag",
					title: "tbd_bulk_tag_selected",
					icon: "tag",
					subButtons: notesTags.map(subButton => {
						return {
							id: `bulkTag_${subButton.uuid}`,
							title: subButton.name ?? subButton.uuid,
							icon: "tag",
							keepMenuOpenOnPress: Platform.OS === "android",
							onPress: async () => {
								const result = await runWithLoading(async defer => {
									defer(() => {
										useNotesStore.getState().setSelectedNotes([])
									})

									return await Promise.all(
										selectedNotes.map(n =>
											notesLib.addTag({
												note: n,
												tag: subButton
											})
										)
									)
								})

								if (!result.success) {
									console.error(result.error)
									alerts.error(result.error)

									return
								}
							}
						}
					})
				})

				menuButtons.push({
					id: "bulkDuplicate",
					title: "tbd_duplicate_selected",
					icon: "duplicate",
					onPress: async () => {
						const result = await runWithLoading(async defer => {
							defer(() => {
								useNotesStore.getState().setSelectedNotes([])
							})

							return await Promise.all(
								selectedNotes.map(n =>
									notesLib.duplicate({
										note: n
									})
								)
							)
						})

						if (!result.success) {
							console.error(result.error)
							alerts.error(result.error)

							return
						}
					}
				})

				menuButtons.push({
					id: "bulkExport",
					title: "tbd_export_selected",
					icon: "export",
					onPress: async () => {
						const exportResult = await runWithLoading(async defer => {
							defer(() => {
								useNotesStore.getState().setSelectedNotes([])
							})

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

				if (everySelectedNoteOwned) {
					if (!everySelectedNoteArchived && !selectedNotesIncludesTrashed) {
						menuButtons.push({
							id: "bulkArchive",
							title: "tbd_archive_selected",
							icon: "archive",
							onPress: async () => {
								const result = await runWithLoading(async defer => {
									defer(() => {
										useNotesStore.getState().setSelectedNotes([])
									})

									return await Promise.all(
										selectedNotes.map(n =>
											notesLib.archive({
												note: n
											})
										)
									)
								})

								if (!result.success) {
									console.error(result.error)
									alerts.error(result.error)

									return
								}
							}
						})
					}

					if (everySelectedNoteArchived || everySelectedNoteTrashed) {
						menuButtons.push({
							id: "bulkRestore",
							title: "tbd_restore_selected",
							icon: "restore",
							onPress: async () => {
								const result = await runWithLoading(async defer => {
									defer(() => {
										useNotesStore.getState().setSelectedNotes([])
									})

									return await Promise.all(
										selectedNotes.map(n =>
											notesLib.restore({
												note: n
											})
										)
									)
								})

								if (!result.success) {
									console.error(result.error)
									alerts.error(result.error)

									return
								}
							}
						})
					}

					if (!everySelectedNoteTrashed) {
						menuButtons.push({
							id: "bulkTrash",
							title: "tbd_trash_selected",
							icon: "trash",
							destructive: true,
							onPress: async () => {
								const result = await runWithLoading(async defer => {
									defer(() => {
										useNotesStore.getState().setSelectedNotes([])
									})

									return await Promise.all(
										selectedNotes.map(n =>
											notesLib.trash({
												note: n
											})
										)
									)
								})

								if (!result.success) {
									console.error(result.error)
									alerts.error(result.error)

									return
								}
							}
						})
					} else {
						menuButtons.push({
							id: "bulkDelete",
							title: "tbd_delete_selected",
							icon: "delete",
							destructive: true,
							onPress: async () => {
								const result = await runWithLoading(async defer => {
									defer(() => {
										useNotesStore.getState().setSelectedNotes([])
									})

									return await Promise.all(
										selectedNotes.map(n =>
											notesLib.delete({
												note: n
											})
										)
									)
								})

								if (!result.success) {
									console.error(result.error)
									alerts.error(result.error)

									return
								}
							}
						})
					}
				}

				if (participantOfEverySelectedNote) {
					menuButtons.push({
						id: "bulkLeave",
						title: "tbd_leave_selected",
						icon: "exit",
						destructive: true,
						onPress: async () => {
							const result = await runWithLoading(async defer => {
								defer(() => {
									useNotesStore.getState().setSelectedNotes([])
								})

								return await Promise.all(
									selectedNotes.map(n =>
										notesLib.leave({
											note: n
										})
									)
								)
							})

							if (!result.success) {
								console.error(result.error)
								alerts.error(result.error)

								return
							}
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
							useNotesStore.getState().setSelectedTags([])

							return
						}

						useNotesStore.getState().setSelectedTags(notesTags)
					}
				})
			}

			if (selectedTags.length > 0) {
				menuButtons.push({
					id: "bulkFavorite",
					title: selectedTagsIncludesFavorited ? "tbd_unfavorite_selected" : "tbd_favorite_selected",
					icon: "heart",
					onPress: async () => {
						const result = await runWithLoading(async defer => {
							defer(() => {
								useNotesStore.getState().setSelectedTags([])
							})

							return await Promise.all(
								selectedTags.map(t =>
									notesLib.favoriteTag({
										tag: t,
										favorite: !selectedTagsIncludesFavorited
									})
								)
							)
						})

						if (!result.success) {
							console.error(result.error)
							alerts.error(result.error)

							return
						}
					}
				})

				menuButtons.push({
					id: "bulkDelete",
					title: "tbd_delete_selected",
					icon: "delete",
					destructive: true,
					onPress: async () => {
						const promptResponse = await run(async () => {
							return await prompts.alert({
								title: "tbd_delete_all_tags",
								message: "tbd_delete_all_tags_confirmation",
								cancelText: "tbd_cancel",
								okText: "tbd_delete_all"
							})
						})

						if (!promptResponse.success) {
							console.error(promptResponse.error)
							alerts.error(promptResponse.error)

							return
						}

						if (promptResponse.data.cancelled) {
							return
						}

						const result = await runWithLoading(async defer => {
							defer(() => {
								useNotesStore.getState().setSelectedTags([])
							})

							return await Promise.all(
								selectedTags.map(t =>
									notesLib.deleteTag({
										tag: t
									})
								)
							)
						})

						if (!result.success) {
							console.error(result.error)
							alerts.error(result.error)

							return
						}
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
							useNotesStore.getState().setSelectedNotes([])
							useNotesStore.getState().setSelectedTags([])

							setNotesViewMode("notes")
						}
					},
					{
						title: "tbd_tags_view",
						id: "tagsView",
						icon: "tag",
						checked: notesViewMode === "tags",
						onPress: () => {
							useNotesStore.getState().setSelectedNotes([])
							useNotesStore.getState().setSelectedTags([])

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
						useNotesStore.getState().setSelectedNotes([])
						useNotesStore.getState().setSelectedTags([])
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
			useNotesStore.getState().setSelectedNotes([])
			useNotesStore.getState().setSelectedTags([])

			return () => {
				useNotesStore.getState().setSelectedNotes([])
				useNotesStore.getState().setSelectedTags([])
			}
		}, [])
	)

	const notesEmptyComponent = () => {
		return (
			<View className="flex-1 items-center justify-center">
				<Text>tbd</Text>
			</View>
		)
	}

	const tagsEmptyComponent = () => {
		return (
			<View className="flex-1 items-center justify-center">
				<Text>tbd</Text>
			</View>
		)
	}

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
