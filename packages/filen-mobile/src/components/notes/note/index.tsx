import Text from "@/components/ui/text"
import View from "@/components/ui/view"
import type { Note as TNote } from "@filen/sdk-rs"
import { ActivityIndicator, Platform } from "react-native"
import type { ListRenderItemInfo } from "@/components/ui/virtualList"
import { Paths } from "expo-file-system"
import { useRouter } from "expo-router"
import { useResolveClassNames } from "uniwind"
import { useShallow } from "zustand/shallow"
import useNotesStore from "@/stores/useNotes.store"
import { memo } from "react"
import { useStringifiedClient } from "@/lib/auth"
import { simpleDate } from "@/lib/time"
import Icon from "@/components/notes/note/icon"
import Menu, { NoteMenuOrigin } from "@/components/notes/note/menu"
import { cn, fastLocaleCompare } from "@filen/utils"
import { PressableScale } from "@/components/ui/pressables"
import { Checkbox } from "@/components/ui/checkbox"
import { AnimatedView } from "@/components/ui/animated"
import { FadeIn, FadeOut } from "react-native-reanimated"
import Ionicons from "@expo/vector-icons/Ionicons"
import Avatar from "@/components/ui/avatar"

export type Item = TNote & {
	content?: string
}

export type SectionHeader = {
	type: "header"
	id: string
	title: string
}

export type DataItem = Item & {
	type: "note"
}

export type ListItem = SectionHeader | DataItem

