import { Fragment, useState, useCallback, useEffect } from "react"
import { onlineManager } from "@tanstack/react-query"
import SafeAreaView from "@/components/ui/safeAreaView"
import useNotesQuery from "@/features/notes/queries/useNotesQuery"
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
import { useShallow } from "zustand/shallow"
import {
	NOTES_VIEW_MODES,
	narrowNotesForViewMode,
	notesViewModeAwaitsUser,
	type NotesViewMode
} from "@/features/notes/notesViewModes"
import { useStringifiedClient } from "@/lib/auth"
import Tag from "@/features/notes/components/tag"
import { useTranslation } from "react-i18next"
import Header from "@/features/notes/components/header"
import {
	filterNoteListItemsBySearchQuery,
	filterNoteTagsBySearchQuery,
	filterNotesByBlockedOwner,
	filterUntaggedNotes,
	withUntaggedTag,
	createUntaggedTag,
	isUntaggedTagUuid,
	UNTAGGED_TAG_UUID
} from "@/features/notes/utils"
import { LazyWrapper } from "@/components/lazyWrapper"
import useIsOnline from "@/hooks/useIsOnline"
import useNotesOfflineStore from "@/features/notes/store/useNotesOffline.store"
import notesOffline from "@/features/notes/notesOffline"
import useBlockedUsers from "@/features/contacts/hooks/useBlockedUsers"
import logger from "@/lib/logger"

