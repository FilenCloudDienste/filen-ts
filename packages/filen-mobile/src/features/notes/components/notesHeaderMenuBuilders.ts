import { type HeaderItem } from "@/components/ui/header"
import { type MenuButton } from "@/components/ui/menu"
import { selectAllMenuButton } from "@/components/ui/selectAllMenuButton"
import { type Icons } from "@/components/ui/menuIcons"
import { buildSortFieldButton, type SortDirectionOption } from "@/components/ui/sortFieldMenu"
import { NoteType } from "@filen/sdk-rs"
import { noteBulkActionAvailability, run, type NoteSelectionFlags, type NoteTagsSortBy } from "@filen/shared"
import alerts from "@/lib/alerts"
import { Platform } from "react-native"
import { router } from "@/lib/router"
import useNotesStore from "@/features/notes/store/useNotes.store"
import { runWithLoading } from "@/components/ui/fullScreenLoadingModal"
import { inputPrompt } from "@/lib/promptFlow"
import notesLib from "@/features/notes/notes"
import { isUntaggedTagUuid } from "@/features/notes/utils"
import { shareTmpFile } from "@/lib/share"
import { pickDocuments } from "@/lib/documentPicker"
import * as FileSystem from "expo-file-system"
import { runBulk } from "@/lib/bulkOps"
import notesOffline from "@/features/notes/notesOffline"
import { createNoteSubButtons, NOTE_TYPE_LABEL_KEY, NOTE_TYPE_OPTIONS, noteTypeToIcon } from "@/features/notes/components/note/menu"
import { createTagFlow } from "@/features/notes/components/notesActions"
import { type TFunction } from "i18next"
import type { Note, NoteTag } from "@/types"
import { NOTES_VIEW_MODES, NOTES_VIEW_MODE_ORDER, type NotesViewMode } from "@/features/notes/notesViewModes"
import logger from "@/lib/logger"

// Sort picker for the tags view, mirroring the drive header's buildSortMenuButton structure.
// buildSortFieldButton keeps each field's directions as a nested submenu on iOS and collapses them
// into a direction ActionSheet on Android (which cannot render a 3rd menu level — see
// components/ui/sortFieldMenu).
export function buildTagsSortMenuButton(current: NoteTagsSortBy, setSort: (next: NoteTagsSortBy) => void, t: TFunction): MenuButton {
	const field = (
		id: string,
		title: string,
		icon: Icons,
		first: SortDirectionOption<NoteTagsSortBy>,
		second: SortDirectionOption<NoteTagsSortBy>
	): MenuButton => buildSortFieldButton({ id, title, icon, options: [first, second], current, setSort, t })

	return {
		id: "tagsSort",
		title: t("sort_by"),
		icon: "list",
		subButtons: [
			field(
				"tagsSort.activity",
				t("sort_last_activity"),
				"clock",
				{ id: "tagsSort.activityDesc", title: t("sort_last_activity_newest"), value: "lastActivityDesc" },
				{ id: "tagsSort.activityAsc", title: t("sort_last_activity_oldest"), value: "lastActivityAsc" }
			),
			field(
				"tagsSort.name",
				t("sort_name"),
				"text",
				{ id: "tagsSort.nameAsc", title: t("sort_name_asc"), value: "nameAsc" },
				{ id: "tagsSort.nameDesc", title: t("sort_name_desc"), value: "nameDesc" }
			),
			field(
				"tagsSort.count",
				t("sort_note_count"),
				"doc",
				{ id: "tagsSort.countDesc", title: t("sort_note_count_most"), value: "notesCountDesc" },
				{ id: "tagsSort.countAsc", title: t("sort_note_count_fewest"), value: "notesCountAsc" }
			)
		]
	}
}

// One bulk entry: online-only, runs `op` over `items` via runBulk. A confirm makes it destructive.
function bulkMenuButton<T>({
	t,
	id,
	title,
	icon,
	items,
	clearSelection,
	op,
	confirm
}: {
	t: TFunction
	id: string
	title: string
	icon: Icons
	items: T[]
	clearSelection: () => void
	op: (item: T) => Promise<unknown>
	confirm?: {
		title: string
		message: string
		okText: string
	}
}): MenuButton {
	return {
		id,
		title,
		icon,
		destructive: confirm ? true : undefined,
		requiresOnline: true,
		onPress: async () => {
			await runBulk({
				items,
				clearSelection,
				confirm: confirm
					? {
							...confirm,
							cancelText: t("cancel"),
							destructive: true
						}
					: undefined,
				op
			})
		}
	}
}

