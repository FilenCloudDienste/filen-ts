import { useState } from "react"
import { useTranslation } from "react-i18next"
import { ChevronDownIcon, FolderPlusIcon, FolderSearchIcon, PackageOpenIcon } from "lucide-react"
import { ACTION_DEFS } from "@/features/drive/lib/actionDefs"
import { cachedDirectoryName } from "@/features/drive/queries/drive"
import {
	DirectoryTreeSubmenu,
	DROPDOWN_TREE_MENU_FAMILY,
	type DirectoryTreeMenuFamily
} from "@/features/drive/components/directoryTreeSubmenu"
import { MoveTargetDialog } from "@/features/drive/components/moveTargetDialog"
import type { ArchiveSource } from "@/features/archive/lib/archiveSource"
import type { ExtractTarget } from "@/features/archive/lib/extractSelection"
import { useIsOnline } from "@/lib/useIsOnline"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"

export interface ArchiveExtractMenuProps {
	source: ArchiveSource
	// The new directory "next to the archive" would be named; null leaves that entry out (a single
	// compressed file extracts as one file).
	newFolderName: string | null
	// The trigger's text; null draws only its arrow, labelled by `ariaLabel`.
	label: string | null
	ariaLabel?: string | undefined
	variant: "default" | "outline"
	triggerClassName?: string | undefined
	disabled: boolean
	// Why it is disabled, as the trigger's title.
	disabledTitle?: string | undefined
	onPick: (target: ExtractTarget) => void
}

// Where the browser's extract goes, mirroring the file menu's Extract submenu: next to the archive (in a
// new directory, or straight in) where the archive has an own directory, any directory of the Cloud
// Drive through the tree submenu, or the destination picker. The tree mounts only while open.
export function ArchiveExtractMenu({
	source,
	newFolderName,
	label,
	ariaLabel,
	variant,
	triggerClassName,
	disabled,
	disabledTitle,
	onPick
}: ArchiveExtractMenuProps) {
	// The destination picker while open, with the directory it opens at (the root's empty chain otherwise).
	const [picking, setPicking] = useState<readonly string[] | null>(null)

	return (
		<>
			<DropdownMenu>
				{/* Only the icon-only trigger, whose name is otherwise unseen. */}
				<Tooltip disabled={label !== null}>
					<TooltipTrigger
						render={
							<DropdownMenuTrigger
								disabled={disabled}
								render={
									<Button
										variant={variant}
										size={label === null ? "icon" : "default"}
										aria-label={label === null ? ariaLabel : undefined}
										className={triggerClassName}
										title={disabled ? disabledTitle : undefined}
									/>
								}
							>
								{label}
								<ChevronDownIcon data-icon={label === null ? undefined : "inline-end"} />
							</DropdownMenuTrigger>
						}
					/>
					<TooltipContent>{ariaLabel}</TooltipContent>
				</Tooltip>
				<DropdownMenuContent
					align="end"
					className="w-auto max-w-80"
				>
					<ArchiveExtractItems
						family={DROPDOWN_TREE_MENU_FAMILY}
						source={source}
						newFolderName={newFolderName}
						onPick={onPick}
						onChooseDestination={startPath => {
							setPicking(startPath ?? [])
						}}
					/>
				</DropdownMenuContent>
			</DropdownMenu>
			{picking !== null ? (
				<ArchiveExtractPicker
					initialPath={picking}
					onPick={onPick}
					onClose={() => {
						setPicking(null)
					}}
				/>
			) : null}
		</>
	)
}

export interface ArchiveExtractItemsProps {
	// The menu it is drawn in: a dropdown (the footer's, a row's ⋯) or a row's context menu.
	family: DirectoryTreeMenuFamily
	source: ArchiveSource
	newFolderName: string | null
	onPick: (target: ExtractTarget) => void
	// The destination picker is the host's: a row's menu may unmount with its row while it is open. At `startPath`
	// when a tree level's More… asks for it.
	onChooseDestination: (startPath?: readonly string[]) => void
}

// The places an extract goes, as the entries of a menu (the footer's, or a row's Extract submenu).
export function ArchiveExtractItems({ family, source, newFolderName, onPick, onChooseDestination }: ArchiveExtractItemsProps) {
	const { t } = useTranslation(["preview", "archive", "drive"])
	const { Item } = family
	const isOnline = useIsOnline()
	// Shared with the user, linked, a chat's or in the trash: it has no directory of the user's own.
	const beside = source.ownParent !== undefined

	return (
		<>
			{beside && newFolderName !== null ? (
				<Item
					onClick={() => {
						onPick({ type: "besideNewFolder" })
					}}
				>
					<FolderPlusIcon aria-hidden="true" />
					<span className="min-w-0 flex-1 truncate">{t("previewArchiveExtractBesideNewFolder", { name: newFolderName })}</span>
				</Item>
			) : null}
			{beside ? (
				<Item
					onClick={() => {
						onPick({ type: "beside" })
					}}
				>
					<PackageOpenIcon aria-hidden="true" />
					{t("previewArchiveExtractBeside")}
				</Item>
			) : null}
			<DirectoryTreeSubmenu
				family={family}
				label={t("archive:archiveExtractTo")}
				icon={ACTION_DEFS.extract.icon}
				actionLabel={t("archive:archiveExtractHere")}
				actionIcon={ACTION_DEFS.extract.icon}
				isBrowseDisabled={() => !isOnline}
				isTargetDisabled={() => !isOnline}
				onMore={target => {
					onChooseDestination(target.ancestry)
				}}
				onSelect={target => {
					onPick({
						type: "directory",
						destination: {
							uuid: target.uuid,
							name: target.uuid === null ? t("drive:driveMyDrive") : (cachedDirectoryName(target.uuid) ?? "")
						}
					})
				}}
			/>
			<Item
				onClick={() => {
					onChooseDestination()
				}}
			>
				<FolderSearchIcon aria-hidden="true" />
				{t("archive:archiveExtractChooseDestination")}
			</Item>
		</>
	)
}

export interface ArchiveExtractPickerProps {
	// The root-to-directory uuid chain it opens at; the root when absent.
	initialPath?: readonly string[] | undefined
	onPick: (target: ExtractTarget) => void
	onClose: () => void
}

// "Choose destination…": the drive's directory picker, any directory of the Cloud Drive.
export function ArchiveExtractPicker({ initialPath, onPick, onClose }: ArchiveExtractPickerProps) {
	const { t } = useTranslation("archive")

	return (
		<MoveTargetDialog
			mode="pick"
			// An archive's contents may land anywhere.
			items={[]}
			initialPath={initialPath}
			pickLabels={{ title: t("archiveExtractPickTitle"), confirm: t("archiveExtractPickConfirm") }}
			onPick={destination => {
				onPick({ type: "directory", destination })
			}}
			onClose={onClose}
		/>
	)
}
