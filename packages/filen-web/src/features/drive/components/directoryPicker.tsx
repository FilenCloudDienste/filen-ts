import { Fragment, useState, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import type { UseQueryResult } from "@tanstack/react-query"
import { useVirtualizer } from "@tanstack/react-virtual"
import { ChevronRightIcon, FolderOpenIcon } from "lucide-react"
import type { DriveItem } from "@/features/drive/lib/item"
import { asErrorDTO } from "@/lib/sdk/errors"
import { cn, driveItemName } from "@filen/shared"
import { DirectoryGlyph } from "@/features/drive/components/itemIcon"
import { EmptyState } from "@/features/drive/components/emptyState"
import { LoadingState } from "@/components/loadingState"
import { EmptyMessage, NoResultsMessage } from "@/components/emptyMessage"
import { SURFACE_RING } from "@/components/ui/surface"
import { LIST_DIALOG_BODY_CLASS } from "@/components/dialogs/listDialog"
import { observeElementOffsetFromAttach } from "@/lib/virtualScroll"

// Shared UI of the in-dialog drive pickers (move/copy, photos root, chat attach, playlist tracks); their
// state lives in hooks/useDirectoryPicker.ts, their new-directory row in hooks/usePickerNewDirectory.tsx. Row gating and
// selection stay per dialog. The list is a window over
// fixed-height rows: a directory of tens of thousands of files mounts what is in view.

export const PICKER_ROW_CLASS =
	"flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm focus-ring-row outline-none hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-50"

export interface PickerBreadcrumbProps {
	pathStack: string[]
	names: Record<string, string> | undefined
	onRoot: () => void
	onJump: (index: number) => void
}

export function PickerBreadcrumb({ pathStack, names, onRoot, onJump }: PickerBreadcrumbProps) {
	const { t } = useTranslation("drive")

	return (
		<nav
			aria-label={t("driveBreadcrumbLabel")}
			className="flex items-center gap-1.5 overflow-x-auto text-sm"
		>
			<button
				type="button"
				disabled={pathStack.length === 0}
				onClick={onRoot}
				className={cn(
					"shrink-0",
					pathStack.length === 0 ? "font-medium text-foreground" : "text-muted-foreground hover:text-foreground hover:underline"
				)}
			>
				{t("driveMyDrive")}
			</button>
			{pathStack.map((uuid, index) => {
				const isLast = index === pathStack.length - 1

				return (
					<Fragment key={uuid}>
						<ChevronRightIcon
							aria-hidden="true"
							className="size-3.5 shrink-0 text-muted-foreground"
						/>
						<button
							type="button"
							disabled={isLast}
							onClick={() => {
								onJump(index)
							}}
							className={cn(
								"min-w-0 shrink-0 truncate",
								isLast ? "font-medium text-foreground" : "text-muted-foreground hover:text-foreground hover:underline"
							)}
						>
							{names?.[uuid] ?? uuid}
						</button>
					</Fragment>
				)
			})}
		</nav>
	)
}

// A single-line PICKER_ROW_CLASS button (py-2 around a 20px line) and the 2px gap below it.
export const PICKER_ROW_HEIGHT = 38
// The list's padding, inside the scroll box.
export const PICKER_LIST_PADDING = 8
const PICKER_OVERSCAN = 8

export interface PickerListShellProps {
	listingQuery: UseQueryResult<DriveItem[]>
	// An active filter matched nothing: show the no-results state instead of the empty-directory one.
	noResults?: boolean
	// The directory has rows, but none of the kind this picker offers: this line instead of the empty-directory state.
	filteredOutMessage?: string | undefined
	count: number
	// A stable key for the row at `index` (the item's uuid).
	rowKey: (index: number) => string
	// The row at `index`: a single-line PICKER_ROW_CLASS button; the shell gives it its list item.
	renderRow: (index: number) => ReactNode
	// Pinned over the rows while they scroll (the new-directory row), at a fixed height that includes the list's top padding.
	leading?: PickerLeading | undefined
}

export interface PickerLeading {
	node: ReactNode
	height: number
}

export function PickerListShell({ listingQuery, noResults, filteredOutMessage, count, rowKey, renderRow, leading }: PickerListShellProps) {
	const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null)

	return (
		<div
			ref={setScrollElement}
			className={`flex scrollbar-gutter-stable flex-col overflow-y-auto rounded-xl ${SURFACE_RING} ${LIST_DIALOG_BODY_CLASS}`}
		>
			{listingQuery.status === "pending" ? (
				<LoadingState size="md" />
			) : listingQuery.status === "error" ? (
				<EmptyState
					variant="error"
					error={asErrorDTO(listingQuery.error)}
					onRetry={() => {
						void listingQuery.refetch()
					}}
				/>
			) : count === 0 && leading === undefined ? (
				noResults === true ? (
					<NoResultsMessage />
				) : filteredOutMessage !== undefined ? (
					<EmptyMessage
						icon={FolderOpenIcon}
						title={filteredOutMessage}
					/>
				) : (
					<EmptyState
						variant="empty"
						driveVariant="drive"
					/>
				)
			) : (
				<>
					{leading === undefined ? null : (
						<div
							className="sticky top-0 z-10 shrink-0 bg-popover px-2 pt-2"
							style={{ height: leading.height }}
						>
							{leading.node}
						</div>
					)}
					<PickerRows
						scrollElement={scrollElement}
						count={count}
						rowKey={rowKey}
						renderRow={renderRow}
						leadingHeight={leading?.height ?? 0}
					/>
				</>
			)}
		</div>
	)
}

