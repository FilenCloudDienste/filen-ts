import StackHeader, { type HeaderItem } from "@/components/ui/header"
import useNotesWithContentQuery from "@/features/notes/queries/useNotesWithContent.query"
import { notesSorter } from "@/lib/sort"
import { NoteType } from "@filen/sdk-rs"
import { run, fastLocaleCompare } from "@filen/utils"
import { tagDisplayName } from "@/lib/decryption"
import alerts from "@/lib/alerts"
import { Platform } from "react-native"
import { router, useLocalSearchParams } from "expo-router"
import { useResolveClassNames } from "uniwind"
import useNotesStore from "@/features/notes/store/useNotes.store"
import { useShallow } from "zustand/shallow"
import useNotesTagsQuery from "@/features/notes/queries/useNotesTags.query"
import { runWithLoading } from "@/components/ui/fullScreenLoadingModal"
import prompts from "@/lib/prompts"
import notesLib from "@/features/notes/notes"
import { useSecureStore } from "@/lib/secureStore"
import { useStringifiedClient } from "@/lib/auth"
import { aggregateNoteSelectionFlags, aggregateNoteTagSelectionFlags } from "@/features/notes/notesSelectors"
import { useTranslation } from "react-i18next"
import { buildNotesHeaderRightItems } from "@/features/notes/components/notesHeaderMenuBuilders"

export const Header = ({ setSearchQuery }: { setSearchQuery: React.Dispatch<React.SetStateAction<string>> }) => {
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
			return await notesLib.createWithOptionalTag({
				title,
				type,
				tag: tag ?? undefined
			})
		})

		if (!createResult.success) {
			console.error(createResult.error)
			alerts.error(createResult.error)

			return
		}

		router.push(`/note/${createResult.data.uuid}`)
	}

	const headerRightItems = buildNotesHeaderRightItems({
		t,
		textForeground,
		selectedNotes,
		selectedTags,
		notesViewMode,
		setNotesViewMode,
		tagFlags,
		noteFlags,
		tag,
		viewMode,
		onlyNotes,
		notesTags,
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
}

export default Header
