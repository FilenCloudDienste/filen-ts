import Text from "@/components/ui/text"
import View from "@/components/ui/view"
import type { NoteTag, Note } from "@filen/sdk-rs"
import { Platform, ActivityIndicator } from "react-native"
import type { ListRenderItemInfo } from "@/components/ui/virtualList"
import { Paths } from "expo-file-system"
import { useRouter } from "expo-router"
import { useResolveClassNames } from "uniwind"
import { useShallow } from "zustand/shallow"
import useNotesStore from "@/stores/useNotes.store"
import { memo } from "react"
import { simpleDate } from "@/lib/time"
import Menu from "@/components/notes/tag/menu"
import { cn } from "@filen/utils"
import { PressableScale } from "@/components/ui/pressables"
import Ionicons from "@expo/vector-icons/Ionicons"
import { AnimatedView } from "@/components/ui/animated"
import { FadeIn, FadeOut } from "react-native-reanimated"
import { Checkbox } from "@/components/ui/checkbox"

const Tag = memo(({ info, notesForTag }: { info: ListRenderItemInfo<NoteTag>; notesForTag: Note[] }) => {
	const router = useRouter()
	const textForeground = useResolveClassNames("text-foreground")
	const textRed500 = useResolveClassNames("text-red-500")
	const textPrimary = useResolveClassNames("text-primary")
	const isActive = useNotesStore(useShallow(state => state.activeTag?.uuid === info.item.uuid))
	const isSelected = useNotesStore(useShallow(state => state.selectedTags.some(t => t.uuid === info.item.uuid)))
	const areTagsSelected = useNotesStore(useShallow(state => state.selectedTags.length > 0))
	const isInflight = useNotesStore(
		useShallow(state => {
			return notesForTag.some(n => (state.inflightContent[n.uuid] ?? []).length > 0)
		})
	)

	const onPress = () => {
		if (useNotesStore.getState().selectedTags.length > 0) {
			useNotesStore.getState().setSelectedTags(prev => {
				const prevSelected = prev.some(t => t.uuid === info.item.uuid)

				if (prevSelected) {
					return prev.filter(t => t.uuid !== info.item.uuid)
				}

				return [...prev.filter(t => t.uuid !== info.item.uuid), info.item]
			})

			return
		}

		router.push({
			pathname: Paths.join("/", "notesTags"),
			params: {
				tagUuid: info.item.uuid
			}
		})
	}

	return (
		<View className="w-full h-auto">
			<Menu
				className="flex-row w-full h-auto"
				type="context"
				tag={info.item}
				origin="tags"
				isAnchoredToRight={true}
			>
				<PressableScale
					onPress={onPress}
					className="w-full h-auto flex-row"
				>
					<View
						className={cn(
							"w-full h-auto flex-row",
							isActive
								? "bg-background-secondary"
								: Platform.select({
										ios: "",
										default: "bg-transparent"
									}),
							isSelected ? "bg-background-secondary" : ""
						)}
					>
						<View className="flex-1 flex-row gap-4 px-4 w-full h-auto bg-transparent items-center">
							<View className="gap-2 shrink-0 h-auto w-auto bg-transparent flex-row items-center">
								{areTagsSelected ? (
									<AnimatedView
										className="flex-row h-full items-center justify-center bg-transparent shrink-0"
										entering={FadeIn}
										exiting={FadeOut}
									>
										<Checkbox value={isSelected} />
									</AnimatedView>
								) : (
									<View className="bg-transparent">
										{notesForTag.length > 0 ? (
											<Ionicons
												name="chevron-forward-outline"
												size={18}
												color={textPrimary.color}
											/>
										) : (
											<View className="size-4.5 bg-transparent" />
										)}
									</View>
								)}

								<View
									className={cn(
										"rounded-lg p-2 shadow-md",
										isActive ? "bg-background-tertiary" : "bg-background-secondary"
									)}
								>
									{info.item.favorite && (
										<View className="shrink-0 bg-transparent absolute -bottom-1.5 -right-1.5">
											<Ionicons
												name="heart"
												size={16}
												color={textRed500.color}
											/>
										</View>
									)}
									{isInflight ? (
										<ActivityIndicator
											size="small"
											color={textForeground.color}
										/>
									) : (
										<Ionicons
											name="pricetags-outline"
											size={20}
											color={textForeground.color}
										/>
									)}
								</View>
							</View>
							<View
								className={cn(
									"gap-1 w-full h-auto bg-transparent flex-col flex-1 py-2.5",
									isActive && Platform.OS === "ios" ? "" : "border-b border-border"
								)}
							>
								<View className="flex-1 flex-row gap-1.5 items-center w-full h-auto bg-transparent">
									<Text
										numberOfLines={1}
										ellipsizeMode="middle"
										className="flex-1"
									>
										{info.item.name ?? info.item.uuid}
									</Text>
								</View>
								<Text
									numberOfLines={1}
									ellipsizeMode="tail"
									className="text-muted-foreground text-xs"
								>
									{notesForTag.length} tbd_notes, {simpleDate(Number(info.item.editedTimestamp))}
								</Text>
							</View>
						</View>
					</View>
				</PressableScale>
			</Menu>
		</View>
	)
})

export default Tag
