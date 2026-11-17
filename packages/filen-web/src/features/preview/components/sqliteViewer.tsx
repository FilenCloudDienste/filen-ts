import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { CheckIcon, CircleAlertIcon, DatabaseIcon, EyeIcon, TableIcon } from "lucide-react"
import { cn, driveItemName, formatBytes } from "@filen/shared"
import type { SheetGridHandle } from "@filen/office/react/sheet"
import type { DriveItem } from "@/features/drive/lib/item"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { sdkApi } from "@/lib/sdk/client"
import { useOwnedWorker } from "@/lib/workers/ownedWorker"
import { usePreviewAccessMode, usePreviewOrigin, usePreviewSiblings } from "@/features/preview/lib/accessMode"
import { cachedSiblings } from "@/features/preview/lib/previewSubtitles"
import { PreviewLoading, PreviewUnsupportedState } from "@/features/preview/components/previewErrorState"
import { SqliteTableGrid } from "@/features/preview/components/sqliteTableGrid"
import type { SqliteBrowseWorkerApi } from "@/features/preview/workers/sqliteBrowse.worker"
import type { SqliteCellValue, SqliteLabels, SqliteTableInfo } from "@/features/preview/lib/sqliteBrowser"
import { SQLITE_HEX_DUMP_BYTES, hexDump } from "@/features/preview/lib/sqliteBrowse.logic"
import { SQLITE_WINDOW_ROWS } from "@/features/preview/lib/sqliteSource"
import {
	SQLITE_COUNT_IDLE_MS,
	createSqliteWorker,
	openSqliteDatabase,
	runSqliteCheck,
	type SqliteDatabase,
	type SqliteOpenOptions,
	type SqliteWorker
} from "@/features/preview/lib/sqliteDatabase"

type OpenState =
	| { status: "opening" }
	| { status: "open"; database: SqliteDatabase; options: SqliteOpenOptions }
	| { status: "failed"; reason: "notSqlite" | "unreadable" | "damaged" }

type CheckState =
	| { status: "notChecked" }
	| { status: "checking"; read: number; cancel: () => void }
	| { status: "checked" }
	| { status: "damaged" }
	| { status: "failed" }

interface Counted {
	readonly rows: number
	readonly exact: boolean
}

// Opens the database in the viewer's worker once it is up; the bridge and its downloads end with the viewer. `retry`
// opens it again after a failed read.
function useSqliteOpen(item: DriveItem, worker: SqliteWorker | null, labels: SqliteLabels): { state: OpenState; retry: () => void } {
	const origin = usePreviewOrigin(item)
	const access = usePreviewAccessMode()
	const [state, setState] = useState<OpenState>({ status: "opening" })
	const [attempt, setAttempt] = useState(0)
	const [interrupt] = useState(() => new Int32Array(new SharedArrayBuffer(4)))
	const readOrigin = useRef(origin)

	useEffect(() => {
		if (worker === null) {
			return
		}

		let live = true
		let close = (): void => undefined
		const token = crypto.randomUUID()
		const options: SqliteOpenOptions = { access, token, labels, interrupt }

		openSqliteDatabase(worker, readOrigin.current, options).then(
			outcome => {
				if (!live) {
					if (outcome.ok) outcome.database.close()

					return
				}

				if (outcome.ok) {
					close = () => {
						outcome.database.close()
					}
					setState({ status: "open", database: outcome.database, options })
				} else {
					setState({ status: "failed", reason: outcome.reason })
				}
			},
			() => {
				if (live) setState({ status: "failed", reason: "unreadable" })
			}
		)

		return () => {
			live = false
			close()
			void sdkApi.cancelPreviewDownload(token)
		}
	}, [worker, access, labels, interrupt, attempt])

	return {
		state,
		retry: () => {
			setState({ status: "opening" })
			setAttempt(previous => previous + 1)
		}
	}
}

