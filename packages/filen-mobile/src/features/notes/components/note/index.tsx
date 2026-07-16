import Text from "@/components/ui/text"
import View from "@/components/ui/view"
import { type Note as TNote } from "@/types"
import { noteDisplayTitle } from "@/lib/decryption"
import { ActivityIndicator, Platform } from "react-native"
import type { ListRenderItemInfo } from "@/components/ui/virtualList"
import { router } from "@/lib/router"
import { useResolveClassNames } from "uniwind"
import { useShallow } from "zustand/shallow"
import useNotesStore from "@/features/notes/store/useNotes.store"
import useNotesInflightStore from "@/features/notes/store/useNotesInflight.store"
import { useStringifiedClient } from "@/lib/auth"
import { formatRelativeTime } from "@/lib/time"
import Icon from "@/features/notes/components/note/icon"
import Menu, { NoteMenuOrigin } from "@/features/notes/components/note/menu"
import { cn, fastLocaleCompare } from "@filen/utils"
import { PressableScale } from "@/components/ui/pressables"
import { Checkbox } from "@/components/ui/checkbox"
import Ionicons from "@expo/vector-icons/Ionicons"
import Avatar from "@/components/ui/avatar"
import { useTranslation } from "react-i18next"

export type Item = TNote & {
	content?: string
}

export type SectionHeader = {
	type: "header"
	id: string
	title: string
	icon?: React.ComponentProps<typeof Ionicons>["name"]
}

export type DataItem = Item & {
	type: "note"
}

export type ListItem = SectionHeader | DataItem

const NoteSectionHeader = ({ item }: { item: SectionHeader }) => {
	const textForeground = useResolveClassNames("text-foreground")

	return (
		<View className="w-full h-auto px-4 py-4 pb-2 flex-row items-center gap-2">
			{item.icon && (
				<Ionicons
					name={item.icon}
					size={18}
					color={textForeground.color}
				/>
			)}
			<Text className="text-lg">{item.title}</Text>
		</View>
	)
}

const NoteRow = ({
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
	const { t } = useTranslation()
	const textForeground = useResolveClassNames("text-foreground")
	const textRed500 = useResolveClassNames("text-red-500")
	const itemUuid = info.item.type === "header" ? info.item.id : info.item.uuid
	const isInflight = useNotesInflightStore(useShallow(state => (state.inflightContent[itemUuid]?.length ?? 0) > 0))
	const isActive = useNotesStore(useShallow(state => state.activeNote?.uuid === itemUuid))
	const stringifiedClient = useStringifiedClient()
	const { isSelected, areNotesSelected } = useNotesStore(
		useShallow(state => ({
			isSelected: state.selectedNotes.some(n => n.uuid === itemUuid),
			areNotesSelected: state.selectedNotes.length > 0
		}))
	)

	const onPress = () => {
		if (info.item.type === "header") {
			return
		}

		if (info.item.undecryptable) {
			return
		}

		if (useNotesStore.getState().selectedNotes.length > 0) {
			useNotesStore.getState().toggleSelectedNote(info.item)

			return
		}

		router.push(`/note/${itemUuid}`)
	}

	const participantsWithoutCurrentUser =
		info.item.type === "header" ? [] : info.item.participants.filter(participant => participant.userId !== stringifiedClient?.userId)
	// A note we don't own was shared TO us (we're a participant on someone else's note); surface
	// the owner's email (from the isOwner participant) on its own metadata row when so.
	const isSharedToMe = info.item.type !== "header" && !!stringifiedClient && info.item.ownerId !== stringifiedClient.userId
	const sharedByOwnerEmail =
		isSharedToMe && info.item.type !== "header"
			? (info.item.participants.find(participant => participant.isOwner)?.email ?? null)
			: null
	const tags =
		info.item.type === "header" ? [] : [...info.item.tags].sort((a, b) => fastLocaleCompare(a.name ?? a.uuid, b.name ?? b.uuid))

	// Notes are rendered inside a sectioned list (pinned / favorited /
	// time-bucketed / archived / trashed) where each section starts with a
	// SectionHeader. A note's rounded corners reflect its position within
	// its enclosing section:
	//   first-in-section → top corners rounded (or all, if solo)
	//   last-in-section  → bottom corners rounded (or all, if solo)
	//   middle           → no corners
	//
	// "First" means the previous list item is either a header or undefined
	// (the list itself ends just above). "Last" is symmetric. Solo notes
	// (first AND last) get all four corners.
	const isFirstInSection = !prevNote || prevNote.type === "header"
	const isLastInSection = !nextNote || nextNote.type === "header"
	const roundedCn = cn(isFirstInSection && "rounded-t-4xl", isLastInSection && "rounded-b-4xl")

	if (info.item.type === "header") {
		return null
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
							"w-full h-auto flex-row px-4",
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
										ios: isActive ? "" : "border-b border-separator",
										default: "border-b border-separator"
									})
							)}
						>
							{areNotesSelected && (
								<View className="flex-row h-full items-center justify-center bg-transparent pr-2 shrink-0">
									<Checkbox value={isSelected} />
								</View>
							)}
							<View className="shrink-0 h-auto w-auto bg-transparent flex-col gap-2 items-center justify-start">
								<View className="flex-row items-center justify-center p-1 rounded-full size-8 bg-background-tertiary">
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
									<View className="flex-row items-center justify-center p-1 rounded-full size-8 bg-background-tertiary">
										<Ionicons
											name="pin-outline"
											size={18}
											color={textForeground.color}
										/>
									</View>
								)}
								{info.item.favorite && (
									<View className="flex-row items-center justify-center p-1 rounded-full size-8 bg-background-tertiary">
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
									{noteDisplayTitle(info.item)}
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
									{formatRelativeTime(Number(info.item.editedTimestamp), t)}
								</Text>
								{sharedByOwnerEmail && (
									<Text
										numberOfLines={1}
										ellipsizeMode="middle"
										className="text-muted-foreground text-xs"
									>
										{t("shared_by_email", { email: sharedByOwnerEmail })}
									</Text>
								)}
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
												className="px-2 py-1 rounded-full flex-row items-center gap-1 bg-background-tertiary"
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

const Note = ({
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
	return info.item.type === "header" ? (
		<NoteSectionHeader item={info.item} />
	) : (
		<NoteRow
			info={info}
			menuOrigin={menuOrigin}
			nextNote={nextNote}
			prevNote={prevNote}
		/>
	)
}

export default Note
