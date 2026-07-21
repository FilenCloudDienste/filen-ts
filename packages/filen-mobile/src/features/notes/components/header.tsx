import StackHeader, { type HeaderItem } from "@/components/ui/header"
import useNotesQuery from "@/features/notes/queries/useNotesQuery"
import { NoteType } from "@filen/sdk-rs"
import { Platform } from "react-native"
import { useLocalSearchParams } from "expo-router"
import { useResolveClassNames } from "uniwind"
import useNotesStore from "@/features/notes/store/useNotes.store"
import { useShallow } from "zustand/shallow"
import useNotesTagsQuery from "@/features/notes/queries/useNotesTags.query"
import { useSecureStore } from "@/lib/secureStore"
import { useStringifiedClient } from "@/lib/auth"
import { aggregateNoteSelectionFlags, aggregateNoteTagSelectionFlags } from "@/features/notes/notesSelectors"
import { useTranslation } from "react-i18next"
import { buildNotesHeaderRightItems } from "@/features/notes/components/notesHeaderMenuBuilders"
import { useNotesTagsSortBy } from "@/features/notes/notesTagsSortPreference"
import { type DataItem as NoteDataItem } from "@/features/notes/components/note"
import { type NoteTag } from "@/types"
import { createNoteFlow } from "@/features/notes/components/notesActions"
import { isUntaggedTagUuid, createUntaggedTag } from "@/features/notes/utils"

export const Header = ({
	setSearchQuery,
	visibleNotes,
	visibleTags
}: {
	setSearchQuery: React.Dispatch<React.SetStateAction<string>>
	// The search-filtered note rows / tags the list body actually renders. Select-all
	// and the select/deselect-all toggle MUST operate on these same visible sets — not
	// the unfiltered query data — or they'd target search-hidden items (#15). With no
	// search active these equal the full sorted/grouped sets, so behavior is identical.
	visibleNotes: NoteDataItem[]
	visibleTags: NoteTag[]
}) => {
	const { t } = useTranslation()
	const stringifiedClient = useStringifiedClient()
	const textForeground = useResolveClassNames("text-foreground")
	const textMutedForeground = useResolveClassNames("text-muted-foreground")
	const selectedNotes = useNotesStore(useShallow(state => state.selectedNotes))
	const selectedTags = useNotesStore(useShallow(state => state.selectedTags))
	const [notesViewMode, setNotesViewMode] = useSecureStore<"notes" | "tags">("notesViewMode", "notes")
	const [tagsSortBy, setTagsSortBy] = useNotesTagsSortBy()
	const { tagUuid } = useLocalSearchParams<{
		tagUuid?: string
	}>()
	const tagFlags = aggregateNoteTagSelectionFlags(selectedTags)

	const notesTagsQuery = useNotesTagsQuery({
		enabled: false
	})

	const notesQuery = useNotesQuery({
		enabled: false
	})

	const liveNotes = notesQuery.status === "success" ? notesQuery.data : []
	const liveByUuid = new Map(liveNotes.map(note => [note.uuid, note]))
	// Drop stale-snapshot entries rather than falling back to them (#42): if the note is
	// no longer in the live query result it has been deleted and must not influence flags
	// or bulk ops — returning the stale object keeps a ghost in the aggregation.
	const selectedNotesLive = selectedNotes.flatMap(sel => {
		const live = liveByUuid.get(sel.uuid)

		return live ? [live] : []
	})
	const noteFlags = aggregateNoteSelectionFlags(selectedNotesLive, stringifiedClient?.userId)

	const tag = (() => {
		if (!tagUuid) {
			return null
		}

		// #84: the virtual "Untagged" screen resolves to the synthesized tag (title via its
		// name); it is stripped again before any real tag operation (createNote below).
		if (isUntaggedTagUuid(tagUuid)) {
			return createUntaggedTag(t("untagged"))
		}

		if (notesTagsQuery.status !== "success") {
			return null
		}

		return notesTagsQuery.data.find(noteTag => noteTag.uuid === tagUuid) ?? null
	})()

	const viewMode = tag ? "notes" : notesViewMode

	const createNote = async (type: NoteType) => {
		// #84: never attach the virtual tag to a newly created note.
		await createNoteFlow({ t, tag: tag && isUntaggedTagUuid(tag.uuid) ? null : tag, type })
	}

	const headerRightItems = buildNotesHeaderRightItems({
		t,
		textForeground,
		selectedNotes,
		selectedNotesLive,
		selectedTags,
		notesViewMode,
		setNotesViewMode,
		tagsSortBy,
		setTagsSortBy,
		tagFlags,
		noteFlags,
		tag,
		viewMode,
		onlyNotes: visibleNotes,
		notesTags: visibleTags,
		createNote
	})

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

			if (tag) {
				return tag.name ?? tag.uuid
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
			shadowVisible={false}
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
}

export default Header
