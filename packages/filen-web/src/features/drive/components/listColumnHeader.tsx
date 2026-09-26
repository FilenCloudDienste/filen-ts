import { useTranslation } from "react-i18next"
import { ArrowDownIcon, ArrowUpIcon } from "lucide-react"
import { DRIVE_SORT_PARTS, nextColumnSort, type DriveSortBy, type DriveSortField } from "@/features/drive/lib/sort"
import { cn } from "@filen/shared"

export interface ListColumnHeaderProps {
	sort: DriveSortBy
	// null clears the location back to the default order (see nextColumnSort).
	onSortChange: (next: DriveSortBy | null) => void
	// Recents is a fixed chronological view, same gate as the Sort by menu.
	disabled: boolean
}

function ColumnButton({
	field,
	label,
	align,
	sort,
	onSortChange,
	disabled
}: ListColumnHeaderProps & { field: DriveSortField; label: string; align: "start" | "end" }) {
	const { t } = useTranslation("drive")
	const parts = DRIVE_SORT_PARTS[sort]
	const direction = parts.field === field ? parts.direction : null
	const Arrow = direction === "desc" ? ArrowDownIcon : ArrowUpIcon
	const arrow =
		direction === null ? null : (
			<Arrow
				aria-hidden="true"
				className="size-3 shrink-0"
			/>
		)

	return (
		<button
			type="button"
			disabled={disabled}
			onClick={() => {
				onSortChange(nextColumnSort(sort, field))
			}}
			className={cn(
				"-mx-1 inline-flex h-6 min-w-0 items-center gap-1 rounded-sm px-1 outline-none focus-visible:ring-2 focus-visible:ring-ring enabled:hover:text-foreground",
				direction !== null && "text-foreground"
			)}
		>
			{/* The arrow sits on the column's inner side so the label keeps its edge over the values. */}
			{align === "end" ? arrow : null}
			<span className="truncate">{label}</span>
			{align === "start" ? arrow : null}
			{direction === null ? null : (
				<span className="sr-only">{direction === "asc" ? t("driveColumnSortedAscending") : t("driveColumnSortedDescending")}</span>
			)}
		</button>
	)
}

// The list view's column header. Clicking a column sorts by it through the same preference the Sort by
// menu writes, so both stay in step, per directory when the user has that setting on.
export function ListColumnHeader(props: ListColumnHeaderProps) {
	const { t } = useTranslation("drive")

	return (
		<div className="flex h-8 shrink-0 items-center gap-3 border-b border-border/50 px-3 text-xs font-medium text-muted-foreground">
			<span
				aria-hidden="true"
				className="size-6 shrink-0"
			/>
			<div className="flex min-w-0 flex-1">
				<ColumnButton
					{...props}
					field="name"
					label={t("driveColumnName")}
					align="start"
				/>
			</div>
			{/* Secondary columns step out by importance as the card narrows (size at sm, modified at lg);
			    name keeps min-w-0 flex-1 and never yields. Modified waits for lg, not md: md is where
			    the shell puts the sidebar back into the row, so the card is at its narrowest just above
			    that breakpoint — the row's variant-only labels (driveRow.tsx) ride with modified for
			    the same reason. */}
			<div className="hidden w-20 shrink-0 justify-end sm:flex">
				<ColumnButton
					{...props}
					field="size"
					label={t("driveColumnSize")}
					align="end"
				/>
			</div>
			<div className="hidden w-28 shrink-0 justify-end lg:flex">
				<ColumnButton
					{...props}
					field="lastModified"
					label={t("driveColumnModified")}
					align="end"
				/>
			</div>
			{/* Holds the row's trailing ⋯ trigger slot (driveRow.tsx), so size/modified sit over their values. */}
			<span
				aria-hidden="true"
				className="size-6 shrink-0 pointer-coarse:size-8"
			/>
		</div>
	)
}