// Its own component: useVirtualizer opts its host out of the React Compiler, and a scroll render reaches only this.
function PickerRows({
	scrollElement,
	count,
	rowKey,
	renderRow,
	leadingHeight
}: {
	scrollElement: HTMLDivElement | null
	count: number
	rowKey: (index: number) => string
	renderRow: (index: number) => ReactNode
	// The pinned row above the list: the rows start below it, and it holds the top padding already.
	leadingHeight: number
}) {
	"use no memo"

	const virtualizer = useVirtualizer({
		count,
		getScrollElement: () => scrollElement,
		observeElementOffset: observeElementOffsetFromAttach,
		estimateSize: () => PICKER_ROW_HEIGHT,
		paddingStart: leadingHeight > 0 ? 0 : PICKER_LIST_PADDING,
		scrollMargin: leadingHeight,
		paddingEnd: PICKER_LIST_PADDING,
		overscan: PICKER_OVERSCAN,
		getItemKey: rowKey
	})

	return (
		<ul
			className="relative w-full shrink-0"
			style={{ height: virtualizer.getTotalSize() }}
		>
			{virtualizer.getVirtualItems().map(row => (
				<li
					key={row.key}
					className="absolute top-0 right-2 left-2"
					style={{ height: PICKER_ROW_HEIGHT, transform: `translateY(${String(row.start - leadingHeight)}px)` }}
				>
					{renderRow(row.index)}
				</li>
			))}
		</ul>
	)
}

export interface PickerDirectoryRowProps {
	directory: Extract<DriveItem, { type: "directory" }>
	disabled: boolean
	// Why the row can't be picked, after its name.
	hint?: string | undefined
	onDescend: (uuid: string) => void
}

// Single click only focuses; double-click or Enter descends, leaving the current directory as the pick.
export function PickerDirectoryRow({ directory, disabled, hint, onDescend }: PickerDirectoryRowProps) {
	return (
		<button
			type="button"
			disabled={disabled}
			onDoubleClick={() => {
				if (!disabled) {
					onDescend(directory.data.uuid)
				}
			}}
			onKeyDown={event => {
				if (event.key === "Enter" && !disabled) {
					event.preventDefault()
					onDescend(directory.data.uuid)
				}
			}}
			className={PICKER_ROW_CLASS}
		>
			<DirectoryGlyph
				color={directory.data.color}
				className="size-4 shrink-0"
			/>
			<span className="min-w-0 flex-1 truncate">{driveItemName(directory)}</span>
			{hint === undefined ? null : <span className="shrink-0 text-xs text-muted-foreground">{hint}</span>}
		</button>
	)
}