// The rows of `table`, counted in chunks while the grid is idle; the first chunk at once.
function useRowCount(database: SqliteDatabase, table: number | null): Counted | null {
	const [counts, setCounts] = useState<ReadonlyMap<number, Counted>>(new Map())
	const known = table === null ? undefined : counts.get(table)
	const exact = known?.exact === true

	useEffect(() => {
		if (table === null || exact) {
			return
		}

		let live = true
		let first = true
		let timer: ReturnType<typeof setTimeout> | undefined
		const step = (): void => {
			const idle = performance.now() - database.lastRead()

			if (!first && idle < SQLITE_COUNT_IDLE_MS) {
				timer = setTimeout(step, SQLITE_COUNT_IDLE_MS - idle)

				return
			}

			first = false
			database.count(table).then(
				counted => {
					if (!live) return

					setCounts(previous => new Map(previous).set(table, counted))

					if (!counted.exact) timer = setTimeout(step, 0)
				},
				() => undefined
			)
		}

		step()

		return () => {
			live = false
			clearTimeout(timer)
		}
	}, [database, table, exact])

	return known ?? null
}

function TableList({
	tables,
	selected,
	onSelect
}: {
	tables: readonly SqliteTableInfo[]
	selected: number | null
	onSelect: (index: number) => void
}) {
	const { t } = useTranslation("preview")
	const groups = [
		{ kind: "table", label: "previewSqliteTables", icon: TableIcon },
		{ kind: "view", label: "previewSqliteViews", icon: EyeIcon },
		{ kind: "virtual", label: "previewSqliteVirtual", icon: DatabaseIcon }
	] as const

	return (
		<nav className="flex max-h-40 min-h-0 shrink-0 flex-col gap-3 overflow-y-auto border-b border-border/50 p-2 sm:max-h-none sm:w-56 sm:border-r sm:border-b-0">
			{groups.map(group => {
				const members = tables.flatMap((table, index) => (table.kind === group.kind ? [{ table, index }] : []))

				if (members.length === 0) {
					return null
				}

				const Icon = group.icon

				return (
					<section
						key={group.kind}
						className="flex flex-col gap-0.5"
					>
						<h3 className="px-2 text-xs font-medium text-muted-foreground">{t(group.label, { count: members.length })}</h3>
						{members.map(({ table, index }) => (
							<button
								key={table.name}
								type="button"
								aria-current={index === selected ? "true" : undefined}
								className={cn(
									"flex items-center gap-2 truncate rounded-md px-2 py-1 text-start text-sm hover:bg-muted",
									index === selected && "bg-muted font-medium"
								)}
								onClick={() => {
									onSelect(index)
								}}
							>
								<Icon className="size-3.5 shrink-0 text-muted-foreground" />
								<span className="truncate">{table.name}</span>
							</button>
						))}
					</section>
				)
			})}
		</nav>
	)
}

function CheckChip({ check, onCheck }: { check: CheckState; onCheck: () => void }) {
	const { t } = useTranslation("preview")

	switch (check.status) {
		case "notChecked":
			return (
				<span className="flex items-center gap-2 text-xs text-muted-foreground">
					<CircleAlertIcon className="size-3.5" />
					{t("previewSqliteNotChecked")}
					<Button
						size="sm"
						variant="outline"
						onClick={onCheck}
					>
						{t("previewSqliteCheck")}
					</Button>
				</span>
			)
		case "checking":
			return null
		case "checked":
			return (
				<span className="flex items-center gap-1 text-xs text-muted-foreground">
					<CheckIcon className="size-3.5" />
					{t("previewSqliteChecked")}
				</span>
			)
		case "failed":
			return (
				<span className="flex items-center gap-2 text-xs text-muted-foreground">
					{t("previewSqliteCheckFailed")}
					<Button
						size="sm"
						variant="outline"
						onClick={onCheck}
					>
						{t("previewSqliteCheck")}
					</Button>
				</span>
			)
		case "damaged":
			return null
	}
}

function CheckProgress({ check, total }: { check: Extract<CheckState, { status: "checking" }>; total: number }) {
	const { t } = useTranslation(["preview", "common"])

	return (
		<span className="flex items-center gap-2 text-xs text-muted-foreground tabular-nums">
			{check.read > 0
				? t("previewSqliteChecking", { read: formatBytes(Math.min(check.read, total)), total: formatBytes(total) })
				: t("previewSqliteCheckingUnknown")}
			<Button
				size="sm"
				variant="outline"
				onClick={check.cancel}
			>
				{t("common:cancel")}
			</Button>
		</span>
	)
}

