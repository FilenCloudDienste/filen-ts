import { useTranslation } from "react-i18next"
import { type DriveItem } from "@/features/drive/lib/item"
import { type DriveVariant } from "@/features/drive/lib/preferences"
import type { ParentNaming } from "@/features/drive/lib/archiveTargets"
import { MoveTargetDialog } from "@/features/drive/components/moveTargetDialog"
import { VersionsDialog } from "@/features/drive/components/versionsDialog"
import { InfoDialog } from "@/features/drive/components/infoDialog"
import { LinkDialog } from "@/features/drive/components/linkDialog"
import { ContactPickerDialog } from "@/features/drive/components/contactPickerDialog"
import { CompressDialog } from "@/features/drive/components/compressDialog"
import { ExtractDialog } from "@/features/drive/components/extractDialog"
import { ExtractDestinationDialog } from "@/features/drive/components/extractDestinationDialog"
import { ConfirmDialog } from "@/components/dialogs/confirmDialog"
import { InputDialog } from "@/components/dialogs/inputDialog"

// The per-item dialogs every item surface (drive listing, photos, the preview's header menu) mounts
// identically; each surface keeps its own async handlers and pending state.

export interface RenameItemDialogProps {
	item: DriveItem
	pending: boolean
	onSubmit: (value: string) => void
	onClose: () => void
}

export function RenameItemDialog({ item, pending, onSubmit, onClose }: RenameItemDialogProps) {
	const { t } = useTranslation("drive")

	return (
		<InputDialog
			open
			pending={pending}
			title={t("driveActionRename")}
			body={t("driveRenameDialogBody")}
			label={t("driveNewDirectoryLabel")}
			initialValue={item.data.decryptedMeta?.name ?? ""}
			submitLabel={t("driveActionRename")}
			validate={value => value.trim().length > 0}
			onOpenChange={open => {
				if (!open) {
					onClose()
				}
			}}
			onSubmit={onSubmit}
		/>
	)
}

export interface TrashConfirmDialogProps {
	count: number
	pending: boolean
	onConfirm: () => void
	onClose: () => void
}

export function TrashConfirmDialog({ count, pending, onConfirm, onClose }: TrashConfirmDialogProps) {
	const { t } = useTranslation(["drive", "common"])

	return (
		<ConfirmDialog
			open
			pending={pending}
			title={t("driveTrashConfirmTitle")}
			body={t("driveTrashConfirmBody", { count })}
			confirmLabel={t("driveActionTrash")}
			cancelLabel={t("common:cancel")}
			onOpenChange={open => {
				if (!open) {
					onClose()
				}
			}}
			onConfirm={onConfirm}
		/>
	)
}

// The kinds whose dialog owns its whole action (own state, own calls), so a surface only mounts it.
export type ItemDialogKind = "copy" | "versions" | "info" | "link" | "share" | "compress" | "extract" | "extractTo"

export interface ItemDialogProps {
	kind: ItemDialogKind
	items: DriveItem[]
	variant: DriveVariant
	onClose: () => void
	// Overrides the share picker's own drive-selection cleanup (photos prunes its own selection).
	onShared?: (succeededUuids: string[]) => void
	// Likewise for the originals a compress is to remove.
	onSourcesDisposing?: ((uuids: string[]) => void) | undefined
	// How several items' archive is named after their directory (photos knows its own).
	compressParentNaming?: ParentNaming | undefined
}

export function ItemDialog({ kind, items, variant, onClose, onShared, onSourcesDisposing, compressParentNaming }: ItemDialogProps) {
	const item = items[0]

	if (!item) {
		return null
	}

	switch (kind) {
		// The copy lands in the Cloud Drive tree and runs on with its own progress card; the selection stays.
		case "copy":
			return (
				<MoveTargetDialog
					items={items}
					mode="copy"
					onClose={onClose}
				/>
			)
		case "versions":
			return item.type === "file" ? (
				<VersionsDialog
					file={item}
					onClose={onClose}
				/>
			) : null
		case "info":
			return (
				<InfoDialog
					item={item}
					variant={variant}
					remoteInfoEnabled={variant !== "trash"}
					onClose={onClose}
				/>
			)
		case "link":
			return (
				<LinkDialog
					item={item}
					onClose={onClose}
				/>
			)
		case "share":
			return (
				<ContactPickerDialog
					items={items}
					onClose={onClose}
					{...(onShared !== undefined ? { onShared } : {})}
				/>
			)
		case "compress":
			return (
				<CompressDialog
					subject={{ kind: "drive", items, variant, parentNaming: compressParentNaming }}
					onClose={onClose}
					onSourcesDisposing={onSourcesDisposing}
				/>
			)
		// The options dialog takes one archive; bulk extract only ever picks a destination.
		case "extract":
			return (
				<ExtractDialog
					item={item}
					variant={variant}
					onClose={onClose}
				/>
			)
		case "extractTo":
			return (
				<ExtractDestinationDialog
					items={items}
					variant={variant}
					onClose={onClose}
				/>
			)
	}
}
