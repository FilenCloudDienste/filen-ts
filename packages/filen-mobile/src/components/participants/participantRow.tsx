import Text from "@/components/ui/text"
import View, { CrossGlassContainerView } from "@/components/ui/view"
import { useResolveClassNames } from "uniwind"
import { cn } from "@filen/utils"
import Ionicons from "@expo/vector-icons/Ionicons"
import Menu, { type MenuButton } from "@/components/ui/menu"
import { PressableScale } from "@/components/ui/pressables"
import Avatar from "@/components/ui/avatar"
import { Checkbox } from "@/components/ui/checkbox"
import { AnimatedView } from "@/components/ui/animated"
import { FadeIn, FadeOut } from "react-native-reanimated"
import { useTranslation } from "react-i18next"
import { type TFunction } from "i18next"

export type ParticipantPermission = "read" | "write"

export type ParticipantPermissionLabels = {
	title: string
	read: string
	write: string
}

export type ParticipantOwnerActions = {
	isSelected: boolean
	areOthersSelected: boolean
	onToggleSelect: () => void
	menuActions: MenuButton[]
	onSetPermission?: (permission: ParticipantPermission) => void | Promise<void>
	permissionLabels?: ParticipantPermissionLabels
}

export type ParticipantRowProps = {
	email: string
	displayName: string
	avatar?: string | null
	permission?: ParticipantPermission
	ownerActions?: ParticipantOwnerActions
}

export type BuildParticipantMenuButtonsParams = {
	ownerActions: ParticipantOwnerActions | undefined
	permission: ParticipantPermission | undefined
	isSelected: boolean
	t: TFunction
}

export function buildParticipantMenuButtons(params: BuildParticipantMenuButtonsParams): MenuButton[] {
	const { ownerActions, permission, isSelected, t } = params

	if (!ownerActions) {
		return []
	}

	const buttons: MenuButton[] = [
		{
			id: "select",
			title: isSelected ? t("deselect") : t("select"),
			icon: "select",
			checked: isSelected,
			onPress: () => {
				ownerActions.onToggleSelect()
			}
		}
	]

	if (ownerActions.onSetPermission && ownerActions.permissionLabels) {
		const setPermission = ownerActions.onSetPermission
		const labels = ownerActions.permissionLabels

		buttons.push({
			id: "permissions",
			title: labels.title,
			icon: permission === "write" ? "edit" : "eye",
			subButtons: [
				{
					id: "read",
					title: labels.read,
					icon: "eye",
					checked: permission === "read",
					requiresOnline: true,
					onPress: () => {
						void setPermission("read")
					}
				},
				{
					id: "write",
					title: labels.write,
					icon: "edit",
					checked: permission === "write",
					requiresOnline: true,
					onPress: () => {
						void setPermission("write")
					}
				}
			]
		})
	}

	return [...buttons, ...ownerActions.menuActions]
}

export const ParticipantRow = (props: ParticipantRowProps) => {
	const { t } = useTranslation()
	const textForeground = useResolveClassNames("text-foreground")
	const textMutedForeground = useResolveClassNames("text-muted-foreground")
	const ownerActions = props.ownerActions
	const isSelected = ownerActions?.isSelected ?? false
	const showCheckbox = ownerActions && ownerActions.areOthersSelected

	const menuButtons: MenuButton[] = buildParticipantMenuButtons({
		ownerActions,
		permission: props.permission,
		isSelected,
		t
	})

	return (
		<View className={cn("flex-row items-center px-4 bg-transparent", isSelected && "bg-background-tertiary")}>
			<View className="flex-row items-center gap-4 py-2 bg-transparent border-b border-border flex-1">
				{showCheckbox && (
					<AnimatedView
						className="flex-row h-full items-center justify-center bg-transparent pr-1 shrink-0"
						entering={FadeIn}
						exiting={FadeOut}
					>
						<Checkbox value={isSelected} />
					</AnimatedView>
				)}
				<PressableScale
					className="flex-row bg-transparent flex-1"
					onPress={() => {
						if (ownerActions && ownerActions.areOthersSelected) {
							ownerActions.onToggleSelect()
						}
					}}
				>
					<View className="flex-row bg-transparent flex-1 gap-2 items-center">
						<View className="flex-row items-center gap-3 bg-transparent">
							{props.permission === "write" ? (
								<Ionicons
									name="pencil-outline"
									size={16}
									color={textMutedForeground.color}
								/>
							) : props.permission === "read" ? (
								<Ionicons
									name="eye-outline"
									size={16}
									color={textMutedForeground.color}
								/>
							) : null}
							<Avatar
								className="shrink-0"
								size={32}
								source={props.avatar}
							/>
						</View>
						<View className="flex-col bg-transparent gap-0.5 flex-1">
							<Text
								className="text-foreground"
								numberOfLines={1}
								ellipsizeMode="middle"
							>
								{props.displayName}
							</Text>
							<Text
								className="text-muted-foreground text-xs"
								numberOfLines={1}
								ellipsizeMode="middle"
							>
								{props.email}
							</Text>
						</View>
					</View>
				</PressableScale>
				{ownerActions && (
					<View className="flex-row items-center gap-4 bg-transparent">
						<Menu
							type="dropdown"
							buttons={menuButtons}
						>
							<CrossGlassContainerView>
								<PressableScale className="size-9 items-center justify-center">
									<Ionicons
										name="ellipsis-horizontal"
										size={20}
										color={textForeground.color}
									/>
								</PressableScale>
							</CrossGlassContainerView>
						</Menu>
					</View>
				)}
			</View>
		</View>
	)
}

export default ParticipantRow
