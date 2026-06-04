import { Fragment, useState, memo, useCallback } from "react"
import { onlineManager } from "@tanstack/react-query"
import SafeAreaView from "@/components/ui/safeAreaView"
import useNotesWithContentQuery from "@/features/notes/queries/useNotesWithContent.query"
import { notesSorter } from "@/lib/sort"
import VirtualList, { type ListRenderItemInfo } from "@/components/ui/virtualList"
import ListEmpty from "@/components/ui/listEmpty"
import { type Note as TNote, type NoteTag } from "@/types"
import { run, fastLocaleCompare, cn } from "@filen/utils"
import { noteDisplayTitle, tagDisplayName } from "@/lib/decryption"
import alerts from "@/lib/alerts"
import { Platform } from "react-native"
import { useLocalSearchParams, useFocusEffect } from "expo-router"
import Note, { type ListItem as NoteListItem } from "@/features/notes/components/note"
import useNotesStore from "@/features/notes/store/useNotes.store"
import useNotesTagsQuery from "@/features/notes/queries/useNotesTags.query"
import { useSecureStore } from "@/lib/secureStore"
import Tag from "@/features/notes/components/tag"
import { useTranslation } from "react-i18next"
import Header from "@/features/notes/components/header"

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
