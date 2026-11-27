import { type MouseEvent } from "react"
import { useTranslation } from "react-i18next"
import { CheckIcon, MinusIcon } from "lucide-react"
import { cn } from "@filen/shared"
import { ACTION_DEFS } from "@/features/drive/lib/actionDefs"
import { ItemThumbnail } from "@/features/drive/components/itemThumbnail"
import { formatItemSize, formatModifiedDate } from "@/features/drive/lib/format"
import { LIST_MODIFIED_COLUMN_CLASS, LIST_NAME_CLASS, LIST_ROW_CLASS, LIST_SIZE_COLUMN_CLASS } from "@/features/drive/lib/listingCells"
import {
	CONTEXT_TREE_MENU_FAMILY,
	DROPDOWN_TREE_MENU_FAMILY,
	type DirectoryTreeMenuFamily
} from "@/features/drive/components/directoryTreeSubmenu"
import {
	browseEntryActions,
	entryName,
	entryPath,
	type BrowseEntry,
	type BrowseEntryAction,
	type SelectionCheck
} from "@/features/publicLinks/lib/browse.logic"
import { useTouchLongPress } from "@/lib/useTouchLongPress"
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/components/ui/context-menu"
import { DropdownMenu, DropdownMenuContent } from "@/components/ui/dropdown-menu"
import { RowMenuTrigger } from "@/components/rowMenuTrigger"

// What a row and a tile (browseTile.tsx) both take.
export interface BrowseCellProps {
	entry: BrowseEntry
	index: number
	total: number
	selected: boolean
	// The roving cursor, which holds the listbox's one tab stop.
	active: boolean
	// The link allows downloads; `downloadBusy` while another download runs.
	downloadable: boolean
	downloadBusy: boolean
	saveable: boolean
	onPointerSelect: (index: number, event: MouseEvent<HTMLDivElement>, pointerType: string) => void
	onOpen: (index: number) => void
	onToggle: (index: number) => void
	onAction: (entry: BrowseEntry, action: BrowseEntryAction) => void
	registerRef: (index: number, el: HTMLDivElement | null) => void
}

export interface BrowseRowProps extends BrowseCellProps {
	// The virtualizer's offset for this row.
	start: number
}

// The selection box a row and the column header draw. Decorative: the option's aria-selected, or the
// header's own checkbox role, carries the state.
export function SelectionBox({ check }: { check: SelectionCheck }) {
	return (
		<span
			className={cn(
				"flex size-4 shrink-0 items-center justify-center rounded-[4px] border border-input",
				check !== "off" && "border-primary bg-primary text-primary-foreground"
			)}
		>
			{check === "on" ? <CheckIcon className="size-3" /> : check === "mixed" ? <MinusIcon className="size-3" /> : null}
		</span>
	)
}