const Note = memo(
	({
		info,
		menuOrigin,
		nextNote,
		prevNote
	}: {
		info: ListRenderItemInfo<ListItem>
		menuOrigin?: NoteMenuOrigin
		nextNote?: ListItem
		prevNote?: ListItem
	}) => {
		const router = useRouter()
		const textForeground = useResolveClassNames("text-foreground")
		const textRed500 = useResolveClassNames("text-red-500")
		const itemUuid = info.item.type === "header" ? info.item.id : info.item.uuid
		const isInflight = useNotesStore(useShallow(state => (state.inflightContent[itemUuid] ?? []).length > 0))
		const isActive = useNotesStore(useShallow(state => state.activeNote?.uuid === itemUuid))
		const stringifiedClient = useStringifiedClient()
		const isSelected = useNotesStore(useShallow(state => state.selectedNotes.some(n => n.uuid === itemUuid)))
		const areNotesSelected = useNotesStore(useShallow(state => state.selectedNotes.length > 0))

		const onPress = () => {
			if (info.item.type === "header") {
				return
			}

			if (useNotesStore.getState().selectedNotes.length > 0) {
				useNotesStore.getState().setSelectedNotes(prev => {
					if (info.item.type === "header") {
						return prev
					}

					const prevSelected = prev.some(n => n.uuid === itemUuid)

					if (prevSelected) {
						return prev.filter(n => n.uuid !== itemUuid)
					}

					return [...prev.filter(n => n.uuid !== itemUuid), info.item]
				})

				return
			}

			router.push(Paths.join("/", "note", itemUuid))
		}

		const participantsWithoutCurrentUser =
			info.item.type === "header"
				? []
				: info.item.participants.filter(participant => participant.userId !== stringifiedClient?.userId)
		const tags = info.item.type === "header" ? [] : info.item.tags.sort((a, b) => fastLocaleCompare(a.name ?? a.uuid, b.name ?? b.uuid))

		const roundedCn = cn(
			nextNote?.type === "note" && prevNote?.type === "note" && "rounded-none",
			nextNote?.type === "header" && prevNote?.type === "note" && "rounded-b-4xl rounded-t-none",
			nextNote?.type === "note" && prevNote?.type === "header" && "rounded-t-4xl rounded-b-none",
			nextNote?.type === "header" && prevNote?.type === "header" && "rounded-4xl",
			!nextNote && prevNote?.type === "header" && "rounded-4xl",
			!prevNote && nextNote?.type === "note" && "rounded-t-4xl rounded-b-none",
			!nextNote && prevNote?.type === "note" && "rounded-b-4xl rounded-t-none",
			!nextNote && !prevNote && "rounded-4xl"
		)

		if (info.item.type === "header") {
			return (
				<View className="w-full h-auto px-4 py-4 pb-2">
					<Text className="text-lg">{info.item.title}</Text>
				</View>
			)
		}

		return (
			<View className="w-full h-auto flex-col">
				<Menu
					className={cn(
						"flex-row w-full h-auto",
						Platform.OS === "android" && cn("px-4", nextNote?.type === "note" ? "pb-0" : "pb4")
					)}
					type="context"
					note={info.item}
					origin={menuOrigin ?? "notes"}
					isAnchoredToRight={true}
				>
					<PressableScale
						onPress={onPress}
						className={cn(
							"w-full h-auto flex-row",
							Platform.OS === "ios" && cn("px-4", nextNote?.type === "note" ? "pb-0" : "pb4"),
							roundedCn
						)}
						style={{
							borderCurve: "continuous"
						}}
					>
						<View
							className={cn(
								"w-full h-auto flex-row px-4 shadow-sm",
								roundedCn,
								isActive
									? Platform.select({
											ios: "bg-background-tertiary rounded-4xl",
											default: "bg-background-tertiary"
										})
									: "bg-background-secondary",
								isSelected && "bg-background-tertiary"
							)}
							style={{
								borderCurve: "continuous"
							}}
						>
							<View
								className={cn(
									"flex-1 flex-row gap-4 w-full h-auto bg-transparent py-3",
									nextNote?.type === "note" &&
										Platform.select({
											ios: isActive ? "" : "border-b border-border",
											default: "border-b border-border"
										})
								)}
							>
								{areNotesSelected && (
									<AnimatedView
										className="flex-row h-full items-center justify-center bg-transparent pr-2 shrink-0"
										entering={FadeIn}
										exiting={FadeOut}
									>
										<Checkbox value={isSelected} />
									</AnimatedView>
								)}
								<View className="shrink-0 h-auto w-auto bg-transparent flex-col gap-2 items-center justify-start">
									<View className="flex-row items-center justify-center p-1 rounded-full border border-border size-8 bg-background-tertiary">
										{isInflight ? (
											<ActivityIndicator
												size="small"
												color={textForeground.color}
											/>
										) : (
											<Icon
												note={info.item}
												iconSize={18}
											/>
										)}
									</View>
									{info.item.pinned && (
										<View className="flex-row items-center justify-center p-1 rounded-full border border-border size-8 bg-background-tertiary">
											<Ionicons
												name="pin-outline"
												size={18}
												color={textForeground.color}
											/>
										</View>
									)}
									{info.item.favorite && (
										<View className="flex-row items-center justify-center p-1 rounded-full border border-border size-8 bg-background-tertiary">
											<Ionicons
												name="heart-outline"
												size={18}
												color={textRed500.color}
											/>
										</View>
									)}
								</View>
								<View className="gap-1 w-full h-auto bg-transparent flex-col flex-1">
									<Text
										numberOfLines={1}
										ellipsizeMode="middle"
									>
										{info.item.title ?? info.item.uuid}
									</Text>
									{info.item.preview && (
										<Text
											numberOfLines={2}
											ellipsizeMode="tail"
											className="text-muted-foreground text-xs"
										>
											{info.item.preview}
										</Text>
									)}
									<Text
										numberOfLines={1}
										ellipsizeMode="tail"
										className="text-muted-foreground text-xs"
									>
										{simpleDate(Number(info.item.editedTimestamp))}
									</Text>
									{participantsWithoutCurrentUser.length > 0 && (
										<View className="flex-row flex-wrap gap-2 bg-transparent pt-1">
											{participantsWithoutCurrentUser.map(participant => {
												return (
													<Avatar
														className="shrink-0"
														key={participant.userId}
														source={participant.avatar?.startsWith("https://") ? participant.avatar : undefined}
														size={24}
													/>
												)
											})}
										</View>
									)}
									{tags.length > 0 && (
										<View className="flex-row flex-wrap gap-1.5 bg-transparent pt-1">
											{tags.map(tag => (
												<View
													key={tag.uuid}
													className="px-2 py-1 rounded-full border border-border flex-row items-center gap-1 bg-background-tertiary"
												>
													{tag.favorite && (
														<Ionicons
															name="heart-outline"
															size={12}
															color={textRed500.color}
														/>
													)}
													<Text
														className="text-xs text-muted-foreground"
														ellipsizeMode="middle"
														numberOfLines={1}
													>
														{tag.name ?? tag.uuid}
													</Text>
												</View>
											))}
										</View>
									)}
								</View>
							</View>
						</View>
					</PressableScale>
				</Menu>
			</View>
		)
	}
)

export default Note
