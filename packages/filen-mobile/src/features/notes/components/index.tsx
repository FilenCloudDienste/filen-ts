import { Fragment, useState, useCallback, useEffect } from "react"
import { onlineManager } from "@tanstack/react-query"
import SafeAreaView from "@/components/ui/safeAreaView"
import useNotesWithContentQuery from "@/features/notes/queries/useNotesWithContent.query"
import { notesSorter } from "@/lib/sort"
import VirtualList, { type ListRenderItemInfo } from "@/components/ui/virtualList"
import ListEmpty from "@/components/ui/listEmpty"
import Button from "@/components/ui/button"
import { type Note as TNote, type NoteTag } from "@/types"
import { run, cn } from "@filen/utils"
import { createNoteFlow, createTagFlow } from "@/features/notes/components/notesActions"
import { sortNoteTags, useNotesTagsSortBy } from "@/features/notes/notesTagsSortPreference"
import alerts from "@/lib/alerts"
import { Platform } from "react-native"
import { useLocalSearchParams, useFocusEffect } from "expo-router"
import Note, { type ListItem as NoteListItem, type DataItem as NoteDataItem } from "@/features/notes/components/note"
import useNotesStore from "@/features/notes/store/useNotes.store"
import useNotesTagsQuery from "@/features/notes/queries/useNotesTags.query"
import { useSecureStore } from "@/lib/secureStore"
import Tag from "@/features/notes/components/tag"
import { useTranslation } from "react-i18next"
import Header from "@/features/notes/components/header"
import { filterNoteListItemsBySearchQuery, filterNoteTagsBySearchQuery, filterNotesByBlockedOwner } from "@/features/notes/utils"
import { LazyWrapper } from "@/components/lazyWrapper"
import useIsOnline from "@/hooks/useIsOnline"
import useBlockedUsers from "@/features/contacts/hooks/useBlockedUsers"
import logger from "@/lib/logger"

const Notes = () => {
	const { t } = useTranslation()
	const isOnline = useIsOnline()
	const notesQuery = useNotesWithContentQuery()
	const blocked = useBlockedUsers()
	const [notesViewMode] = useSecureStore<"notes" | "tags">("notesViewMode", "notes")
	const [tagsSortBy] = useNotesTagsSortBy()
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

		const grouped = notesSorter.group({
			notes: filterNotesByBlockedOwner(notesQuery.data, blocked),
			groupArchived: true,
			groupTrashed: true,
			groupFavorited: true,
			groupPinned: true,
			tag: tag ?? undefined
		})

		return filterNoteListItemsBySearchQuery(grouped, searchQuery)
	})()

	// The visible note rows the list actually renders (data items only). Passed to the
	// Header so select-all / deselect-all operate on the SAME search-filtered set —
	// otherwise they'd silently target search-hidden notes (#15).
	const visibleNotes = notes.filter((note): note is NoteDataItem => note.type === "note")

	// Stale-selection purge: if a note's owner becomes blocked while it's selected, the note is
	// hidden from the list, so drop it from the selection too — keeps bulk actions honest.
	useEffect(() => {
		const selected = useNotesStore.getState().selectedNotes
		const kept = selected.filter(note => !blocked.userIds.has(note.ownerId))

		if (kept.length !== selected.length) {
			useNotesStore.getState().setSelectedNotes(kept)
		}
	}, [blocked])

	// Built before notesTags: the tags sort (by "last activity" / note count) reads this index.
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

	const notesTags = (() => {
		if (notesTagsQuery.status !== "success") {
			return []
		}

		const sorted = sortNoteTags(notesTagsQuery.data, tagsSortBy, notesForTag)

		return filterNoteTagsBySearchQuery(sorted, searchQuery)
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
			await Promise.all([notesQuery.refetch(), notesTagsQuery.refetch()])
		})

		if (!result.success) {
			logger.error("notes", "notes list refresh failed", { error: result.error })
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

	// Selection-ghost purge (#37): a per-tag delete (tag context menu → Delete) or a
	// remote delete optimistically strips the tag from notesTagsQuery but never touches
	// selectedTags, leaving a ghost that breaks the select/deselect-all toggle and lets
	// bulk ops target a tag that no longer exists. Reconcile selectedTags against the
	// authoritative (unfiltered) tag set whenever the query data changes — keyed on the
	// live tag uuids so search filtering (which only hides, not removes) doesn't prune.
	const liveTagUuidsKey = notesTagsQuery.status === "success" ? notesTagsQuery.data.map(noteTag => noteTag.uuid).join(",") : null

	useEffect(() => {
		if (liveTagUuidsKey === null) {
			return
		}

		const liveTagUuids = new Set(liveTagUuidsKey.length > 0 ? liveTagUuidsKey.split(",") : [])

		useNotesStore.getState().setSelectedTags(prev => {
			const pruned = prev.filter(selectedTag => liveTagUuids.has(selectedTag.uuid))

			return pruned.length === prev.length ? prev : pruned
		})
	}, [liveTagUuidsKey])

	// Selection-ghost purge (#42): a remote NoteEvent_Tags.Deleted removes the note from
	// the query cache but selectedNotes is only pruned synchronously in the socket handler
	// for the primary case. This reconciliation effect is the defense-in-depth mirror of
	// the selectedTags purge above — it prunes selectedNotes against the UNFILTERED live
	// note uuid set so any ghost that slips through (e.g. from other removal paths) is
	// caught before it can inflate the count, break select-all, or fail a bulk op.
	const liveNoteUuidsKey = notesQuery.status === "success" ? notesQuery.data.map(note => note.uuid).join(",") : null

	useEffect(() => {
		if (liveNoteUuidsKey === null) {
			return
		}

		const liveNoteUuids = new Set(liveNoteUuidsKey.length > 0 ? liveNoteUuidsKey.split(",") : [])

		useNotesStore.getState().setSelectedNotes(prev => {
			const pruned = prev.filter(selectedNote => liveNoteUuids.has(selectedNote.uuid))

			return pruned.length === prev.length ? prev : pruned
		})
	}, [liveNoteUuidsKey])

	const searchActive = searchQuery.trim().length > 0

	const notesEmptyComponent = () => {
		if (searchActive) {
			return (
				<ListEmpty
					icon="search-outline"
					title={t("no_results")}
					description={t("no_results_description")}
				/>
			)
		}

		return (
			<ListEmpty
				icon="document-text-outline"
				title={t("no_notes")}
				description={t("no_notes_description")}
				action={
					<Button
						onPress={() => {
							void createNoteFlow({ t, tag })
						}}
						disabled={!isOnline}
					>
						{t("create_note")}
					</Button>
				}
			/>
		)
	}

	const tagsEmptyComponent = () => {
		if (searchActive) {
			return (
				<ListEmpty
					icon="search-outline"
					title={t("no_results")}
					description={t("no_results_description")}
				/>
			)
		}

		return (
			<ListEmpty
				icon="pricetag-outline"
				title={t("no_tags")}
				description={t("no_tags_description")}
				action={
					<Button
						onPress={() => {
							void createTagFlow({ t })
						}}
						disabled={!isOnline}
					>
						{t("create_tag")}
					</Button>
				}
			/>
		)
	}

	return (
		<Fragment>
			<Header
				setSearchQuery={setSearchQuery}
				visibleNotes={visibleNotes}
				visibleTags={notesTags}
			/>
			<SafeAreaView edges={["left", "right"]}>
				<LazyWrapper>
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
				</LazyWrapper>
			</SafeAreaView>
		</Fragment>
	)
}

export default Notes
