import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react"
import { useTranslation } from "react-i18next"
import { ArrowDownAZIcon, ArrowDownZAIcon, ChevronDownIcon, ChevronRightIcon, FilterXIcon, SearchIcon } from "lucide-react"
import type { SheetCommand, SheetDynamicFilter, SheetFilterRange, SheetFilterValues, SheetSessionApi } from "@filen/office/core/sheet"
import { filterButtonRect, type SheetGridHandle, type SheetGridModel } from "@filen/office/react/sheet"
import { Button } from "@/components/ui/button"
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
	DropdownMenuTrigger
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Spinner } from "@/components/ui/spinner"
import {
	PERIODS,
	conditionsFor,
	conditionsKey,
	filterRows,
	groupState,
	isFiltered,
	listCriteria,
	searchItems,
	sortKeys,
	type ConditionItem
} from "@/features/spreadsheet/data/sortFilter.logic"
import { setSortFilterOpen } from "@/features/spreadsheet/data/sortFilterState"

// A header's filter menu, as Excel's: sort the filter's range by the column, clear the column's filter, its text,
// number or date conditions, and the list of its values (searched, checked), applied with OK. Opened from the
// header's button (or Alt+Down on it), beside it.

// The list's row height (px) and how many rows it shows: it draws only the rows in view, so a column of 10,000
// values costs a screenful of rows.
const ROW = 28
const ROWS = 9
const LIMIT = 10_000

type Values =
	{ readonly status: "loading" } | { readonly status: "ready"; readonly values: SheetFilterValues } | { readonly status: "unavailable" }

