import Text from "@/components/ui/text"
import { Platform, ActivityIndicator } from "react-native"
import { useLocalSearchParams, router } from "expo-router"
import { deserialize } from "@/lib/serializer"
import View, { GestureHandlerScrollView } from "@/components/ui/view"
import Header, { type HeaderItem } from "@/components/ui/header"
import { Fragment, memo } from "react"
import { useResolveClassNames } from "uniwind"
import { run, fastLocaleCompare } from "@filen/utils"
import { runWithLoading } from "@/components/ui/fullScreenLoadingModal"
import alerts from "@/lib/alerts"
import prompts from "@/lib/prompts"
import Ionicons from "@expo/vector-icons/Ionicons"
import type { Note, NoteTag } from "@filen/sdk-rs"
import Menu from "@/components/ui/menu"
import { PressableScale } from "@/components/ui/pressables"
import useNotesWithContentQuery from "@/queries/useNotesWithContent.query"
import notes from "@/lib/notes"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import useNotesTagsQuery from "@/queries/useNotesTags.query"
import DismissStack from "@/components/dismissStack"

const Tag = memo(({ tag, note }: { tag: NoteTag; note: Note }) => {
	const textForeground = useResolveClassNames("text-foreground")

	const isTagged = note.tags.some(t => t.uuid === tag.uuid)

	return (
		<Menu
			type="dropdown"
			buttons={[
				{
					id: "tagged",
					title: "tbd_tagged",
					icon: "tag",
					checked: isTagged,
					onPress: async () => {
						const result = await runWithLoading(async () => {
							if (isTagged) {
								await notes.removeTag({
									note,
									tag
								})
							} else {
								await notes.addTag({
									note,
									tag
								})
							}
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
					title: "tbd_rename",
					icon: "edit",
					onPress: async () => {
						const promptResult = await run(async () => {
							return await prompts.input({
								title: "tbd_new_tag_name",
								message: "tbd_enter_tag_name",
								cancelText: "tbd_cancel",
								okText: "tbd_save"
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
					title: "tbd_delete",
					icon: "delete",
					destructive: true,
					onPress: async () => {
						const promptResponse = await run(async () => {
							return await prompts.alert({
								title: "tbd_delete_tag",
								message: "tbd_delete_tag_confirmation",
								cancelText: "tbd_cancel",
								okText: "tbd_delete",
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
				{note.tags.some(t => t.uuid === tag.uuid) && (
					<Ionicons
						className="shrink-0"
						name="checkmark"
						size={15}
						color={textForeground.color}
					/>
				)}
				<Text
					className="text-foreground shrink"
					numberOfLines={1}
					ellipsizeMode="middle"
				>
					{tag.name}
				</Text>
			</PressableScale>
		</Menu>
	)
})

const NoteTags = memo(() => {
	const { note: noteSerialized } = useLocalSearchParams<{
		note?: string
	}>()
	const bgBackgroundSecondary = useResolveClassNames("bg-background-secondary")
	const textForeground = useResolveClassNames("text-foreground")
	const insets = useSafeAreaInsets()
	const textMutedForeground = useResolveClassNames("text-muted-foreground")

	const noteParsed = (() => {
		if (!noteSerialized) {
			return null
		}

		try {
			return deserialize(noteSerialized) as Note
		} catch {
			return null
		}
	})()

	const notesWithContentQuery = useNotesWithContentQuery({
		enabled: false
	})

	const note =
		noteParsed && notesWithContentQuery.status === "success"
			? (notesWithContentQuery.data.find(n => n.uuid === noteParsed.uuid) ?? null)
			: null

	const notesTagsQuery = useNotesTagsQuery()

	const tags =
		notesTagsQuery.status === "success" ? notesTagsQuery.data.sort((a, b) => fastLocaleCompare(a.name ?? a.uuid, b.name ?? b.uuid)) : []

	if (!note) {
		return <DismissStack />
	}

	return (
		<Fragment>
			<Header
				title="tbd_note_tags"
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
									router.back()
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
											title: "tbd_new_tag_name",
											message: "tbd_enter_tag_name",
											cancelText: "tbd_cancel",
											okText: "tbd_add"
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
			{notesTagsQuery.status !== "success" ? (
				<View className="flex-1 bg-transparent items-center justify-center">
					<ActivityIndicator
						size="large"
						color={textForeground.color as string}
					/>
				</View>
			) : tags.length === 0 ? (
				<View className="flex-1 items-center justify-center px-4 bg-transparent gap-2">
					<Ionicons
						name="pricetag-outline"
						size={64}
						color={textMutedForeground.color}
					/>
					<Text>tbd_no_tags</Text>
				</View>
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
								note={note}
							/>
						)
					})}
				</GestureHandlerScrollView>
			)}
		</Fragment>
	)
})

export default NoteTags