function GoToRow({ onGo }: { onGo: (row: number) => void }) {
	const { t } = useTranslation("preview")
	const [open, setOpen] = useState(false)
	const [value, setValue] = useState("")

	if (!open) {
		return (
			<Button
				size="sm"
				variant="outline"
				onClick={() => {
					setOpen(true)
				}}
			>
				{t("previewSqliteGoToRow")}
			</Button>
		)
	}

	return (
		<form
			className="flex items-center gap-1"
			onSubmit={event => {
				event.preventDefault()

				const row = Number.parseInt(value, 10)

				if (Number.isSafeInteger(row) && row >= 1) {
					onGo(row)
					setOpen(false)
				}
			}}
		>
			<Input
				aria-label={t("previewSqliteGoToRowLabel")}
				inputMode="numeric"
				className="h-8 w-28 leading-5"
				value={value}
				autoFocus
				onChange={event => {
					setValue(event.target.value)
				}}
			/>
			<Button
				size="sm"
				type="submit"
			>
				{t("previewSqliteGo")}
			</Button>
		</form>
	)
}

function cellPreview(value: SqliteCellValue): string {
	if (value.value === null) return ""
	if (typeof value.value === "string") return value.value

	return hexDump(value.value.subarray(0, 256))
}

function SelectedCell({ table, column, row, value }: { table: string; column: string; row: number; value: SqliteCellValue | null }) {
	const { t } = useTranslation("preview")
	const [full, setFull] = useState(false)

	return (
		<div className="flex min-w-0 items-center gap-3 border-t border-border/50 px-3 py-1.5 text-xs">
			<span className="shrink-0 text-muted-foreground">{t("previewSqliteSelected", { table, column, row })}</span>
			<span className="min-w-0 flex-1 truncate font-mono">
				{value === null ? "" : value.type === "null" ? t("previewSqliteNull") : cellPreview(value)}
			</span>
			{value !== null && value.value !== null ? (
				<Button
					size="sm"
					variant="ghost"
					onClick={() => {
						setFull(true)
					}}
				>
					{t("previewSqliteFullValue")}
				</Button>
			) : null}
			<Dialog
				open={full}
				onOpenChange={setFull}
			>
				<DialogContent
					data-preview-surface
					className="flex max-h-[min(40rem,calc(100dvh-2rem))] flex-col gap-3 sm:max-w-3xl"
				>
					<DialogHeader>
						<DialogTitle>{t("previewSqliteSelected", { table, column, row })}</DialogTitle>
					</DialogHeader>
					{value !== null && value.value instanceof Uint8Array ? (
						<p className="text-xs text-muted-foreground">
							{t("previewSqliteHexDump", { size: formatBytes(Math.min(value.value.length, SQLITE_HEX_DUMP_BYTES)) })}
						</p>
					) : null}
					{value !== null && typeof value.value === "string" && value.value.length < value.bytes / 4 ? (
						<p className="text-xs text-muted-foreground">
							{t("previewSqliteValueTooLarge", { size: formatBytes(value.bytes) })}
						</p>
					) : null}
					<pre className="min-h-0 flex-1 overflow-auto rounded-md bg-muted p-3 font-mono text-xs break-all whitespace-pre-wrap select-text">
						{value === null
							? ""
							: typeof value.value === "string"
								? value.value
								: value.value === null
									? ""
									: hexDump(value.value)}
					</pre>
				</DialogContent>
			</Dialog>
		</div>
	)
}