export function FilterMenu({
	model,
	gridRef,
	session,
	range,
	row,
	col,
	rightToLeft,
	canEdit,
	run
}: {
	model: SheetGridModel
	gridRef: RefObject<SheetGridHandle | null>
	session: SheetSessionApi
	range: SheetFilterRange
	row: number
	col: number
	rightToLeft: boolean
	canEdit: boolean
	run: (command: SheetCommand) => void
}) {
	const { t, i18n } = useTranslation(["preview", "common"])
	const anchorRef = useRef<HTMLSpanElement>(null)
	const [values, setValues] = useState<Values>({ status: "loading" })
	const [checked, setChecked] = useState<ReadonlySet<number>>(new Set())
	const [blankChecked, setBlankChecked] = useState(true)
	const [search, setSearch] = useState("")
	const [scroll, setScroll] = useState(0)
	const listRef = useRef<HTMLDivElement>(null)
	// The dates tree's open years and months ("2024", "2024-1").
	const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
	const sheet = model.getSnapshot().sheet

	useEffect(() => {
		let live = true

		session.query("filter.values", { sheet, row, col, limit: LIMIT }).then(
			result => {
				if (!live) return

				if (result === null) {
					setValues({ status: "unavailable" })

					return
				}

				setValues({ status: "ready", values: result })
				setChecked(new Set(result.items.flatMap((item, index) => (item.checked ? [index] : []))))
				setBlankChecked(result.blank?.checked ?? true)
			},
			() => {
				if (live) setValues({ status: "unavailable" })
			}
		)

		return () => {
			live = false
		}
	}, [session, sheet, row, col])

	// The anchor sits on the header's button, kept there as the grid scrolls.
	useEffect(() => {
		const grid = gridRef.current

		if (grid === null) return undefined

		const place = (): void => {
			const node = anchorRef.current
			const cell = grid.cellRect({ row, col })

			if (node === null) return

			if (cell === null) {
				node.style.visibility = "hidden"

				return
			}

			const layout = model.getSnapshot().layout
			const button = filterButtonRect(cell, layout === null ? 1 : model.scale(layout))
			const x = rightToLeft ? cell.x + 1 : button.x

			node.style.visibility = "visible"
			node.style.transform = `translate(${String(Math.round(x))}px, ${String(Math.round(button.y))}px)`
			node.style.width = `${String(button.width)}px`
			node.style.height = `${String(button.height)}px`
		}

		place()

		return grid.onFrame(place)
	}, [gridRef, model, row, col, rightToLeft])

	function close(): void {
		setSortFilterOpen(model, null)
		gridRef.current?.focus()
	}

	const ready = values.status === "ready" ? values.values : null
	const kind = ready?.kind ?? "text"
	const header = ready?.header ?? ""
	const items = ready?.items ?? []
	const shown = searchItems(items, search)
	const searching = search.trim() !== ""
	const blankRow = ready?.blank !== null && ready?.blank !== undefined && !searching
	// The list's rows: (Select all), the dates tree and the other values, (Blanks); only those in view are drawn.
	const listed = filterRows(items, shown, expanded, blankRow, searching)
	const total = listed.length
	const first = Math.max(0, Math.floor(scroll / ROW) - 2)
	const last = Math.min(total, first + ROWS + 4)
	const allChecked = shown.every(index => checked.has(index)) && (!blankRow || blankChecked)
	const someChecked = shown.some(index => checked.has(index)) || (blankRow && blankChecked)
	const labels = sortKeys(kind)
	const filtered = isFiltered(range, col)

	function sort(descending: boolean): void {
		run({
			type: "sort.apply",
			sheet,
			range: range.range,
			orientation: "rows",
			header: true,
			caseSensitive: false,
			keys: [{ index: col, descending }]
		})
		close()
	}

	function setColumn(criteria: Extract<SheetCommand, { type: "filter.column" }>["criteria"]): void {
		run({ type: "filter.column", sheet, row, col, criteria })
		close()
	}

	function condition(item: ConditionItem): void {
		switch (item.action.type) {
			case "dynamic":
				setColumn({ kind: "dynamic", type: item.action.filter })

				return
			case "top10":
				setSortFilterOpen(model, { type: "top10", row, col, header, criteria: ready?.criteria ?? null })

				return
			case "dialog":
				setSortFilterOpen(model, {
					type: "condition",
					row,
					col,
					header,
					kind,
					first: item.action.first,
					...(item.action.second !== undefined && { second: item.action.second }),
					criteria: ready?.criteria ?? null
				})
		}
	}

	function period(filter: SheetDynamicFilter): string {
		if (filter.startsWith("Q")) return t("previewSheetFilterQuarter", { number: Number(filter.slice(1)) })

		return new Intl.DateTimeFormat(i18n.language, { month: "long", timeZone: "UTC" }).format(
			Date.UTC(2000, Number(filter.slice(1)) - 1, 1)
		)
	}

	function apply(): void {
		if (ready === null) return

		// A search applies to the values it shows: the others, and the blanks, are left out.
		const kept = searching ? new Set(shown.filter(index => checked.has(index))) : checked

		setColumn(listCriteria(items, kept, { present: ready.blank !== null, checked: !searching && blankChecked }))
	}

	function toggleAll(): void {
		const next = new Set(checked)

		for (const index of shown) {
			if (allChecked) next.delete(index)
			else next.add(index)
		}

		setChecked(next)

		if (blankRow) setBlankChecked(!allChecked)
	}

	function toggle(indices: readonly number[], on: boolean): void {
		const next = new Set(checked)

		for (const index of indices) {
			if (on) next.add(index)
			else next.delete(index)
		}

		setChecked(next)
	}

	function groupLabel(year: number, month: number | undefined): string {
		return month === undefined
			? String(year)
			: new Intl.DateTimeFormat(i18n.language, { month: "long", timeZone: "UTC" }).format(Date.UTC(2000, month - 1, 1))
	}

	function listRow(position: number) {
		const row = listed[position]
		const top = position * ROW

		switch (row?.kind) {
			case undefined:
				return null
			case "all":
				return (
					<CheckRow
						key="all"
						label={t("previewSheetFilterSelectAll")}
						checked={allChecked}
						indeterminate={!allChecked && someChecked}
						top={top}
						depth={0}
						onToggle={toggleAll}
					/>
				)
			case "blank":
				return (
					<CheckRow
						key="blank"
						label={t("previewSheetFilterBlanks")}
						checked={blankChecked}
						top={top}
						depth={0}
						onToggle={() => {
							setBlankChecked(!blankChecked)
						}}
					/>
				)
			case "group": {
				const state = groupState(row.leaves, checked)
				const label = groupLabel(row.year, row.month)
				const key = row.key

				return (
					<CheckRow
						key={key}
						label={label}
						checked={state === "all"}
						indeterminate={state === "some"}
						top={top}
						depth={row.depth}
						expander={{
							expanded: row.expanded,
							label: `${t(row.expanded ? "previewSheetFilterCollapse" : "previewSheetFilterExpand")} ${label}`,
							onToggle: () => {
								const next = new Set(expanded)

								if (next.has(key)) next.delete(key)
								else next.add(key)

								setExpanded(next)
							}
						}}
						onToggle={() => {
							toggle(row.leaves, state !== "all")
						}}
					/>
				)
			}
			case "item": {
				const item = items[row.index]
				const index = row.index

				return (
					<CheckRow
						key={index}
						// A day under its month shows its day of the month, as Excel's tree does.
						label={row.depth === 2 && item?.date !== undefined ? String(item.date.day).padStart(2, "0") : (item?.text ?? "")}
						checked={checked.has(index)}
						top={top}
						depth={row.depth}
						onToggle={() => {
							toggle([index], !checked.has(index))
						}}
					/>
				)
			}
		}
	}

	const rows = []

	for (let position = first; position < last; position++) rows.push(listRow(position))

	return (
		<Popover
			open
			onOpenChange={next => {
				if (!next) {
					close()
				}
			}}
		>
			<PopoverTrigger
				render={
					<span
						ref={anchorRef}
						aria-hidden
						className="pointer-events-none absolute top-0 left-0"
						style={{ visibility: "hidden" }}
					/>
				}
			/>
			<PopoverContent
				data-preview-surface
				data-sheet-filter-menu
				align="end"
				aria-label={t("previewSheetFilterButton", { name: header })}
				className="w-72 gap-1 p-1"
			>
				<MenuButton
					disabled={!canEdit}
					onClick={() => {
						sort(false)
					}}
				>
					<ArrowDownAZIcon />
					{t(labels.ascending)}
				</MenuButton>
				<MenuButton
					disabled={!canEdit}
					onClick={() => {
						sort(true)
					}}
				>
					<ArrowDownZAIcon />
					{t(labels.descending)}
				</MenuButton>
				<div className="my-1 h-px bg-border" />
				<MenuButton
					disabled={!canEdit || !filtered}
					onClick={() => {
						setColumn(null)
					}}
				>
					<FilterXIcon />
					{t("previewSheetFilterClearColumn", { name: header })}
				</MenuButton>
				<DropdownMenu>
					<DropdownMenuTrigger
						disabled={!canEdit || ready === null}
						render={
							<button
								type="button"
								className="flex w-full items-center gap-2 rounded-xl px-2 py-1.5 text-left text-sm hover:bg-muted disabled:pointer-events-none disabled:opacity-50"
							>
								<span className="flex-1">{t(conditionsKey(kind))}</span>
								<ChevronRightIcon className="size-4" />
							</button>
						}
					/>
					<DropdownMenuContent
						data-preview-surface
						side={rightToLeft ? "left" : "right"}
						align="start"
						className="max-h-96 overflow-y-auto"
					>
						{conditionsFor(kind).map(item => (
							<DropdownMenuItem
								key={item.key}
								onClick={() => {
									condition(item)
								}}
							>
								{t(item.key)}
							</DropdownMenuItem>
						))}
						{kind === "date" ? (
							<DropdownMenuSub>
								<DropdownMenuSubTrigger>{t("previewSheetFilterAllDatesIn")}</DropdownMenuSubTrigger>
								<DropdownMenuSubContent className="max-h-80 overflow-y-auto">
									{PERIODS.map(filter => (
										<DropdownMenuItem
											key={filter}
											onClick={() => {
												setColumn({ kind: "dynamic", type: filter })
											}}
										>
											{period(filter)}
										</DropdownMenuItem>
									))}
								</DropdownMenuSubContent>
							</DropdownMenuSub>
						) : null}
						<DropdownMenuSeparator />
						<DropdownMenuItem
							onClick={() => {
								setSortFilterOpen(model, {
									type: "condition",
									row,
									col,
									header,
									kind,
									first: "equals",
									criteria: ready?.criteria ?? null
								})
							}}
						>
							{t("previewSheetFilterCustom")}
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
				<div className="my-1 h-px bg-border" />
				{values.status === "loading" ? (
					<Spinner className="m-3 size-4 self-center" />
				) : values.status === "unavailable" ? (
					<p className="p-2 text-muted-foreground">{t("previewSheetFilterUnknown")}</p>
				) : (
					<>
						<div className="relative px-1">
							<SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
							<Input
								aria-label={t("previewSheetFilterSearch")}
								placeholder={t("previewSheetFilterSearch")}
								className="pl-8 leading-5"
								value={search}
								onChange={event => {
									setSearch(event.target.value)
									// The matches start at the top of the list.
									setScroll(0)

									if (listRef.current !== null) listRef.current.scrollTop = 0
								}}
								onKeyDown={event => {
									if (event.key === "Enter" && canEdit) {
										event.preventDefault()
										apply()
									}
								}}
							/>
						</div>
						<div
							ref={listRef}
							role="group"
							aria-label={t("previewSheetFilterValues")}
							className="relative mx-1 scrollbar-gutter-stable overflow-y-auto rounded-xl border border-border"
							style={{ height: `${String(ROW * ROWS)}px` }}
							onScroll={event => {
								setScroll(event.currentTarget.scrollTop)
							}}
						>
							<div style={{ height: `${String(total * ROW)}px` }}>{rows}</div>
						</div>
						{shown.length === 0 && searching ? (
							<p className="px-2 text-xs text-muted-foreground">{t("previewSheetFilterNoMatches")}</p>
						) : null}
						{ready?.more === true ? (
							<p className="px-2 text-xs text-muted-foreground">{t("previewSheetFilterMore", { count: items.length })}</p>
						) : null}
						{ready?.unknown === true ? (
							<p className="px-2 text-xs text-muted-foreground">{t("previewSheetFilterUnknown")}</p>
						) : null}
						<div className="flex justify-end gap-2 p-1">
							<Button
								type="button"
								variant="outline"
								size="sm"
								onClick={close}
							>
								{t("common:cancel")}
							</Button>
							<Button
								type="button"
								size="sm"
								disabled={!canEdit || !someChecked}
								onClick={apply}
							>
								{t("previewSheetFilterApply")}
							</Button>
						</div>
					</>
				)}
			</PopoverContent>
		</Popover>
	)
}

