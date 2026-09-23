import { type MouseEvent, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { type LucideIcon } from "lucide-react"
import { useDirectoryTreeChildrenQuery } from "@/features/drive/queries/drive"
import { DirectoryGlyph } from "@/features/drive/components/itemIcon"
import { Spinner } from "@/components/ui/spinner"
import {
	ContextMenuGroup,
	ContextMenuItem,
	ContextMenuLabel,
	ContextMenuSeparator,
	ContextMenuSub,
	ContextMenuSubContent,
	ContextMenuSubTrigger
} from "@/components/ui/context-menu"
import {
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger
} from "@/components/ui/dropdown-menu"

// Base UI's DropdownMenu and ContextMenu are separate Root families whose parts can't be mixed across
// triggers (see itemMenu.tsx), so a menu rendering this submenu passes the family it lives in.
export interface DirectoryTreeMenuFamily {
	Item: typeof DropdownMenuItem
	Separator: typeof DropdownMenuSeparator
	Group: typeof DropdownMenuGroup
	Label: typeof DropdownMenuLabel
	Sub: typeof DropdownMenuSub
	SubTrigger: typeof DropdownMenuSubTrigger
	SubContent: typeof DropdownMenuSubContent
}

export const DROPDOWN_TREE_MENU_FAMILY: DirectoryTreeMenuFamily = {
	Item: DropdownMenuItem,
	Separator: DropdownMenuSeparator,
	Group: DropdownMenuGroup,
	Label: DropdownMenuLabel,
	Sub: DropdownMenuSub,
	SubTrigger: DropdownMenuSubTrigger,
	SubContent: DropdownMenuSubContent
}

export const CONTEXT_TREE_MENU_FAMILY: DirectoryTreeMenuFamily = {
	Item: ContextMenuItem,
	Separator: ContextMenuSeparator,
	Group: ContextMenuGroup,
	Label: ContextMenuLabel,
	Sub: ContextMenuSub,
	SubTrigger: ContextMenuSubTrigger,
	SubContent: ContextMenuSubContent
}

// A destination in the Cloud Drive tree. `uuid` is null for the root; `ancestry` is the root-to-target
// uuid chain inclusive of the target itself (empty for the root) — the shape the move gates take.
export interface DirectoryTreeTarget {
	uuid: string | null
	ancestry: readonly string[]
}

const ROOT_TARGET: DirectoryTreeTarget = { uuid: null, ancestry: [] }

interface DirectoryTreeActions {
	family: DirectoryTreeMenuFamily
	// The per-directory entry ("Move here") that acts on the directory whose submenu it heads.
	actionLabel: string
	actionIcon: LucideIcon
	onSelect: (target: DirectoryTreeTarget) => void
	// Greys out the action entry for a target.
	isTargetDisabled: (target: DirectoryTreeTarget) => boolean
	// Greys out a directory's own submenu trigger, so nothing below it can be reached either.
	isBrowseDisabled: (target: DirectoryTreeTarget) => boolean
}

export interface DirectoryTreeSubmenuProps extends DirectoryTreeActions {
	label: string
	icon: LucideIcon
	disabled?: boolean | undefined
	title?: string | undefined
	// Entries above the tree (e.g. the full destination picker).
	leading?: ReactNode
}

// A row's ⋯ dropdown is a React descendant of the row, so clicks in any popup here bubble through the
// React tree into the row's own select/open handlers (see itemMenu.tsx). Unlike an item, a submenu
// trigger never closes the menu, so its click and double-click must not reach the row either.
function stopRowPropagation(event: MouseEvent): void {
	event.stopPropagation()
}

// A recursive, hover-to-open submenu over the Cloud Drive directory tree: every level offers the action
// for its own directory first, then that directory's subdirectories as further submenus. A level's
// listing is only read once its submenu opens (Base UI mounts popup content on open), through the
// sidebar tree's query — so it shares the drive listing's cache. Directory triggers only open their
// submenu: Base UI routes Enter/Space and touch taps on a trigger to opening it, so the action lives on
// its own entry.
export function DirectoryTreeSubmenu({ label, icon: Icon, disabled, title, leading, ...actions }: DirectoryTreeSubmenuProps) {
	const { t } = useTranslation("drive")
	const { Sub, SubTrigger, SubContent, Separator, Group, Label } = actions.family

	return (
		<Sub>
			<SubTrigger
				disabled={disabled}
				title={title}
				onClick={stopRowPropagation}
				onDoubleClick={stopRowPropagation}
			>
				<Icon aria-hidden="true" />
				{label}
			</SubTrigger>
			<SubContent
				className="max-w-72"
				onClick={stopRowPropagation}
				onDoubleClick={stopRowPropagation}
			>
				{leading}
				{leading !== undefined ? <Separator /> : null}
				<Group>
					<Label>{t("driveMyDrive")}</Label>
					<DirectoryTreeSubmenuLevel
						{...actions}
						target={ROOT_TARGET}
					/>
				</Group>
			</SubContent>
		</Sub>
	)
}

function DirectoryTreeSubmenuLevel({ target, ...actions }: DirectoryTreeActions & { target: DirectoryTreeTarget }) {
	const { t } = useTranslation("drive")
	const query = useDirectoryTreeChildrenQuery(target.uuid)
	const { Item, Separator, Sub, SubTrigger, SubContent } = actions.family
	const ActionIcon = actions.actionIcon

	// A target's own listing has to be in before it can be judged (the same wait the move dialog's
	// confirm has), and this level's query is that listing.
	const actionDisabled = query.status !== "success" || actions.isTargetDisabled(target)

	return (
		<>
			<Item
				disabled={actionDisabled}
				onClick={() => {
					actions.onSelect(target)
				}}
			>
				<ActionIcon aria-hidden="true" />
				{actions.actionLabel}
			</Item>
			<Separator />
			{query.status === "pending" ? (
				<div className="flex h-7 items-center justify-center text-muted-foreground">
					<Spinner className="size-3.5" />
				</div>
			) : query.status === "error" ? (
				<Item disabled>{t("driveLoadError")}</Item>
			) : query.data.length === 0 ? (
				<Item disabled>{t("driveTreeMenuNoDirectories")}</Item>
			) : (
				query.data.map(child => {
					const childTarget: DirectoryTreeTarget = { uuid: child.uuid, ancestry: [...target.ancestry, child.uuid] }

					return (
						<Sub key={child.uuid}>
							<SubTrigger
								label={child.name}
								disabled={actions.isBrowseDisabled(childTarget)}
							>
								<DirectoryGlyph
									color={child.color}
									className="size-4 shrink-0"
								/>
								<span className="min-w-0 flex-1 truncate">{child.name}</span>
							</SubTrigger>
							<SubContent className="max-w-72">
								<DirectoryTreeSubmenuLevel
									{...actions}
									target={childTarget}
								/>
							</SubContent>
						</Sub>
					)
				})
			)}
		</>
	)
}
