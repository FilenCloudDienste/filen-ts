import Text from "@/components/ui/text"
import { Platform, ActivityIndicator } from "react-native"
import { useLocalSearchParams, useNavigation } from "expo-router"
import { deserialize } from "@/lib/serializer"
import View, { GestureHandlerScrollView } from "@/components/ui/view"
import SafeAreaView from "@/components/ui/safeAreaView"
import ListEmpty from "@/components/ui/listEmpty"
import Header, { type HeaderItem } from "@/components/ui/header"
import { Fragment, memo } from "react"
import { useResolveClassNames } from "uniwind"
import { run, fastLocaleCompare } from "@filen/utils"
import { runWithLoading } from "@/components/ui/fullScreenLoadingModal"
import alerts from "@/lib/alerts"
import prompts from "@/lib/prompts"
import Ionicons from "@expo/vector-icons/Ionicons"
import { type Note, type NoteTag } from "@/types"
import { tagDisplayName } from "@/lib/decryption"
import Menu from "@/components/ui/menu"
import { PressableScale } from "@/components/ui/pressables"
import useNotesWithContentQuery from "@/queries/useNotesWithContent.query"
import notes from "@/lib/notes"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import useNotesTagsQuery from "@/queries/useNotesTags.query"
import DismissStack from "@/components/dismissStack"
import { useTranslation } from "react-i18next"

// Tri-state of a tag against the working set of notes:
//   "all"  — every note already carries this tag (tap → remove from all)
//   "some" — some but not all carry it (tap → add to the rest, promoting to "all")
//   "none" — no note carries it yet (tap → add to all)
type TagState = "all" | "some" | "none"

function computeTagState(targetNotes: readonly Note[], tag: NoteTag): TagState {
	let tagged = 0

	for (let i = 0; i < targetNotes.length; i++) {
		const note = targetNotes[i]

		if (note && note.tags.some(t => t.uuid === tag.uuid)) {
			tagged++
		}
	}

	if (tagged === 0) {
		return "none"
	}

	if (tagged === targetNotes.length) {
		return "all"
	}

	return "some"
}