function TableView({
	database,
	table,
	index,
	check,
	onCheck
}: {
	database: SqliteDatabase
	table: SqliteTableInfo
	index: number
	check: CheckState
	onCheck: () => void
}) {
	const { t } = useTranslation("preview")
	const [tab, setTab] = useState<"data" | "schema">(table.kind === "table" ? "data" : "schema")
	const [base, setBase] = useState(0)
	const [active, setActive] = useState<{ row: number; col: number }>({ row: 0, col: 0 })
	const [value, setValue] = useState<SqliteCellValue | null>(null)
	const gridRef = useRef<SheetGridHandle | null>(null)
	const browsable = table.kind === "table" && table.columns.length > 0
	const counted = useRowCount(database, browsable ? index : null)
	const [reads] = useState(() => database.reads(index))
	const column = table.columns[active.col]

	useEffect(() => {
		if (!browsable || active.row === 0) {
			return
		}

		let live = true
		const cellReads = database.reads(index)

		cellReads.cell(base, active.row, active.col, cellReads.nextId()).then(
			cell => {
				if (live) setValue(cell)
			},
			() => undefined
		)

		return () => {
			live = false
		}
	}, [browsable, database, index, base, active.row, active.col])

	const goTo = (row: number): void => {
		// Data row `row` (1-based) is grid row row - base while it is in the window.
		if (row > base && row - base <= SQLITE_WINDOW_ROWS && (counted === null || row <= counted.rows || !counted.exact)) {
			gridRef.current?.goTo({ row: row - base, col: 0 })

			return
		}

		setBase(row - 1)
	}

	return (
		<Tabs
			value={tab}
			onValueChange={(next: unknown) => {
				if (next === "data" || next === "schema") setTab(next)
			}}
			className="flex min-h-0 min-w-0 flex-1 flex-col gap-0"
		>
			<div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2">
				<TabsList>
					<TabsTrigger
						value="data"
						disabled={!browsable}
					>
						{t("previewSqliteTabData")}
					</TabsTrigger>
					<TabsTrigger value="schema">{t("previewSqliteTabSchema")}</TabsTrigger>
				</TabsList>
				<span className="min-w-0 truncate text-sm">
					<span className="font-medium">{table.name}</span>
					{browsable && counted !== null ? (
						<span className="text-muted-foreground">
							{" · "}
							{counted.exact
								? t("previewSqliteRows", { count: counted.rows })
								: t("previewSqliteRowsAtLeast", { count: counted.rows })}
						</span>
					) : null}
				</span>
				{base > 0 ? <span className="text-xs text-muted-foreground">{t("previewSqliteWindow", { from: base + 1 })}</span> : null}
				<span className="ms-auto flex items-center gap-3">
					{check.status === "checking" ? (
						<CheckProgress
							check={check}
							total={database.size}
						/>
					) : (
						<CheckChip
							check={check}
							onCheck={onCheck}
						/>
					)}
					{browsable && tab === "data" ? <GoToRow onGo={goTo} /> : null}
				</span>
			</div>
			<TabsContent
				value="data"
				className="flex min-h-0 flex-1 flex-col"
			>
				{browsable && counted !== null ? (
					<>
						<SqliteTableGrid
							key={`${String(index)}:${String(base)}`}
							name={table.name}
							columns={table.columns}
							reads={reads}
							rows={counted.rows}
							base={base}
							gridRef={gridRef}
							onActive={(row, col) => {
								setActive({ row, col })
							}}
						/>
						{active.row > 0 && column !== undefined ? (
							<SelectedCell
								table={table.name}
								column={column.name}
								row={base + active.row}
								value={value}
							/>
						) : null}
					</>
				) : browsable ? (
					<PreviewLoading />
				) : null}
			</TabsContent>
			<TabsContent
				value="schema"
				className="min-h-0 flex-1 overflow-auto px-3 pb-3"
			>
				{table.kind === "view" ? <p className="pb-2 text-sm text-muted-foreground">{t("previewSqliteViewNotRun")}</p> : null}
				{table.kind === "virtual" ? (
					<p className="pb-2 text-sm text-muted-foreground">{t("previewSqliteVirtualNotBrowsed")}</p>
				) : null}
				{table.kind === "table" && table.columns.length === 0 ? (
					<p className="pb-2 text-sm text-muted-foreground">{t("previewSqliteNoColumns")}</p>
				) : null}
				<pre className="rounded-md bg-muted p-3 font-mono text-xs break-all whitespace-pre-wrap select-text">{table.sql}</pre>
			</TabsContent>
		</Tabs>
	)
}