function MenuButton({ disabled, onClick, children }: { disabled: boolean; onClick: () => void; children: ReactNode }) {
	return (
		<button
			type="button"
			disabled={disabled}
			className="flex w-full items-center gap-2 rounded-xl px-2 py-1.5 text-left text-sm hover:bg-muted disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4"
			onClick={onClick}
		>
			{children}
		</button>
	)
}

// Indent per tree level (px).
const INDENT = 16

function CheckRow({
	label,
	checked,
	indeterminate,
	top,
	depth,
	expander,
	onToggle
}: {
	label: string
	checked: boolean
	indeterminate?: boolean
	top: number
	depth: number
	// A group's open and close button.
	expander?: { readonly expanded: boolean; readonly label: string; readonly onToggle: () => void }
	onToggle: () => void
}) {
	const ref = useRef<HTMLInputElement>(null)

	useEffect(() => {
		if (ref.current !== null) ref.current.indeterminate = indeterminate === true
	}, [indeterminate])

	return (
		<div
			className="absolute right-0 left-0 flex items-center gap-1 px-2 text-sm hover:bg-muted"
			style={{ top: `${String(top)}px`, height: `${String(ROW)}px`, paddingInlineStart: `${String(8 + depth * INDENT)}px` }}
		>
			{expander === undefined ? (
				<span className="size-4 shrink-0" />
			) : (
				<button
					type="button"
					aria-label={expander.label}
					aria-expanded={expander.expanded}
					className="flex size-4 shrink-0 items-center justify-center rounded-sm hover:bg-accent"
					onClick={expander.onToggle}
				>
					{expander.expanded ? <ChevronDownIcon className="size-3" /> : <ChevronRightIcon className="size-3 rtl:rotate-180" />}
				</button>
			)}
			<label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2">
				<input
					ref={ref}
					type="checkbox"
					className="size-4 shrink-0 accent-primary"
					checked={checked}
					onChange={onToggle}
				/>
				<span className="truncate">{label === "" ? " " : label}</span>
			</label>
		</div>
	)
}