const Tag = memo(({ tag, targetNotes }: { tag: NoteTag; targetNotes: readonly Note[] }) => {
	const { t } = useTranslation()
	const textForeground = useResolveClassNames("text-foreground")

	const state = computeTagState(targetNotes, tag)
	const isSingle = targetNotes.length === 1

	const toggleTitle =
		state === "all"
			? isSingle
				? t("remove_tag")
				: t("remove_tag_from_selected")
			: state === "some"
				? t("add_tag_to_remaining")
				: isSingle
					? t("add_tag")
					: t("add_tag_to_selected")

	return (
		<Menu
			type="dropdown"
			buttons={[
				{
					id: "tagged",
					title: toggleTitle,
					icon: "tag",
					checked: state === "all",
					requiresOnline: true,
					onPress: async () => {
						const result = await runWithLoading(async () => {
							if (state === "all") {
								// Remove the tag from every selected note.
								await Promise.all(
									targetNotes.map(note =>
										notes.removeTag({
											note,
											tag
										})
									)
								)

								return
							}

							// "none" or "some": promote to "all" — add to every note that
							// doesn't already carry the tag (addTag is idempotent, but
							// filtering avoids the redundant SDK call).
							const needsAdd = targetNotes.filter(note => !note.tags.some(noteTag => noteTag.uuid === tag.uuid))

							await Promise.all(
								needsAdd.map(note =>
									notes.addTag({
										note,
										tag
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
				},
				{
					id: "rename",
					title: t("rename"),
					icon: "edit",
					requiresOnline: true,
					onPress: async () => {
						const promptResult = await run(async () => {
							return await prompts.input({
								title: t("new_tag_name"),
								message: t("enter_tag_name"),
								cancelText: t("cancel"),
								okText: t("save")
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
							await notes.renameTag({
								tag,
								newName
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
					id: "delete",
					title: t("delete"),
					icon: "delete",
					destructive: true,
					requiresOnline: true,
					onPress: async () => {
						const promptResponse = await run(async () => {
							return await prompts.alert({
								title: t("delete_tag"),
								message: t("are_you_sure_delete_tag"),
								cancelText: t("cancel"),
								okText: t("delete"),
								destructive: true
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

						const result = await runWithLoading(async () => {
							await notes.deleteTag({
								tag
							})
						})

						if (!result.success) {
							console.error(result.error)
							alerts.error(result.error)

							return
						}
					}
				}
			]}
		>
			<PressableScale className="bg-background-tertiary p-2 px-3 flex-row items-center justify-center rounded-full gap-2">
				{state === "all" && (
					<Ionicons
						className="shrink-0"
						name="checkmark"
						size={15}
						color={textForeground.color}
					/>
				)}
				{state === "some" && (
					<Ionicons
						className="shrink-0"
						name="remove"
						size={15}
						color={textForeground.color}
					/>
				)}
				<Text
					className="text-foreground shrink"
					numberOfLines={1}
					ellipsizeMode="middle"
				>
					{tagDisplayName(tag)}
				</Text>
			</PressableScale>
		</Menu>
	)
})

const NoteTags = memo(() => {
	const { t } = useTranslation()
	const { notes: notesSerialized } = useLocalSearchParams<{
		notes?: string
	}>()
	const bgBackgroundSecondary = useResolveClassNames("bg-background-secondary")
	const textForeground = useResolveClassNames("text-foreground")
	const insets = useSafeAreaInsets()
	const navigation = useNavigation()

	// Deserialize the navigation payload. Single-note callers (per-item context
	// menu) and bulk callers (notes-list bulk action) both serialize a Note[] —
	// even a single note is wrapped as a one-element array so the route stays
	// uniform.
	const notesParsed = (() => {
		if (!notesSerialized) {
			return null
		}

		try {
			return deserialize(notesSerialized) as Note[]
		} catch {
			return null
		}
	})()

	// Re-anchor the navigated notes against the live query result. Selection /
	// route params are snapshots; a tag change after this screen opens (or a
	// note moved into trash via another client) must reflect in the tri-state
	// without requiring a re-navigation.
	const notesWithContentQuery = useNotesWithContentQuery({
		enabled: false
	})

	const liveNotes = (() => {
		if (!notesParsed || notesParsed.length === 0 || notesWithContentQuery.status !== "success") {
			return []
		}

		const wantedUuids = new Set(notesParsed.map(n => n.uuid))

		return notesWithContentQuery.data.filter(n => wantedUuids.has(n.uuid))
	})()

	const notesTagsQuery = useNotesTagsQuery()

	const tags =
		notesTagsQuery.status === "success" ? [...notesTagsQuery.data].sort((a, b) => fastLocaleCompare(tagDisplayName(a), tagDisplayName(b))) : []

	if (liveNotes.length === 0) {
		return <DismissStack />
	}

	return (
		<Fragment>
			<Header
				title={liveNotes.length === 1 ? t("note_tags") : t("note_tags_selected")}
				transparent={Platform.OS === "ios"}
				shadowVisible={false}
				backVisible={Platform.OS === "android"}
				backgroundColor={Platform.select({
					ios: undefined,
					default: bgBackgroundSecondary.backgroundColor as string
				})}
				leftItems={Platform.select({
					ios: [
						{
							type: "button",
							icon: {
								name: "close",
								color: textForeground.color,
								size: 20
							},
							props: {
								onPress: () => {
									navigation.getParent()?.goBack()
								}
							}
						}
					],
					default: undefined
				})}
				rightItems={
					[
						{
							type: "button",
							icon: {
								name: "add-outline",
								color: textForeground.color,
								size: 20
							},
							props: {
								onPress: async () => {
									const promptResult = await run(async () => {
										return await prompts.input({
											title: t("new_tag_name"),
											message: t("enter_tag_name"),
											cancelText: t("cancel"),
											okText: t("add")
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
							}
						}
					] satisfies HeaderItem[]
				}
			/>
			<SafeAreaView
				className="flex-1 bg-background-secondary"
				edges={["left", "right"]}
			>
				{notesTagsQuery.status !== "success" ? (
					<View className="flex-1 bg-transparent items-center justify-center">
						<ActivityIndicator
							size="large"
							color={textForeground.color as string}
						/>
					</View>
				) : tags.length === 0 ? (
					<ListEmpty
						icon="pricetag-outline"
						title={t("no_tags")}
					/>
				) : (
					<GestureHandlerScrollView
						contentContainerClassName="flex-row flex-wrap gap-2 px-4 pt-2 bg-transparent"
						showsHorizontalScrollIndicator={false}
						contentInsetAdjustmentBehavior="automatic"
						contentContainerStyle={{
							paddingBottom: insets.bottom
						}}
					>
						{tags.map(tag => {
							return (
								<Tag
									key={tag.uuid}
									tag={tag}
									targetNotes={liveNotes}
								/>
							)
						})}
					</GestureHandlerScrollView>
				)}
			</SafeAreaView>
		</Fragment>
	)
})

export default NoteTags
