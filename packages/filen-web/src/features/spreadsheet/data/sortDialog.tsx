import { useId, useState } from "react"
import { useTranslation } from "react-i18next"
import { ArrowDownIcon, ArrowUpIcon, CopyIcon, PlusIcon, Trash2Icon } from "lucide-react"
import { columnName, type SheetCommand } from "@filen/office/core/sheet"
import { entryText, type SheetGridModel } from "@filen/office/react/sheet"
import { FormDialog } from "@/components/dialogs/formDialog"
import { Button } from "@/components/ui/button"
import { TooltipIconButton } from "@/components/ui/tooltipIconButton"
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { setSortFilterOpen, type SortFilterOpen } from "@/features/spreadsheet/data/sortFilterState"

// Excel's Sort dialog: levels (sort by a column, then by the next where it ties, up to 64), each ascending or
// descending, added, copied, removed and moved; whether the first row is a header; case-sensitive order; and the
// orientation (rows top to bottom by columns, or columns left to right by rows).

const MAX_LEVELS = 64

interface Level {
	readonly key: number
	readonly descending: boolean
}

type SortOpen = Extract<SortFilterOpen, { type: "sort" }>

export function SortDialog({ model, open, run }: { model: SheetGridModel; open: SortOpen; run: (command: SheetCommand) => void }) {
	const { t } = useTranslation(["preview", "common"])
	const id = useId()
	const { range } = open
	const [header, setHeader] = useState(open.header)
	const [caseSensitive, setCaseSensitive] = useState(false)
	const [columns, setColumns] = useState(true)
	const [levels, setLevels] = useState<readonly Level[]>([{ key: open.key, descending: false }])
	const [chosen, setChosen] = useState(0)
	// The header row's texts at open (what a column is called while the first row is a header).
	const [names] = useState(() => {
		const { sheet } = model.getSnapshot()
		const out = new Map<number, string>()

		for (let col = range.startCol; col <= Math.min(range.endCol, range.startCol + 1023); col++) {
			const found = model.entry(sheet, range.startRow, col)
			const text = found === null ? "" : entryText(found.tile, found.entry)

			if (text !== "") out.set(col, text)
		}

		return out
	})
	const first = columns ? range.startCol : range.startRow
	const last = columns ? range.endCol : range.endRow
	const keys: number[] = []
	// The order select's options and the closed trigger's text (Base UI shows the value itself without them).
	const orders = [
		{ value: "ascending", label: t("previewSheetSortOrderAscending") },
		{ value: "descending", label: t("previewSheetSortOrderDescending") }
	]

	for (let index = first; index <= Math.min(last, first + 1023); index++) keys.push(index)

	function label(index: number): string {
		if (!columns) return t("previewSheetSortRowName", { number: index + 1 })

		const name = header ? names.get(index) : undefined

		return name ?? t("previewSheetSortColumnName", { name: columnName(index) })
	}

	function setLevel(at: number, level: Level): void {
		setLevels(levels.map((current, index) => (index === at ? level : current)))
	}

	function move(by: number): void {
		const to = chosen + by

		if (to < 0 || to >= levels.length) return

		const next = levels.slice()
		const [level] = next.splice(chosen, 1)

		if (level !== undefined) next.splice(to, 0, level)

		setLevels(next)
		setChosen(to)
	}

	function close(): void {
		setSortFilterOpen(model, null)
	}

	return (
		<FormDialog
			open
			pending={false}
			title={t("previewSheetSortTitle")}
			description={t(columns ? "previewSheetSortBody" : "previewSheetSortBodyColumns")}
			submitLabel={t("previewSheetSortApply")}
			cancelLabel={t("common:cancel")}
			canSubmit={levels.length > 0}
			wide
			onOpenChange={next => {
				if (!next) {
					close()
				}
			}}
			onSubmit={event => {
				event.preventDefault()
				run({
					type: "sort.apply",
					sheet: model.getSnapshot().sheet,
					range,
					orientation: columns ? "rows" : "cols",
					header: columns && header,
					caseSensitive,
					keys: levels.map(level => ({ index: level.key, descending: level.descending }))
				})
				close()
			}}
		>
			<div className="flex flex-col gap-4">
				<div className="flex flex-wrap items-center gap-1">
					<Button
						type="button"
						variant="outline"
						size="sm"
						disabled={levels.length >= MAX_LEVELS}
						onClick={() => {
							const used = new Set(levels.map(level => level.key))

							setLevels([...levels, { key: keys.find(key => !used.has(key)) ?? first, descending: false }])
							setChosen(levels.length)
						}}
					>
						<PlusIcon />
						{t("previewSheetSortAddLevel")}
					</Button>
					<Button
						type="button"
						variant="outline"
						size="sm"
						disabled={levels.length <= 1}
						onClick={() => {
							setLevels(levels.filter((_, index) => index !== chosen))
							setChosen(Math.max(0, chosen - 1))
						}}
					>
						<Trash2Icon />
						{t("previewSheetSortDeleteLevel")}
					</Button>
					<Button
						type="button"
						variant="outline"
						size="sm"
						disabled={levels.length >= MAX_LEVELS}
						onClick={() => {
							const level = levels[chosen]

							if (level !== undefined) {
								setLevels([...levels.slice(0, chosen + 1), level, ...levels.slice(chosen + 1)])
								setChosen(chosen + 1)
							}
						}}
					>
						<CopyIcon />
						{t("previewSheetSortCopyLevel")}
					</Button>
					<TooltipIconButton
						label={t("previewSheetSortMoveUp")}
						disabled={chosen === 0}
						onClick={() => {
							move(-1)
						}}
					>
						<ArrowUpIcon />
					</TooltipIconButton>
					<TooltipIconButton
						label={t("previewSheetSortMoveDown")}
						disabled={chosen >= levels.length - 1}
						onClick={() => {
							move(1)
						}}
					>
						<ArrowDownIcon />
					</TooltipIconButton>
				</div>
				<div
					role="list"
					className="flex max-h-64 scrollbar-gutter-stable flex-col gap-2 overflow-y-auto"
				>
					{levels.map((level, index) => (
						<div
							// Levels repeat (a copy): their place is their identity.
							key={index}
							role="listitem"
							aria-current={index === chosen}
							className="flex items-center gap-2 rounded-xl p-1 aria-current:bg-muted"
							onFocus={() => {
								setChosen(index)
							}}
							onPointerDown={() => {
								setChosen(index)
							}}
						>
							<span className="w-16 shrink-0 text-sm text-muted-foreground">
								{t(index === 0 ? "previewSheetSortBy" : "previewSheetSortThenBy")}
							</span>
							<Select
								value={String(level.key)}
								onValueChange={(next: string | null) => {
									setLevel(index, { ...level, key: Number(next ?? level.key) })
								}}
							>
								<SelectTrigger
									aria-label={t(columns ? "previewSheetSortKey" : "previewSheetSortKeyRow")}
									className="min-w-0 flex-1"
								>
									<SelectValue>{label(level.key)}</SelectValue>
								</SelectTrigger>
								<SelectContent
									data-preview-surface
									className="max-h-72"
								>
									<SelectGroup>
										{keys.map(key => (
											<SelectItem
												key={key}
												value={String(key)}
											>
												{label(key)}
											</SelectItem>
										))}
									</SelectGroup>
								</SelectContent>
							</Select>
							<Select
								items={orders}
								value={level.descending ? "descending" : "ascending"}
								onValueChange={(next: string | null) => {
									setLevel(index, { ...level, descending: next === "descending" })
								}}
							>
								<SelectTrigger
									aria-label={t("previewSheetSortOrder")}
									className="w-36 shrink-0"
								>
									<SelectValue />
								</SelectTrigger>
								<SelectContent data-preview-surface>
									<SelectGroup>
										{orders.map(item => (
											<SelectItem
												key={item.value}
												value={item.value}
											>
												{item.label}
											</SelectItem>
										))}
									</SelectGroup>
								</SelectContent>
							</Select>
						</div>
					))}
				</div>
				<div className="flex flex-col gap-3">
					<div className="flex items-center gap-2">
						<input
							id={`${id}-header`}
							type="checkbox"
							className="size-4 accent-primary"
							checked={columns && header}
							disabled={!columns}
							onChange={event => {
								setHeader(event.target.checked)
							}}
						/>
						<Label htmlFor={`${id}-header`}>{t("previewSheetSortHeaders")}</Label>
					</div>
					<div className="flex items-center gap-2">
						<input
							id={`${id}-case`}
							type="checkbox"
							className="size-4 accent-primary"
							checked={caseSensitive}
							onChange={event => {
								setCaseSensitive(event.target.checked)
							}}
						/>
						<Label htmlFor={`${id}-case`}>{t("previewSheetSortCaseSensitive")}</Label>
					</div>
					<RadioGroup
						aria-label={t("previewSheetSortOrientation")}
						name={`${id}-orientation`}
						value={columns ? "rows" : "cols"}
						onValueChange={next => {
							const rows = next !== "cols"

							setColumns(rows)
							setLevels([{ key: rows ? open.key : range.startRow, descending: false }])
							setChosen(0)
						}}
					>
						{(["rows", "cols"] as const).map(value => (
							<div
								key={value}
								className="flex items-center gap-2"
							>
								<RadioGroupItem
									id={`${id}-${value}`}
									value={value}
								/>
								<Label htmlFor={`${id}-${value}`}>
									{t(value === "rows" ? "previewSheetSortTopToBottom" : "previewSheetSortLeftToRight")}
								</Label>
							</div>
						))}
					</RadioGroup>
				</div>
			</div>
		</FormDialog>
	)
}