// Builds the notes-screen header's right-hand menu (select-all / create / import / bulk
// note actions / bulk tag actions / create-tag / view-mode switch) from the current
// selection + view state. Extracted verbatim from the Header component's headerRightItems
// IIFE; pure given its inputs (reads selection via the passed-in values + the notes store's
// getState() for imperative selection mutations inside onPress handlers).
export function buildNotesHeaderRightItems({
	t,
	selectedNotes,
	selectedNotesLive,
	selectedTags,
	notesViewMode,
	setNotesViewMode,
	tagsSortBy,
	setTagsSortBy,
	noteFlags,
	markedOffline,
	tag,
	viewMode,
	onlyNotes,
	notesTags,
	createNote
}: {
	t: TFunction
	// The raw selection — drives selection-count gating, the select-all toggle and the
	// "N selected" title. May contain ghosts (remote-deleted notes still in the store).
	selectedNotes: Note[]
	// #42 / D7: the LIVE, ghost-purged selection (selected notes still present in the query
	// result). ALL bulk ops + export + bulk-tag operate on THIS set so a remote-deleted note
	// can't fail the whole batch. noteFlags is already aggregated from this same set in the caller.
	selectedNotesLive: Note[]
	selectedTags: NoteTag[]
	notesViewMode: NotesViewMode
	setNotesViewMode: (fn: NotesViewMode | ((prev: NotesViewMode) => NotesViewMode)) => void
	tagsSortBy: NoteTagsSortBy
	setTagsSortBy: (next: NoteTagsSortBy) => void
	noteFlags: NoteSelectionFlags
	// uuid -> true for every note kept on the device. Read reactively by the caller from the
	// offline-notes store, so the entries below flip the moment the ledger changes.
	markedOffline: Record<string, true>
	tag: NoteTag | null
	viewMode: NotesViewMode
	onlyNotes: Note[]
	notesTags: NoteTag[]
	createNote: (type: NoteType) => Promise<void>
}): HeaderItem[] {
	const items: HeaderItem[] = []
	const menuButtons: MenuButton[] = []
	const clearSelectedNotes = () => useNotesStore.getState().clearSelectedNotes()
	const clearSelectedTags = () => useNotesStore.getState().clearSelectedTags()

	// Both note-row views: the offline view renders the same rows, so it needs the same select-all and
	// the same bulk actions. `onlyNotes` is already the narrowed set there, so select-all selects the
	// offline notes and nothing else.
	if (viewMode !== "tags") {
		if (onlyNotes.length > 0) {
			menuButtons.push(
				selectAllMenuButton({
					t,
					allSelected: selectedNotes.length === onlyNotes.length,
					onClear: clearSelectedNotes,
					onSelectAll: () => useNotesStore.getState().selectAllNotes(onlyNotes)
				})
			)
		}

		// A note created from a narrowed view is neither kept on the device nor shared with anyone, so
		// it would be absent from the list the user is looking at — indistinguishable from the action
		// having failed. `allowsCreate` carries that per view rather than naming one here, so a new
		// narrowed view cannot inherit the entry by omission.
		if (selectedNotes.length === 0 && NOTES_VIEW_MODES[viewMode].allowsCreate) {
			menuButtons.push({
				id: "create",
				title: t("create_note"),
				icon: "plus",
				requiresOnline: true,
				subButtons: createNoteSubButtons(t, createNote)
			})

			menuButtons.push({
				id: "import",
				title: t("import_note"),
				icon: "import",
				requiresOnline: true,
				subButtons: NOTE_TYPE_OPTIONS.map(
					({ type, typeString }) =>
						({
							id: `type_${typeString}`,
							title: t(NOTE_TYPE_LABEL_KEY[typeString]),
							icon: noteTypeToIcon(type),
							keepMenuOpenOnPress: Platform.OS === "android",
							requiresOnline: true,
							onPress: () => {
								run(async defer => {
									const documentPickerResult = await run(async () => {
										return await pickDocuments({
											// Our own exports are .md / .html now (#83), and code files
											// often surface as octet-stream on Android SAF — text/plain
											// alone made re-importing them impossible.
											type: ["text/*", "application/octet-stream", "application/json", "application/xml"],
											multiple: false
										})
									})

									if (!documentPickerResult.success) {
										logger.error("notes", "import note document picker failed", { error: documentPickerResult.error })
										alerts.error(documentPickerResult.error)

										return
									}

									if (documentPickerResult.data.canceled) {
										return
									}

									const asset = documentPickerResult.data.documents[0]

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

									const newName = await inputPrompt(
										{
											title: t("import_note"),
											message: t("enter_note_name"),
											cancelText: t("cancel"),
											okText: t("import")
										},
										{ tag: "notes", message: "import note name prompt failed", level: "error" },
										{ trim: true }
									)

									if (newName === null) {
										return
									}

									const createResult = await runWithLoading(async () => {
										return await notesLib.importFromFile({
											uri: asset.uri,
											title: newName,
											type,
											// On a tag-filtered screen the import attaches that tag
											// (parity with create); the virtual "Untagged" screen
											// attaches nothing so the note lands in the viewed list.
											tag: tag && !isUntaggedTagUuid(tag.uuid) ? tag : undefined
										})
									})

									if (!createResult.success) {
										logger.error("notes", "import note from file failed", { error: createResult.error })
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
			// Uuid-only, so it lives OUTSIDE the undecryptable gate below with trash/delete/leave: a
			// note that became undecryptable after being marked must still be removable, or its badge
			// and cached body are stuck for good.
			const markedSelection = selectedNotesLive.filter(n => markedOffline[n.uuid] === true)

			if (markedSelection.length > 0) {
				menuButtons.push({
					id: "bulkRemoveOffline",
					title: t("remove_offline"),
					icon: "trash",
					destructive: true,
					onPress: async () => {
						// Confirmed, unlike the single-note action: one mis-tap here can undo fifty
						// marks, and re-marking them is fifty menu round trips. Nothing is destroyed
						// either way — the notes stay in the cloud — so the prompt is about effort,
						// not danger.
						await runBulk({
							items: markedSelection,
							clearSelection: clearSelectedNotes,
							confirm: {
								title: t("remove_offline"),
								message: t("confirm_remove_notes_offline_selected"),
								okText: t("remove_offline"),
								cancelText: t("cancel"),
								destructive: true
							},
							op: n => notesOffline.unmark({ uuid: n.uuid })
						})
					}
				})
			}

			// Pure decision step — which of the eleven metadata/lifecycle actions this selection
			// permits, ahead of any MenuButton/dispatch construction below. Identical rule on web
			// (notesBulkActionBar.logic.ts's noteBulkActions). The two offline-caching entries above
			// and below have no shared-matrix counterpart and keep reading noteFlags directly.
			const bulkActionAvailability = noteBulkActionAvailability(noteFlags)

			// Toggles (pin / favorite) sit first — one-tap, most-tapped.
			if (bulkActionAvailability.pin) {
				menuButtons.push(
					bulkMenuButton({
						t,
						id: "bulkPin",
						title: noteFlags.includesPinned ? t("unpin_selected") : t("pin_selected"),
						icon: "pin",
						items: selectedNotesLive,
						clearSelection: clearSelectedNotes,
						op: n => notesLib.setPinned({ note: n, pinned: !noteFlags.includesPinned })
					})
				)
			}

			if (bulkActionAvailability.favorite) {
				menuButtons.push(
					bulkMenuButton({
						t,
						id: "bulkFavorite",
						title: noteFlags.includesFavorited ? t("unfavorite_selected") : t("favorite_selected"),
						icon: "heart",
						items: selectedNotesLive,
						clearSelection: clearSelectedNotes,
						op: n => notesLib.setFavorited({ note: n, favorite: !noteFlags.includesFavorited })
					})
				)
			}

			// Offline availability. Device-side, so unlike its neighbours it is NOT gated on write
			// access — keeping a copy is a read, and a read-only share is a perfectly reasonable
			// thing to want on a plane. Has no web counterpart, so it stays outside the shared matrix,
			// reading noteFlags.includesUndecryptable directly rather than bulkActionAvailability.
			if (!noteFlags.includesUndecryptable) {
				const notMarked = selectedNotesLive.filter(n => markedOffline[n.uuid] !== true)

				if (notMarked.length > 0) {
					// Foreground (blocking) unlike the drive's equivalent: note bodies are small text
					// fetched inline, not multi-GB transfers with their own progress bar, so there is
					// nothing for the user to watch if we return early. notesOffline.mark bounds the
					// fan-out internally, so a large selection paces itself.
					menuButtons.push(
						bulkMenuButton({
							t,
							id: "bulkMakeAvailableOffline",
							title: t("make_available_offline"),
							icon: "download",
							items: notMarked,
							clearSelection: clearSelectedNotes,
							op: n => notesOffline.mark({ note: n })
						})
					)
				}
			}

			if (bulkActionAvailability.type) {
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
								icon: noteTypeToIcon(type),
								keepMenuOpenOnPress: Platform.OS === "android",
								requiresOnline: true,
								onPress: async () => {
									await runBulk({
										items: selectedNotesLive,
										clearSelection: clearSelectedNotes,
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
			if (bulkActionAvailability.tags) {
				menuButtons.push({
					id: "bulkTag",
					title: t("bulk_tag_selected"),
					icon: "tag",
					requiresOnline: true,
					onPress: () => {
						router.push({
							pathname: "/noteTags",
							params: {
								uuids: selectedNotesLive.map(n => n.uuid).join(",")
							}
						})
					}
				})
			}

			if (bulkActionAvailability.duplicate) {
				menuButtons.push(
					bulkMenuButton({
						t,
						id: "bulkDuplicate",
						title: t("duplicate_selected"),
						icon: "duplicate",
						items: selectedNotesLive,
						clearSelection: clearSelectedNotes,
						op: n => notesLib.duplicate({ note: n })
					})
				)
			}

			if (bulkActionAvailability.export) {
				menuButtons.push({
					id: "bulkExport",
					title: t("export_selected"),
					icon: "export",
					requiresOnline: true,
					onPress: async () => {
						const exportResult = await runWithLoading(async () => {
							if (selectedNotesLive.length === 1 && selectedNotesLive[0]) {
								return await notesLib.export({
									note: selectedNotesLive[0]
								})
							}

							return await notesLib.exportMultiple({
								notes: selectedNotesLive
							})
						})

						if (!exportResult.success) {
							logger.error("notes", "bulk export notes failed", { error: exportResult.error })
							alerts.error(exportResult.error)

							return
						}

						clearSelectedNotes()

						const result = await shareTmpFile({
							uri: exportResult.data.file.uri,
							name: exportResult.data.file.name,
							mimeType: "application/zip",
							cleanup: () => {
								exportResult.data.cleanup()
							}
						})

						if (!result.success) {
							logger.error("notes", "share bulk exported notes failed", { error: result.error })
							alerts.error(result.error)

							return
						}
					}
				})
			}

			if (bulkActionAvailability.archive) {
				menuButtons.push(
					bulkMenuButton({
						t,
						id: "bulkArchive",
						title: t("archive_selected"),
						icon: "archive",
						items: selectedNotesLive,
						clearSelection: clearSelectedNotes,
						op: n => notesLib.archive({ note: n })
					})
				)
			}

			if (bulkActionAvailability.restore) {
				menuButtons.push(
					bulkMenuButton({
						t,
						id: "bulkRestore",
						title: t("restore_selected"),
						icon: "restore",
						items: selectedNotesLive,
						clearSelection: clearSelectedNotes,
						op: n => notesLib.restore({ note: n })
					})
				)
			}

			if (bulkActionAvailability.trash) {
				menuButtons.push(
					bulkMenuButton({
						t,
						id: "bulkTrash",
						title: t("trash_selected"),
						icon: "trash",
						items: selectedNotesLive,
						clearSelection: clearSelectedNotes,
						confirm: {
							title: t("trash_selected"),
							message: t("are_you_sure_trash_selected_notes"),
							okText: t("trash")
						},
						op: n => notesLib.trash({ note: n })
					})
				)
			}

			if (bulkActionAvailability.delete) {
				menuButtons.push(
					bulkMenuButton({
						t,
						id: "bulkDelete",
						title: t("delete_selected"),
						icon: "delete",
						items: selectedNotesLive,
						clearSelection: clearSelectedNotes,
						confirm: {
							title: t("delete_selected"),
							message: t("are_you_sure_delete_selected_notes"),
							okText: t("delete")
						},
						op: n => notesLib.delete({ note: n })
					})
				)
			}

			if (bulkActionAvailability.leave) {
				menuButtons.push(
					bulkMenuButton({
						t,
						id: "bulkLeave",
						title: t("leave_selected"),
						icon: "exit",
						items: selectedNotesLive,
						clearSelection: clearSelectedNotes,
						confirm: {
							title: t("leave_selected"),
							message: t("are_you_sure_leave_selected_notes"),
							okText: t("leave")
						},
						op: n => notesLib.leave({ note: n })
					})
				)
			}
		}
	} else {
		if (notesTags.length > 0) {
			menuButtons.push(
				selectAllMenuButton({
					t,
					allSelected: selectedTags.length === notesTags.length,
					onClear: clearSelectedTags,
					onSelectAll: () => useNotesStore.getState().selectAllTags(notesTags)
				})
			)
		}

		if (selectedTags.length > 0) {
			const anyTagFavorited = selectedTags.some(selectedTag => selectedTag.favorite)

			menuButtons.push(
				bulkMenuButton({
					t,
					id: "bulkFavorite",
					title: anyTagFavorited ? t("unfavorite_selected") : t("favorite_selected"),
					icon: "heart",
					items: selectedTags,
					clearSelection: clearSelectedTags,
					op: selectedTag => notesLib.favoriteTag({ tag: selectedTag, favorite: !anyTagFavorited })
				})
			)

			menuButtons.push(
				bulkMenuButton({
					t,
					id: "bulkDelete",
					title: t("delete_selected"),
					icon: "delete",
					items: selectedTags,
					clearSelection: clearSelectedTags,
					confirm: {
						title: t("delete_all_tags_title"),
						message: t("delete_all_tags_confirmation"),
						okText: t("delete")
					},
					op: selectedTag => notesLib.deleteTag({ tag: selectedTag })
				})
			)
		}
	}

	if (selectedNotes.length === 0 && selectedTags.length === 0) {
		menuButtons.push({
			id: "createTag",
			title: t("create_tag"),
			icon: "tag",
			requiresOnline: true,
			onPress: async () => {
				await createTagFlow({ t })
			}
		})
	}

	// Tags-view sort picker — only meaningful in the tags view, outside selection mode.
	if (!tag && viewMode === "tags" && selectedNotes.length === 0 && selectedTags.length === 0) {
		menuButtons.push(buildTagsSortMenuButton(tagsSortBy, setTagsSortBy, t))
	}

	if (!tag && selectedNotes.length === 0 && selectedTags.length === 0) {
		menuButtons.push({
			id: "viewMode",
			title: t("view_mode"),
			icon: NOTES_VIEW_MODES[notesViewMode].icon,
			// Built from the shared table, so a view can never appear in the list body without also
			// being reachable from this menu.
			subButtons: NOTES_VIEW_MODE_ORDER.map(
				mode =>
					({
						title: t(NOTES_VIEW_MODES[mode].menuKey),
						id: `${mode}View`,
						icon: NOTES_VIEW_MODES[mode].icon,
						checked: notesViewMode === mode,
						onPress: () => {
							// The selection belongs to the list that made it: switching views changes which
							// notes exist to act on, so carrying it over would leave the header counting rows
							// that are no longer on screen.
							clearSelectedNotes()
							clearSelectedTags()

							setNotesViewMode(mode)
						}
					}) satisfies MenuButton
			)
		})
	}

	if (menuButtons.length > 0) {
		items.push({
			type: "ellipsisMenu",
			buttons: menuButtons
		})
	}

	return items
}