function DatabaseView({
	item,
	worker,
	database,
	options
}: {
	item: DriveItem
	worker: SqliteWorker
	database: SqliteDatabase
	options: SqliteOpenOptions
}) {
	const { t } = useTranslation("preview")
	const origin = usePreviewOrigin(item)
	const siblings = usePreviewSiblings()
	const { tables } = database.schema
	const [selected, setSelected] = useState<number | null>(() => {
		const first = tables.findIndex(table => table.kind === "table")

		return first === -1 ? (tables.length > 0 ? 0 : null) : first
	})
	const [check, setCheck] = useState<CheckState>({ status: "notChecked" })
	const [checkRun, setCheckRun] = useState(database.autoCheck ? 1 : 0)
	const readOrigin = useRef(origin)
	const name = driveItemName(item).toLowerCase()
	const walSibling = (siblings ?? cachedSiblings(item.data.uuid)).some(sibling => driveItemName(sibling).toLowerCase() === `${name}-wal`)

	useEffect(() => {
		if (checkRun === 0) {
			return
		}

		let live = true
		const run = runSqliteCheck(worker, database, readOrigin.current, options, read => {
			if (live) setCheck(previous => (previous.status === "checking" ? { ...previous, read } : previous))
		})

		setCheck({ status: "checking", read: 0, cancel: run.cancel })
		run.result.then(
			outcome => {
				if (!live) return

				setCheck(
					outcome === "ok" ? { status: "checked" } : outcome === "damaged" ? { status: "damaged" } : { status: "notChecked" }
				)
			},
			() => {
				if (live) setCheck({ status: "failed" })
			}
		)

		return () => {
			live = false
			run.cancel()
		}
	}, [checkRun, worker, database, options])

	if (check.status === "damaged") {
		return (
			<PreviewUnsupportedState
				item={item}
				message={t("previewSqliteDamaged")}
			/>
		)
	}

	const table = selected === null ? undefined : tables[selected]

	return (
		<div className="flex size-full min-h-0 flex-col">
			{database.schema.wal || walSibling ? (
				<p className="border-b border-border/50 px-3 py-1.5 text-xs text-muted-foreground">{t("previewSqliteWal")}</p>
			) : null}
			<div className="flex min-h-0 flex-1 flex-col sm:flex-row">
				<TableList
					tables={tables}
					selected={selected}
					onSelect={setSelected}
				/>
				{table === undefined || selected === null ? (
					<p className="m-auto text-sm text-muted-foreground">{t("previewSqliteEmpty")}</p>
				) : (
					<TableView
						key={selected}
						database={database}
						table={table}
						index={selected}
						check={check}
						onCheck={() => {
							setCheckRun(previous => previous + 1)
						}}
					/>
				)}
			</div>
		</div>
	)
}

// A SQLite database, browsed read-only in its own worker: the tables, views and virtual tables on the left, a table's
// rows in the sheet grid (or its SQL) on the right. A drive or link file is read in ranges, any size; an archive entry
// or held bytes whole, up to the cap. The integrity check runs by itself up to 256 MiB, and when asked above that.
export function SqliteViewer({ item }: { item: DriveItem }) {
	const { t } = useTranslation(["preview", "common"])
	const worker = useOwnedWorker<SqliteBrowseWorkerApi>(createSqliteWorker, item.data.uuid, "sqlite-browse")
	const [labels] = useState<SqliteLabels>(() => ({
		null: t("previewSqliteNull"),
		text: t("previewSqliteLargeText"),
		blob: t("previewSqliteBlob")
	}))
	const owned = worker.status === "ready" ? worker.owned : null
	const { state, retry } = useSqliteOpen(item, owned, labels)

	if (worker.status === "failed" || state.status === "failed") {
		const reason = state.status === "failed" ? state.reason : "unreadable"

		return (
			<PreviewUnsupportedState
				item={item}
				message={t(
					reason === "notSqlite"
						? "previewSqliteNotSqlite"
						: reason === "damaged"
							? "previewSqliteDamaged"
							: "previewSqliteUnreadable"
				)}
				secondary={
					reason === "unreadable" ? (
						<Button
							variant="outline"
							onClick={() => {
								if (worker.status === "failed") worker.restart()
								else retry()
							}}
						>
							{t("common:tryAgain")}
						</Button>
					) : undefined
				}
			/>
		)
	}

	if (state.status !== "open" || owned === null) {
		return <PreviewLoading />
	}

	return (
		<DatabaseView
			item={item}
			worker={owned}
			database={state.database}
			options={state.options}
		/>
	)
}