// One entry of a public directory's listbox: drive's row (driveRow.tsx) with a selection box ahead of the thumbnail,
// and one per-item menu behind both a right-click and the ⋯ trigger.
export function BrowseRow({
	entry,
	index,
	total,
	start,
	selected,
	active,
	downloadable,
	downloadBusy,
	saveable,
	onPointerSelect,
	onOpen,
	onToggle,
	onAction,
	registerRef
}: BrowseRowProps) {
	const { t } = useTranslation("drive")
	// A held touch selects, as in drive; the context menu stays mouse-only.
	const press = useTouchLongPress<HTMLDivElement>({
		onLongPress: () => {
			onToggle(index)
		}
	})
	const actions = browseEntryActions(entry.kind, downloadable, saveable)
	const path = entryPath(entry)

	return (
		<ContextMenu>
			<ContextMenuTrigger
				render={
					<div
						ref={el => {
							registerRef(index, el)
						}}
						role="option"
						aria-selected={selected}
						aria-posinset={index + 1}
						aria-setsize={total}
						tabIndex={active ? 0 : -1}
						style={{
							position: "absolute",
							top: 0,
							left: 0,
							width: "100%",
							transform: `translateY(${String(start)}px)`
						}}
						className={cn(
							LIST_ROW_CLASS,
							"group/row focus-ring-row outline-none select-none not-aria-selected:hover:bg-accent/50 aria-selected:bg-accent aria-selected:text-accent-foreground"
						)}
						{...press.handlers}
						onClick={event => {
							onPointerSelect(index, event, press.pointerType(event))
						}}
						// A touch tap already opened it.
						onDoubleClick={event => {
							if (press.pointerType(event) !== "touch") {
								onOpen(index)
							}
						}}
					>
						<span
							aria-hidden="true"
							className="flex shrink-0"
							onClick={event => {
								event.stopPropagation()
								onToggle(index)
							}}
							// A quick second click toggles again; it never opens the row.
							onDoubleClick={event => {
								event.stopPropagation()
							}}
						>
							<SelectionBox check={selected ? "on" : "off"} />
						</span>
						<ItemThumbnail
							item={entry.item}
							index={index}
							imgClassName="size-6 shrink-0 rounded-md object-cover"
							iconClassName="size-6 shrink-0"
						/>
						<span className={LIST_NAME_CLASS}>{entryName(entry)}</span>
						{/* A search result's directory path, as drive's search shows it. */}
						{path !== null ? (
							<span
								className="hidden max-w-48 min-w-0 shrink truncate text-xs text-muted-foreground sm:block"
								title={path}
							>
								{path}
							</span>
						) : null}
						<span className={cn(LIST_SIZE_COLUMN_CLASS, "text-right text-xs text-muted-foreground tabular-nums")}>
							{formatItemSize(entry.item)}
						</span>
						<span className={cn(LIST_MODIFIED_COLUMN_CLASS, "text-right text-xs text-muted-foreground")}>
							{formatModifiedDate(entry.item)}
						</span>
						<DropdownMenu>
							<RowMenuTrigger
								label={t("driveItemMenuTrigger")}
								reveal="row"
								tabIndex={active ? 0 : -1}
							/>
							<DropdownMenuContent align="end">
								<BrowseEntryMenuItems
									family={DROPDOWN_TREE_MENU_FAMILY}
									entry={entry}
									actions={actions}
									downloadBusy={downloadBusy}
									onAction={onAction}
								/>
							</DropdownMenuContent>
						</DropdownMenu>
					</div>
				}
			/>
			<ContextMenuContent>
				<BrowseEntryMenuItems
					family={CONTEXT_TREE_MENU_FAMILY}
					entry={entry}
					actions={actions}
					downloadBusy={downloadBusy}
					onAction={onAction}
				/>
			</ContextMenuContent>
		</ContextMenu>
	)
}

// The entry's menu, behind a right-click and its ⋯ trigger alike.
export function BrowseEntryMenuItems({
	family,
	entry,
	actions,
	downloadBusy,
	onAction
}: {
	family: DirectoryTreeMenuFamily
	entry: BrowseEntry
	actions: BrowseEntryAction[]
	downloadBusy: boolean
	onAction: (entry: BrowseEntry, action: BrowseEntryAction) => void
}) {
	const { t } = useTranslation(["drive", "publicLinks"])
	const { Item } = family
	const open = entry.kind === "dir" ? ACTION_DEFS.openDirectory : ACTION_DEFS.openFile

	return actions.map(action => {
		const Icon = action === "open" ? open.icon : action === "download" ? ACTION_DEFS.download.icon : ACTION_DEFS.copy.icon
		const label =
			action === "open"
				? t(open.labelKey)
				: action === "download"
					? entry.kind === "dir"
						? t("publicLinks:downloadAsZip")
						: t(ACTION_DEFS.download.labelKey)
					: t("publicLinks:saveToDrive")

		return (
			<Item
				key={action}
				disabled={action === "download" && downloadBusy}
				onClick={() => {
					onAction(entry, action)
				}}
			>
				<Icon aria-hidden="true" />
				{label}
			</Item>
		)
	})
}