const Notes = () => {
	const { t } = useTranslation()
	const isOnline = useIsOnline()
	const notesQuery = useNotesQuery()
	const blocked = useBlockedUsers()
	const [notesViewMode] = useSecureStore<NotesViewMode>("notesViewMode", "notes")
	const [tagsSortBy] = useNotesTagsSortBy()
	const { tagUuid } = useLocalSearchParams<{
		tagUuid?: string
	}>()
	const notesTagsQuery = useNotesTagsQuery()
	const [searchQuery, setSearchQuery] = useState<string>("")

	// Read the DATA, never the last fetch's verdict (#103).
	//
	// `refetchOnMount: "always"` fires a doomed request the moment this screen opens offline. It
	// fails, and TanStack flips `status` to "error" while KEEPING whatever data the query already
	// held — including the full list restored from the persisted cache at boot. Gating on
	// `status === "success"` therefore threw away a complete, perfectly good offline list and left
	// the screen spinning on top of it, which is exactly what made notes marked for offline use
	// unreachable while offline.
	//
	// `status` still decides the SPINNER below, but only its "pending" value: pending means there is
	// genuinely nothing to draw yet, whereas "error" with data in hand means draw the data.
	const notesData = notesQuery.data
	const notesTagsData = notesTagsQuery.data

	const tag = (() => {
		if (!tagUuid) {
			return null
		}

		// #84: the virtual "Untagged" row navigates with its sentinel uuid — it has no
		// entry in the tags query, so resolve it to the synthesized tag directly.
		if (isUntaggedTagUuid(tagUuid)) {
			return createUntaggedTag(t("untagged"))
		}

		if (!notesTagsData) {
			return null
		}

		return notesTagsData.find(noteTag => noteTag.uuid === tagUuid) ?? null
	})()

	const isUntaggedScreen = tag !== null && isUntaggedTagUuid(tag.uuid)

	// A tag screen always shows that tag's notes — the offline/tags preference belongs to the root
	// list, not to a drilled-in tag. Derived here rather than lower down because it now selects which
	// notes the list is built from, not just which list renders.
	const viewMode = tag ? "notes" : notesViewMode
	const markedOffline = useNotesOfflineStore(useShallow(state => state.marked))
	// The shared view classifies notes against the signed-in user, so it needs the id the header
	// already reads for its selection flags.
	const userId = useStringifiedClient()?.userId
	const awaitsUser = notesViewModeAwaitsUser({ viewMode, userId })
	// String key rather than the array itself: the store hands back a fresh array identity on every
	// update, which would re-run the purge on unrelated churn.
	const selectedNoteUuidsKey = useNotesStore(state => state.selectedNotes.map(note => note.uuid).join(","))

	// #84: notes without any tag, blocked-filtered like every other listing. Feeds the virtual
	// "Untagged" row (count/activity/inflight) and the sentinel-filtered screen.
	const untaggedNotes = ((): TNote[] => {
		if (!notesData) {
			return []
		}

		return filterUntaggedNotes(filterNotesByBlockedOwner(notesData, blocked))
	})()

	// The notes this view is built from, before grouping and search. Membership of THIS set is what
	// decides whether a note can be selected — search only hides rows, it does not remove them.
	const narrowedNotes = ((): TNote[] => {
		if (!notesData) {
			return []
		}

		// The virtual tag cannot go through group()'s uuid-based tag filter — pre-filter to the
		// untagged set instead and group untagged.
		if (isUntaggedScreen) {
			return untaggedNotes
		}

		return narrowNotesForViewMode({
			notes: filterNotesByBlockedOwner(notesData, blocked),
			viewMode,
			markedOffline,
			userId
		})
	})()

	const notes = ((): NoteListItem[] => {
		if (!notesData) {
			return []
		}

		// Every narrowed view (offline, shared) is the same list with fewer notes in it, so they all
		// keep the identical grouping (pinned / favorited / time buckets) rather than inventing a
		// second layout — what changes is which notes are in it, not how they read.
		const grouped = notesSorter.group({
			notes: narrowedNotes,
			groupArchived: true,
			groupTrashed: true,
			groupFavorited: true,
			groupPinned: true,
			tag: tag && !isUntaggedScreen ? tag : undefined
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

	// Same purge against the view's own membership rather than the note's existence: in a narrowed
	// view a note can leave the list while still existing, and the header's bulk actions must not keep
	// counting it. Offline membership IS the ledger (un-mark a note and it goes); shared membership is
	// the participant list (remove the last participant, or be removed yourself, and it goes).
	//
	// Reachable when a bulk removal fails partway — runBulk is fail-fast and deliberately keeps the
	// selection so the user can retry, but the notes it already un-marked are gone from this list.
	//
	// Keyed on the narrowed set, not on the ledger, so every view is covered by one rule; in the
	// unnarrowed views this converges to the same answer the blocked/live purges already give.
	const narrowedNoteUuidsKey = narrowedNotes.map(note => note.uuid).join(",")

	useEffect(() => {
		const narrowedUuids = new Set(narrowedNoteUuidsKey.length > 0 ? narrowedNoteUuidsKey.split(",") : [])
		const selected = useNotesStore.getState().selectedNotes
		const kept = selected.filter(note => narrowedUuids.has(note.uuid))

		if (kept.length !== selected.length) {
			useNotesStore.getState().setSelectedNotes(kept)
		}
		// `selectedNotes` is in the deps so a selection WRITE is re-checked too, not just a membership
		// change: the native header menu snapshots its closure when it opens, so "Select all" can
		// write a row that left the view while the menu was up. The length guard makes the re-run a
		// no-op once converged, so this cannot loop.
	}, [narrowedNoteUuidsKey, selectedNoteUuidsKey])

	// Built before notesTags: the tags sort (by "last activity" / note count) reads this index.
	const notesForTag = (() => {
		if (!notesData || !notesTagsData) {
			return {}
		}

		const index: Record<string, TNote[]> = {}

		for (const tag of notesTagsData) {
			index[tag.uuid] = []
		}

		for (const note of notesData) {
			for (const tag of note.tags) {
				const tagNotes = index[tag.uuid]

				if (tagNotes) {
					tagNotes.push(note)
				}
			}
		}

		// #84: the virtual row reads its notes through the same index as real tags.
		index[UNTAGGED_TAG_UUID] = untaggedNotes

		return index
	})()

	const notesTags = (() => {
		if (!notesTagsData) {
			return []
		}

		const sorted = sortNoteTags(notesTagsData, tagsSortBy, notesForTag)

		// #84: virtual "Untagged" row — appended AFTER the sort so it is always at the
		// bottom regardless of the sort preference; hidden when nothing is untagged.
		return filterNoteTagsBySearchQuery(withUntaggedTag(sorted, untaggedNotes.length, t("untagged")), searchQuery)
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
			await Promise.all([
				notesQuery.refetch(),
				notesTagsQuery.refetch(),
				// In the offline view "refresh" means "make my offline copies current", not just
				// "re-check which notes are in the list". force bypasses the min-interval floor, which
				// exists to absorb app-switcher flips and would otherwise swallow a deliberate pull.
				viewMode === "offline" ? notesOffline.sync({ force: true }) : Promise.resolve()
			])
		})

		if (!result.success) {
			logger.error("notes", "notes list refresh failed", { error: result.error })
			alerts.error(result.error)
		}
	}

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
	const liveTagUuidsKey = notesTagsData ? notesTagsData.map(noteTag => noteTag.uuid).join(",") : null

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
	const liveNoteUuidsKey = notesData ? notesData.map(note => note.uuid).join(",") : null

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

	// One empty state for every note-row view, resolved through the same table as the title and the
	// View menu — so a new view cannot inherit another one's copy by falling through a ternary. The
	// create action rides on `allowsCreate` for the same reason the header's create entry does: from a
	// narrowed view the new note would not appear here, which reads as the action having failed.
	const noteRowsEmptyComponent = () => {
		if (searchActive) {
			return (
				<ListEmpty
					icon="search-outline"
					title={t("no_results")}
					description={t("no_results_description")}
				/>
			)
		}

		const descriptor = NOTES_VIEW_MODES[viewMode]

		return (
			<ListEmpty
				icon={descriptor.empty.icon}
				title={t(descriptor.empty.titleKey)}
				description={t(descriptor.empty.descriptionKey)}
				action={
					descriptor.allowsCreate ? (
						<Button
							onPress={() => {
								// #84: a note created from the virtual screen must not be tag-attached.
								void createNoteFlow({ t, tag: isUntaggedScreen ? null : tag })
							}}
							disabled={!isOnline}
						>
							{t("create_note")}
						</Button>
					) : undefined
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
					{viewMode !== "tags" ? (
						<VirtualList
							className="flex-1"
							contentInsetAdjustmentBehavior="automatic"
							contentContainerClassName={cn("pb-40", Platform.OS === "android" && "pb-96")}
							keyExtractor={keyExtractorNotesView}
							data={notes}
							renderItem={renderItemNotesView}
							// `awaitsUser`: the shared view cannot classify anything until the signed-in user's
							// id resolves, and an empty list under "No shared notes" is a wrong answer rather
							// than a slow one.
							loading={notesQuery.status === "pending" || awaitsUser}
							onRefresh={onRefresh}
							emptyComponent={noteRowsEmptyComponent}
						/>
					) : (
						<VirtualList
							className="flex-1"
							contentInsetAdjustmentBehavior="automatic"
							contentContainerClassName={cn("pb-40", Platform.OS === "android" && "pb-96")}
							keyExtractor={keyExtractorTagsView}
							data={notesTags}
							loading={notesTagsQuery.status === "pending"}
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
