import View from "@/components/ui/view"
import { useResolveClassNames } from "uniwind"
import Ionicons from "@expo/vector-icons/Ionicons"
import Menu, { type MenuButton } from "@/components/ui/menu"
import Avatar from "@/components/ui/avatar"
import ListRow from "@/components/ui/listRow"
import EllipsisMenuTrigger from "@/components/ui/ellipsisMenuTrigger"
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
	// Actions available regardless of chat/note ownership (e.g. Block / Unblock).
	extraMenuActions?: MenuButton[]
	// When true, render a muted "blocked" marker on the row.
	blocked?: boolean
}

export type BuildParticipantMenuButtonsParams = {
	ownerActions: ParticipantOwnerActions | undefined
	permission: ParticipantPermission | undefined
	isSelected: boolean
	extraMenuActions?: MenuButton[]
	t: TFunction
}

export function buildParticipantMenuButtons(params: BuildParticipantMenuButtonsParams): MenuButton[] {
	const { ownerActions, permission, isSelected, extraMenuActions, t } = params
	const extra = extraMenuActions ?? []

	if (!ownerActions) {
		return extra
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

	return [...buttons, ...ownerActions.menuActions, ...extra]
}

export const ParticipantRow = (props: ParticipantRowProps) => {
	const { t } = useTranslation()
	const textMutedForeground = useResolveClassNames("text-muted-foreground")
	const ownerActions = props.ownerActions
	const isSelected = ownerActions?.isSelected ?? false
	const showCheckbox = !!(ownerActions && ownerActions.areOthersSelected)

	const menuButtons: MenuButton[] = buildParticipantMenuButtons({
		ownerActions,
		permission: props.permission,
		isSelected,
		extraMenuActions: props.extraMenuActions,
		t
	})

	return (
		<ListRow
			separator={true}
			selectable={showCheckbox}
			selected={isSelected}
			onPress={() => {
				// The checkbox is display-only; selection is driven by the row tap while multi-selecting.
				if (ownerActions && ownerActions.areOthersSelected) {
					ownerActions.onToggleSelect()
				}
			}}
			leading={
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
			}
			title={props.displayName}
			subtitle={props.blocked ? `${props.email} · ${t("contact_blocked")}` : props.email}
			trailing={
				menuButtons.length > 0 ? (
					<Menu
						type="dropdown"
						buttons={menuButtons}
					>
						<EllipsisMenuTrigger />
					</Menu>
				) : undefined
			}
		/>
	)
}

export default ParticipantRow
