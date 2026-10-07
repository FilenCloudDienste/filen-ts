import { type MouseEvent } from "react"
import { useTranslation } from "react-i18next"
import { CheckIcon, FileQuestionIcon, LinkIcon, LockIcon, MinusIcon, TriangleAlertIcon } from "lucide-react"
import { cn, formatBytes } from "@filen/shared"
import { formatShortDate } from "@/lib/formatDate"
import { fileIconKey } from "@/features/drive/lib/icon.logic"
import { DirectoryGlyph, FileTypeIcon } from "@/features/drive/components/itemIcon"
import { LIST_MODIFIED_COLUMN_CLASS, LIST_NAME_CLASS, LIST_SIZE_COLUMN_CLASS } from "@/features/drive/lib/listingCells"
import { ARCHIVE_MENU_COLUMN_CLASS, ARCHIVE_ROW_HEIGHT, type EntryRowKind } from "@/features/archive/lib/archiveBrowser.logic"
import type { RowCheck } from "@/features/archive/lib/selection"
import type { RowRef } from "@/features/archive/lib/sortedChildren"
import { ArchiveEntryMenuContent } from "@/features/archive/components/archiveEntryMenu"
import { RowMenuTrigger } from "@/components/rowMenuTrigger"
import { DropdownMenu } from "@/components/ui/dropdown-menu"

export interface ArchiveEntryRowProps {
	id: string
	rowRef: RowRef
	index: number
	// Rows in the list.
	total: number
	// Its offset in the list.
	start: number
	name: string
	kind: EntryRowKind
	// -1 when the archive states none.
	size: number
	// NaN when absent.
	modified: number
	// A directory's direct children.
	childCount: number
	check: RowCheck
	selectable: boolean
	cursor: boolean
	skipLabel: string | null
	encrypted: boolean
	misleading: boolean
	// The name as the archive stores it, when the drive needs another.
	storedPath: string | null
	linkTarget: string | null
	// A search match's directory, "/"-joined.
	parentPath: string | null
	// A file to extract, which the ⋯ menu offers to open, save or extract.
	menu: boolean
	onPointer: (index: number, ref: RowRef, event: MouseEvent<HTMLDivElement>) => void
	onOpen: (ref: RowRef) => void
	onCheck: (index: number, ref: RowRef) => void
}

// One entry of the archive browser's listbox: an option drawing its checkbox as a decorative span (the
// listbox holds focus and selection state; see archiveEntryList.tsx). Primitive props only, so a list
// refresh re-renders just the rows whose values changed.
export function ArchiveEntryRow({
	id,
	rowRef,
	index,
	total,
	start,
	name,
	kind,
	size,
	modified,
	childCount,
	check,
	selectable,
	cursor,
	skipLabel,
	encrypted,
	misleading,
	storedPath,
	linkTarget,
	parentPath,
	menu,
	onPointer,
	onOpen,
	onCheck
}: ArchiveEntryRowProps) {
	const { t } = useTranslation(["preview", "drive"])
	const skipped = skipLabel !== null
	const sizeLabel = kind === "dir" ? t("previewArchiveDirItems", { count: childCount }) : size < 0 ? "" : formatBytes(size)
	const dateLabel = Number.isNaN(modified) ? "" : formatShortDate(modified)
	// Native titles, not tooltips: a row mounts nothing it doesn't draw.
	const nameTitle = [
		skipLabel,
		storedPath === null ? null : t("previewArchiveStoredAs", { path: storedPath }),
		linkTarget === null ? null : t("previewArchiveLinkTarget", { target: linkTarget }),
		misleading ? t("previewArchiveMisleading") : null
	]
		.filter(line => line !== null)
		.join("\n")

	return (
		<div
			id={id}
			role="option"
			aria-selected={check !== "off"}
			aria-disabled={selectable ? undefined : true}
			aria-posinset={index + 1}
			aria-setsize={total}
			data-cursor={cursor ? "" : undefined}
			style={{
				position: "absolute",
				top: 0,
				left: 0,
				width: "100%",
				height: ARCHIVE_ROW_HEIGHT,
				transform: `translateY(${String(start)}px)`
			}}
			className={cn(
				"group/row flex items-center gap-3 px-3 text-sm select-none not-aria-selected:hover:bg-accent/50 aria-selected:bg-accent aria-selected:text-accent-foreground",
				// The listbox holds focus; its cursor row shows it.
				cursor && "group-focus:ring-2 group-focus:ring-ring/50 group-focus:ring-inset"
			)}
			onClick={event => {
				onPointer(index, rowRef, event)
			}}
			onDoubleClick={() => {
				onOpen(rowRef)
			}}
		>
			<span
				aria-hidden="true"
				className={cn(
					"flex size-4 shrink-0 items-center justify-center rounded-[4px] border border-input",
					check !== "off" && "border-primary bg-primary text-primary-foreground",
					!selectable && "opacity-40"
				)}
				onClick={event => {
					event.stopPropagation()
					onCheck(index, rowRef)
				}}
				// A quick second click toggles again; it never opens the row.
				onDoubleClick={event => {
					event.stopPropagation()
				}}
			>
				{check === "on" ? <CheckIcon className="size-3" /> : check === "mixed" ? <MinusIcon className="size-3" /> : null}
			</span>
			<span className={cn("flex shrink-0", skipped && "opacity-50")}>
				{kind === "dir" ? (
					<DirectoryGlyph
						color="default"
						className="size-5"
					/>
				) : kind === "link" ? (
					<LinkIcon
						aria-hidden="true"
						className="size-5 text-muted-foreground"
					/>
				) : kind === "other" ? (
					<FileQuestionIcon
						aria-hidden="true"
						className="size-5 text-muted-foreground"
					/>
				) : (
					<FileTypeIcon
						iconKey={fileIconKey(name)}
						className="size-5"
					/>
				)}
			</span>
			<span
				className={cn(LIST_NAME_CLASS, skipped && "text-muted-foreground")}
				title={nameTitle === "" ? undefined : nameTitle}
			>
				{name}
			</span>
			{misleading ? (
				<TriangleAlertIcon
					aria-label={t("previewArchiveMisleading")}
					className="size-3.5 shrink-0 text-amber-500"
				/>
			) : null}
			{encrypted ? (
				<LockIcon
					aria-label={t("previewArchiveEncrypted")}
					className="size-3.5 shrink-0 text-muted-foreground"
				/>
			) : null}
			{skipLabel !== null ? (
				<span className="hidden max-w-64 min-w-0 shrink truncate text-xs text-muted-foreground sm:block">{skipLabel}</span>
			) : parentPath !== null ? (
				<span className="hidden max-w-48 min-w-0 shrink truncate text-xs text-muted-foreground sm:block">{parentPath}</span>
			) : null}
			<span className={cn(LIST_SIZE_COLUMN_CLASS, "text-right text-xs text-muted-foreground tabular-nums")}>{sizeLabel}</span>
			<span className={cn(LIST_MODIFIED_COLUMN_CLASS, "text-right text-xs text-muted-foreground")}>{dateLabel}</span>
			{menu ? (
				<DropdownMenu>
					<RowMenuTrigger
						label={t("drive:driveItemMenuTrigger")}
						reveal="row"
						// The listbox holds focus; Enter opens or saves the cursor's file.
						tabIndex={-1}
					/>
					<ArchiveEntryMenuContent slot={rowRef} />
				</DropdownMenu>
			) : (
				<span className={ARCHIVE_MENU_COLUMN_CLASS} />
			)}
		</div>
	)
}
