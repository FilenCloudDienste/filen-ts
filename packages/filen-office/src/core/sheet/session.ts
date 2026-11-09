import type { Slicing } from "../slicing"
import { DEFAULT_COL_WIDTH, DEFAULT_ROW_HEIGHT } from "./model/model"
import {
	SHEET_MAX_COLS,
	SHEET_MAX_ROWS,
	TILE_COLS,
	TILE_ROWS,
	tileKey,
	tileKeyCol,
	tileKeyRow,
	tileKeySheet,
	tilePosition,
	type SheetAbortSignal,
	type SheetAxis,
	type SheetCell,
	type SheetCellDetail,
	type SheetChange,
	type SheetCommand,
	type SheetCommandResult,
	type SheetDocState,
	type SheetEvent,
	type SheetFileKind,
	type SheetFileSharing,
	type SheetId,
	type SheetKind,
	type SheetLayout,
	type SheetLayoutPatch,
	type SheetProtectedAction,
	type SheetQueryName,
	type SheetQueryRequest,
	type SheetQueryResult,
	type SheetRange,
	type SheetRefusal,
	type SheetRegion,
	type SheetRenderStyle,
	type SheetSaveResult,
	type SheetSelectionState,
	type SheetSessionApi,
	type SheetSessionOptions,
	type SheetSessionSettings,
	type SheetDocumentProperties,
	type SheetStyleAppend,
	type SheetSummary,
	type SheetTile,
	type SheetTileLayerMap,
	type SheetTileLayerName,
	type SheetTilePatch,
	type SheetWorkbookInfo,
	type SheetWorkbookProtection,
	type SheetWritability
} from "./protocol"
import {
	defineSheetFeature,
	type SheetChangeSink,
	type SheetCommandInfo,
	type SheetCommandContext,
	type SheetEditStep,
	type SheetFeature,
	type SheetReadContext,
	type SheetReadyResult,
	type SheetRegistry,
	type SheetTileBuilder
} from "./registry"

// A session over one open document, the same on a worker host and an in-thread host: calls run one at a time in
// the order they came, edits go through the feature registry after the session's own checks (view-only, the
// proof, sheet and workbook protection), every change becomes tile patches for the tiles the client holds, and
// edits are kept for undo within a byte budget.

// --- What a session needs of its document ---

export interface SheetEntrySink {
	add(row: number, col: number, text: string, input: string | null, style: number, flags: number): number
	repeat(entry: number, offset: number, char: string): void
	runs(entry: number, starts: readonly number[], styles: readonly number[]): void
}

export interface SheetSessionDocument {
	readonly kind: SheetFileKind
	readonly date1904: boolean
	settings: SheetSessionSettings
	readonly encrypted: "verified" | "unchecked" | undefined
	sheets(): SheetSummary[]
	activeSheet(): SheetId
	isReady(sheet: SheetId): boolean
	ready(sheet: SheetId, slicing?: Slicing, signal?: SheetAbortSignal): Promise<unknown>
	readyAll(first: SheetId, slicing: Slicing | undefined, onReady: (sheet: SheetId) => void, signal?: SheetAbortSignal): Promise<void>
	layout(sheet: SheetId): Omit<SheetLayout, "version" | "extensions">
	fillTile(sheet: SheetId, tileRow: number, tileCol: number, sink: SheetEntrySink): void
	cellDetail(cell: SheetCell): Omit<SheetCellDetail, "details">
	protects(sheet: SheetId, action: SheetProtectedAction): SheetRefusal | null
	workbookProtection(): SheetWorkbookProtection | null
	fileSharing(): SheetFileSharing | null
	// The workbook's own title (its core properties or meta.xml), none for a text file.
	title(): string | undefined
	// Its author, subject and keywords; none: undefined.
	properties?(): SheetDocumentProperties | undefined
	initialWritability(): SheetWritability
	prove(
		slicing: Slicing | undefined,
		signal: SheetAbortSignal | undefined,
		progress: (done: number, total: number) => void
	): Promise<SheetWritability>
	// What edits need is built once the user set out to edit (the formula engine), or results the file lacks are
	// to be shown: whether there is anything to build, and the build, reporting what it shows anew.
	needsPreparing(editing: boolean): boolean
	prepare(changes: SheetChangeSink): void | Promise<void>
	// `untouched`: the document is as it was opened (no edit, or every edit undone).
	save(options: {
		readonly slicing?: Slicing
		readonly signal?: SheetAbortSignal
		readonly untouched?: boolean
	}): Promise<
		Exclude<SheetSaveResult, { ok: true }> | { readonly ok: true; readonly bytes: Uint8Array; readonly changedParts: readonly string[] }
	>
	// The sheet as a CSV; a refusal when it cannot be made whole (too large), null when the sheet has no cells to give.
	csv(sheet: SheetId): Uint8Array | SheetRefusal | null
	// The first rows of a sheet before its parse ends (tiles and its layout show them): whether there are some.
	preview?(sheet: SheetId): Promise<boolean>
	previewCovers?(sheet: SheetId, tileRows: readonly number[]): boolean
	dropPreview?(sheet: SheetId): void
	viewOnly(): void
	close(): void
	// Called before each edit runs: what checkEdit judges is what the edit itself did.
	beginEdit?(command: SheetCommand): void
	// Whether the file's writer can hold what an edit just did (`touched`: the ranges it reported): a refusal undoes
	// the edit at once, before anything is recorded or handed out.
	checkEdit?(touched: ReadonlyMap<SheetId, readonly SheetRange[]>, command: SheetCommand): SheetRefusal | null
	// The edit checkEdit refused was undone: whatever it recorded of its own goes with it.
	editUndone?(): void
}

declare module "./protocol" {
	interface SheetQueryMap {
		// Tiles (tile row and column pairs) as a print draws them, with the looks from `known` on: nothing is held
		// for the client or counted as sent (SheetSession.printTiles).
		"print.tiles": {
			request: { readonly sheet: SheetId; readonly coordinates: Uint32Array; readonly known: number }
			result: { readonly tiles: readonly SheetTile[]; readonly styles: SheetStyleAppend }
		}
	}
}

// --- Render styles ---

function styleKey(style: SheetRenderStyle): string {
	const keys = Object.keys(style).sort()
	let key = ""

	for (const name of keys) key += `${name}:${JSON.stringify((style as Record<string, unknown>)[name])};`

	return key
}

// The session's render styles: each look once, index 0 the default.
export class RenderStyleTable {
	readonly styles: SheetRenderStyle[] = [{}]
	private readonly index = new Map<string, number>([["", 0]])
	// Styles the client has (sent with tiles or changes).
	sent = 1

	intern(style: SheetRenderStyle): number {
		const key = styleKey(style)
		let found = this.index.get(key)

		if (found === undefined) {
			found = this.styles.length
			this.styles.push(style)
			this.index.set(key, found)
		}

		return found
	}

	// The styles the client does not have yet, now counted as sent.
	take(): SheetStyleAppend | undefined {
		if (this.sent === this.styles.length) return undefined

		const append = { from: this.sent, styles: this.styles.slice(this.sent) }

		this.sent = this.styles.length

		return append
	}
}

// --- Tiles ---

// A layer whose `entries` name tile entries, remapped when the entries were reordered.
function remappedLayer<T>(value: T, remap: Uint16Array, ordered: boolean): T {
	if (ordered || typeof value !== "object" || value === null) return value

	const entries = (value as { entries?: unknown }).entries

	return entries instanceof Uint16Array ? { ...value, entries: Uint16Array.from(entries, entry => remap[entry] ?? 0) } : value
}

class TileBuilder implements SheetTileBuilder, SheetEntrySink {
	readonly sheet: SheetId
	readonly firstRow: number
	readonly firstCol: number
	private readonly positions: number[] = []
	private readonly texts: number[] = []
	private readonly inputs: number[] = []
	private readonly styles: number[] = []
	private readonly flagList: number[] = []
	private readonly strings: string[] = []
	private readonly stringIndex = new Map<string, number>()
	private readonly entries = new Map<number, number>()
	private readonly table: RenderStyleTable
	private readonly repeats = { entries: [] as number[], offsets: [] as number[], chars: [] as string[] }
	private readonly ownRuns = { entries: [] as number[], starts: [] as number[], styles: [] as number[] }
	private readonly layers = new Map<SheetTileLayerName, unknown>()
	private ordered = true

	constructor(sheet: SheetId, tileRow: number, tileCol: number, table: RenderStyleTable) {
		this.sheet = sheet
		this.firstRow = tileRow * TILE_ROWS
		this.firstCol = tileCol * TILE_COLS
		this.table = table
	}

	get count(): number {
		return this.positions.length
	}

	private string(text: string | null): number {
		if (text === null || text === "") return -1

		let index = this.stringIndex.get(text)

		if (index === undefined) {
			index = this.strings.length
			this.strings.push(text)
			this.stringIndex.set(text, index)
		}

		return index
	}

	add(row: number, col: number, text: string, input: string | null, style: number, flags: number): number {
		const position = tilePosition(row, col)
		const existing = this.entries.get(position)

		if (existing !== undefined) {
			this.texts[existing] = this.string(text)
			this.inputs[existing] = this.string(input)
			this.styles[existing] = style
			this.flagList[existing] = flags

			return existing
		}

		const entry = this.positions.length

		if (entry > 0 && (this.positions[entry - 1] ?? 0) > position) this.ordered = false

		this.positions.push(position)
		this.texts.push(this.string(text))
		this.inputs.push(this.string(input))
		this.styles.push(style)
		this.flagList.push(flags)
		this.entries.set(position, entry)

		return entry
	}

	runs(entry: number, starts: readonly number[], styles: readonly number[]): void {
		for (let i = 0; i < starts.length; i++) {
			this.ownRuns.entries.push(entry)
			this.ownRuns.starts.push(starts[i] ?? 0)
			this.ownRuns.styles.push(styles[i] ?? 0)
		}
	}

	repeat(entry: number, offset: number, char: string): void {
		this.repeats.entries.push(entry)
		this.repeats.offsets.push(offset)
		this.repeats.chars.push(char)
	}

	find(row: number, col: number): number {
		return this.entries.get(tilePosition(row, col)) ?? -1
	}

	entry(row: number, col: number): number {
		return this.find(row, col) >= 0 ? this.find(row, col) : this.add(row, col, "", null, 0, 0)
	}

	style(entry: number): number {
		return this.styles[entry] ?? 0
	}

	text(entry: number): string | null {
		const index = this.texts[entry] ?? -1

		return index < 0 ? null : (this.strings[index] ?? null)
	}

	flags(entry: number): number {
		return this.flagList[entry] ?? 0
	}

	addFlags(entry: number, flags: number): void {
		this.flagList[entry] = (this.flagList[entry] ?? 0) | flags
	}

	setStyle(entry: number, style: number): void {
		this.styles[entry] = style
	}

	styleOf(index: number): SheetRenderStyle {
		return this.table.styles[index] ?? {}
	}

	setText(entry: number, text: string, input: string | null): void {
		this.texts[entry] = this.string(text)
		this.inputs[entry] = this.string(input === text ? null : input)
	}

	layerOf<L extends SheetTileLayerName>(name: L): SheetTileLayerMap[L] | undefined {
		return this.layers.get(name) as SheetTileLayerMap[L] | undefined
	}

	intern(style: SheetRenderStyle): number {
		return this.table.intern(style)
	}

	layer<L extends SheetTileLayerName>(name: L, value: SheetTileLayerMap[L]): void {
		this.layers.set(name, value)
	}

	finish(version: number): SheetTile {
		const count = this.positions.length
		// Entries in position order; a feature that added one out of order gets the layers' entry indices remapped.
		const order = Array.from({ length: count }, (_, i) => i)

		if (!this.ordered) order.sort((a, b) => (this.positions[a] ?? 0) - (this.positions[b] ?? 0))

		const remap = new Uint16Array(count)

		order.forEach((from, to) => {
			remap[from] = to
		})

		const pick = <T extends Uint16Array | Int32Array | Uint32Array>(array: T, values: number[]): T => {
			for (let i = 0; i < count; i++) array[i] = values[order[i] ?? 0] ?? 0

			return array
		}
		const layers: { -readonly [L in SheetTileLayerName]?: SheetTileLayerMap[L] } = {}

		if (this.repeats.entries.length > 0)
			layers.repeats = {
				entries: Uint16Array.from(this.repeats.entries, entry => remap[entry] ?? 0),
				offsets: Uint32Array.from(this.repeats.offsets),
				chars: this.repeats.chars
			}

		if (this.ownRuns.entries.length > 0)
			layers.runs = {
				runEntries: Uint16Array.from(this.ownRuns.entries, entry => remap[entry] ?? 0),
				runStarts: Uint32Array.from(this.ownRuns.starts),
				runStyles: Uint32Array.from(this.ownRuns.styles)
			}

		for (const [name, value] of this.layers) {
			if (name === "runs" && layers.runs === undefined) {
				const runs = value as SheetTileLayerMap["runs"]

				layers.runs = {
					runEntries: Uint16Array.from(runs.runEntries, entry => remap[entry] ?? 0),
					runStarts: runs.runStarts,
					runStyles: runs.runStyles
				}
			} else if (name !== "runs" && name !== "repeats") {
				// A feature's own layer, its entry indices (an `entries` array) in the entries' final order.
				;(layers as Record<string, unknown>)[name] = remappedLayer(value, remap, this.ordered)
			} else if (name === "repeats" && layers.repeats === undefined) {
				layers.repeats = remappedLayer(value as SheetTileLayerMap["repeats"], remap, this.ordered)
			}
		}

		return {
			sheet: this.sheet,
			tileRow: this.firstRow / TILE_ROWS,
			tileCol: this.firstCol / TILE_COLS,
			version,
			count,
			positions: pick(new Uint16Array(count), this.positions),
			texts: pick(new Int32Array(count), this.texts),
			inputs: pick(new Int32Array(count), this.inputs),
			styles: pick(new Uint32Array(count), this.styles),
			flags: pick(new Uint32Array(count), this.flagList),
			strings: this.strings,
			...(Object.keys(layers).length > 0 && { layers })
		}
	}
}

// --- Changes ---

const MAX_RANGES = 256

// Adds a range to a sheet's list, folding the list into one box over them all past MAX_RANGES (over-reporting costs
// only work).
function addRange(map: Map<SheetId, SheetRange[]>, sheet: SheetId, range: SheetRange): void {
	let list = map.get(sheet)

	if (list === undefined) {
		list = []
		map.set(sheet, list)
	}

	if (list.length < MAX_RANGES) {
		list.push(range)

		return
	}

	const box = list.reduce(
		(a, b) => ({
			startRow: Math.min(a.startRow, b.startRow),
			startCol: Math.min(a.startCol, b.startCol),
			endRow: Math.max(a.endRow, b.endRow),
			endCol: Math.max(a.endCol, b.endCol)
		}),
		range
	)

	list.length = 0
	list.push(box)
}

class ChangeCollector implements SheetChangeSink {
	readonly ranges = new Map<SheetId, SheetRange[]>()
	// The ranges whose content changed (a subset of `ranges`): what features' dependents hooks are asked about.
	readonly contents = new Map<SheetId, SheetRange[]>()
	readonly moves: { sheet: SheetId; axis: SheetAxis; at: number; count: number }[] = []
	readonly layouts = new Set<SheetId>()
	sheetList = false
	selection: ({ readonly sheet: SheetId } & SheetSelectionState) | undefined
	any = false

	content(sheet: SheetId, range: SheetRange): void {
		this.any = true
		addRange(this.ranges, sheet, range)
		addRange(this.contents, sheet, range)
	}

	look(sheet: SheetId, range: SheetRange): void {
		this.any = true
		addRange(this.ranges, sheet, range)
	}

	moved(sheet: SheetId, axis: SheetAxis, at: number, count: number): void {
		this.any = true
		this.moves.push({ sheet, axis, at, count })
	}

	layout(sheet: SheetId): void {
		this.any = true
		this.layouts.add(sheet)
	}

	sheets(): void {
		this.any = true
		this.sheetList = true
	}

	select(sheet: SheetId, selection: SheetSelectionState): void {
		this.selection = { sheet, ...selection }
	}
}

// --- History ---

interface HistoryEntry {
	readonly step: SheetEditStep
	readonly before: number
	readonly after: number
	readonly bytes: number
}

// Excel keeps 100 steps; the byte budget bounds what they retain.
export const SESSION_HISTORY_STEPS = 100
export const SESSION_HISTORY_BYTES = 64 * 1024 * 1024

class StepHistory {
	private readonly undos: HistoryEntry[] = []
	private redos: HistoryEntry[] = []
	private weight = 0
	private readonly budget: number
	// State ids: equal ids, equal content; never reused, so a save point whose step fell out stays unreachable.
	current = 0
	saved = 0
	private next = 1

	constructor(budget: number) {
		this.budget = budget
	}

	get canUndo(): boolean {
		return this.undos.length > 0
	}

	get canRedo(): boolean {
		return this.redos.length > 0
	}

	record(step: SheetEditStep): void {
		const after = this.next++

		this.push({ step, before: this.current, after, bytes: Math.max(64, step.bytes) })
		this.redos = []
		this.current = after
	}

	peekUndo(): HistoryEntry | undefined {
		return this.undos.at(-1)
	}

	undone(): void {
		const entry = this.undos.pop()

		if (entry === undefined) return

		this.weight -= entry.bytes
		this.redos.push(entry)
		this.current = entry.before
	}

	peekRedo(): HistoryEntry | undefined {
		return this.redos.at(-1)
	}

	redone(): void {
		const entry = this.redos.pop()

		if (entry === undefined) return

		this.push(entry)
		this.current = entry.after
	}

	private push(entry: HistoryEntry): void {
		this.undos.push(entry)
		this.weight += entry.bytes

		while (this.undos.length > 1 && (this.undos.length > SESSION_HISTORY_STEPS || this.weight > this.budget)) {
			const dropped = this.undos.shift()

			this.weight -= dropped?.bytes ?? 0
		}
	}
}

// --- Session ---

// How long the session must be idle before results the file lacks are calculated.
const QUIET_MS = 300

function delay(ms: number): Promise<void> {
	const timer: unknown = Reflect.get(globalThis, "setTimeout")

	return new Promise(resolve => {
		if (typeof timer === "function") (timer as (callback: () => void, ms: number) => void)(resolve, ms)
		else resolve()
	})
}

function later(slicing: Slicing | undefined): Promise<void> {
	if (slicing !== undefined) return slicing.pause()

	const timer: unknown = Reflect.get(globalThis, "setTimeout")

	return new Promise(resolve => {
		if (typeof timer === "function") (timer as (callback: () => void, ms: number) => void)(resolve, 0)
		else resolve()
	})
}

// Whether a command runs on a sheet of `kind`. A chartsheet or dialog sheet has no cells, and a macro sheet's are
// not edited here: only sheet operations and commands that declare it (a chartsheet's chart) run on them, so no
// edit lands on cells the save would never write.
function runsOn(info: SheetCommandInfo, kind: SheetKind): boolean {
	return kind === "worksheet" || info.structure === true || info.anySheet === true
}

function intersects(range: SheetRange, startRow: number, startCol: number, endRow: number, endCol: number): boolean {
	return range.startRow <= endRow && range.endRow >= startRow && range.startCol <= endCol && range.endCol >= startCol
}

export interface SheetSessionHooks<D extends SheetSessionDocument> {
	readonly features: (session: SheetSession<D>) => SheetRegistry<D>
	readonly historyBytes?: number
}

export class SheetSession<D extends SheetSessionDocument> implements SheetSessionApi {
	readonly document: D
	private readonly registry: SheetRegistry<D>
	private readonly styles: RenderStyleTable
	private readonly onEvent: (event: SheetEvent) => void
	private readonly slicing: Slicing | undefined
	private readonly history: StepHistory
	private readonly held = new Set<number>()
	// Sheets whose features' ready hooks were started.
	private readonly featureLoads = new Set<SheetId>()
	private chain: Promise<unknown> = Promise.resolve()
	private version = 1
	private writability: SheetWritability
	private proof: Promise<SheetWritability> | null = null
	private declined = false
	private closed = false
	private engine: "none" | "building" | "ready" | "failed" = "none"
	private readonly loading = { aborted: false }
	// Calls queued or running, and when the last one came or ended (quiet()).
	private pending = 0
	private lastCall = 0

	constructor(
		document: D,
		styles: RenderStyleTable,
		hooks: SheetSessionHooks<D>,
		options: SheetSessionOptions,
		onEvent: (event: SheetEvent) => void
	) {
		this.document = document
		this.styles = styles
		this.onEvent = onEvent
		this.slicing = options.slicing
		this.history = new StepHistory(hooks.historyBytes ?? SESSION_HISTORY_BYTES)
		this.writability = document.initialWritability()
		this.registry = hooks.features(this)
	}

	// The open: the active sheet ready, then the rest in idle slices ("sheetReady" each).
	async start(signal?: SheetAbortSignal): Promise<SheetWorkbookInfo> {
		const document = this.document
		const active = document.activeSheet()

		// Alongside the parse: the first tiles never wait for it.
		this.loadFeatures(active)

		// The active sheet's first rows answer the first tiles while the rest is parsed.
		const previewed = !document.isReady(active) && document.preview !== undefined && (await document.preview(active))

		if (!previewed) await document.ready(active, this.slicing, signal)

		const activeLayout = this.fullLayout(active)

		// The looks the first tiles show come with the open: the first paint needs no style it does not have.
		this.buildTile(active, 0, 0)

		if (activeLayout.selection !== undefined) {
			const tileRow = Math.floor(activeLayout.selection.activeRow / TILE_ROWS)
			const tileCol = Math.floor(activeLayout.selection.activeCol / TILE_COLS)

			if ((tileRow !== 0 || tileCol !== 0) && (previewed ? document.previewCovers?.(active, [tileRow]) === true : true))
				this.buildTile(active, tileRow, tileCol)
		}

		const title = document.title()
		const properties = document.properties?.()
		const info: SheetWorkbookInfo = {
			kind: document.kind,
			sheets: document.sheets(),
			activeSheet: active,
			activeLayout,
			styles: this.styles.take() ?? { from: 0, styles: [] },
			writability: this.writability,
			state: this.state(),
			date1904: document.date1904,
			protection: document.workbookProtection(),
			fileSharing: document.fileSharing(),
			...(title !== undefined && { title }),
			...(properties !== undefined && { properties }),
			...(document.encrypted !== undefined && { encrypted: document.encrypted })
		}

		void this.loadRest(active, previewed)

		return info
	}

	private async loadRest(active: SheetId, previewed: boolean): Promise<void> {
		try {
			await later(this.slicing)

			// The active sheet first (whoever parses it: a proof may have), then its preview gives way to it.
			if (previewed) {
				try {
					await this.document.ready(active, this.slicing, this.loading)
				} catch (error) {
					// Damaged past its preview: the open fails as it would have without one, late.
					if (!this.closed) {
						this.onEvent({ type: "failed", message: error instanceof Error ? error.message : String(error) })
						this.close()
					}

					return
				}

				if (!this.closed) void this.enqueue(() => this.previewDone(active)).catch(() => undefined)
			}
			await this.document.readyAll(
				active,
				this.slicing,
				sheet => {
					if (this.closed) return

					// The active sheet's preview gives way to it: tiles shown from it are sent again.
					if (sheet === active) return

					const summary = this.document.sheets().find(entry => entry.id === sheet)

					if (summary !== undefined) this.onEvent({ type: "sheetReady", sheet: summary, layout: this.fullLayout(sheet) })
				},
				this.loading
			)
		} catch {
			// A sheet that cannot be read stays unparsed: asked for, it fails then.
			return
		}

		// Results the file lacks are calculated once the session has been quiet a moment: the first tiles never
		// wait for the engine (an edit's intent builds it at once).
		if (!this.closed && this.document.needsPreparing(false)) {
			await this.quiet()

			if (!this.closed && this.engine === "none") void this.enqueue(() => this.prepare()).catch(() => undefined)
		}
	}

	// Waits until no call has run or waited for QUIET_MS.
	private async quiet(): Promise<void> {
		for (;;) {
			await delay(QUIET_MS)

			if (this.closed || (this.pending === 0 && Date.now() - this.lastCall >= QUIET_MS)) return
		}
	}

	private previewDone(sheet: SheetId): void {
		this.document.dropPreview?.(sheet)

		const summary = this.document.sheets().find(entry => entry.id === sheet)

		if (summary !== undefined) this.onEvent({ type: "sheetReady", sheet: summary, layout: this.fullLayout(sheet) })

		const collector = new ChangeCollector()

		collector.content(sheet, { startRow: 0, startCol: 0, endRow: SHEET_MAX_ROWS - 1, endCol: SHEET_MAX_COLS - 1 })
		collector.layout(sheet)
		this.onEvent({ type: "change", change: this.change(collector) })
	}

	// --- Order ---

	private enqueue<T>(work: () => Promise<T> | T): Promise<T> {
		this.pending++
		this.lastCall = Date.now()

		const run = this.chain.then(() => {
			if (this.closed) throw new Error("The session is closed")

			return work()
		})

		this.chain = run.then(
			() => this.settled(),
			() => this.settled()
		)

		return run
	}

	// Starts what a sheet's features read beside it (SheetFeature.ready), once. Tiles and layouts never wait for it:
	// what lands patches those already sent, and a feature that cannot load is reported. A sheet an edit took away
	// has nothing to load: its features load when an undo or redo brings it back and it is asked for again.
	private loadFeatures(sheet: SheetId): void {
		if (this.featureLoads.has(sheet) || this.registry.ready.length === 0 || this.gone(sheet)) return

		this.featureLoads.add(sheet)

		const context = this.readContext(this.loading)

		for (const [feature, ready] of this.registry.ready) {
			;(async () => ready(context, sheet))().then(
				result => {
					if (!this.closed && (result.ranges.length > 0 || result.layout === true))
						void this.enqueue(() => this.featureLanded(sheet, result)).catch(() => undefined)
				},
				(error: unknown) => {
					if (this.gone(sheet)) this.featureLoads.delete(sheet)
					else if (!this.closed)
						this.onEvent({
							type: "featureUnavailable",
							sheet,
							feature,
							message: error instanceof Error ? error.message : String(error)
						})
				}
			)
		}
	}

	private featureLanded(sheet: SheetId, result: SheetReadyResult): void {
		if (!this.document.sheets().some(summary => summary.id === sheet)) return

		const collector = new ChangeCollector()

		for (const range of result.ranges) collector.look(sheet, range)

		if (result.layout === true) collector.layout(sheet)

		this.onEvent({ type: "change", change: this.change(collector) })
	}

	private settled(): void {
		this.pending--
		this.lastCall = Date.now()
	}

	// --- State ---

	private state(): SheetDocState {
		return {
			version: this.version,
			dirty: this.history.current !== this.history.saved,
			canUndo: this.history.canUndo,
			canRedo: this.history.canRedo
		}
	}

	private fullLayout(sheet: SheetId): SheetLayout {
		const layout = { ...this.document.layout(sheet), version: this.version }
		const extensions: Record<string, unknown> = {}
		const context = this.readContext(undefined)

		for (const [name, produce] of this.registry.layout) {
			const value = produce(context, sheet)

			if (value !== undefined) extensions[name] = value
		}

		return Object.keys(extensions).length > 0 ? { ...layout, extensions } : layout
	}

	private readContext(signal: SheetAbortSignal | undefined): SheetReadContext<D> {
		return {
			doc: this.document,
			settings: this.document.settings,
			slicing: this.slicing,
			signal,
			version: this.version,
			later: this.later
		}
	}

	// A feature's work after a call (SheetReadContext.later): what it lands patches the sheet's tiles, as a ready
	// hook's result does. Work that fails leaves the tiles as they are.
	private readonly later = (sheet: SheetId, work: () => Promise<SheetReadyResult>): void => {
		if (this.closed) return

		work().then(
			result => {
				if (!this.closed && (result.ranges.length > 0 || result.layout === true))
					void this.enqueue(() => this.featureLanded(sheet, result)).catch(() => undefined)
			},
			() => undefined
		)
	}

	// Tiles as a print or an export draws them: built now, never held as the client's (no change patches them, no
	// release is owed) and no look counted as sent, so the client's own tiles and styles are untouched. With the
	// looks from `known` on (every look the tiles name is below the table's length). Runs in the session's queue.
	printTiles(
		sheet: SheetId,
		coordinates: Uint32Array,
		known: number
	): { readonly tiles: readonly SheetTile[]; readonly styles: SheetStyleAppend } {
		const tiles: SheetTile[] = []

		if (!this.gone(sheet)) {
			for (let i = 0; i + 1 < coordinates.length; i += 2) {
				const tileRow = coordinates[i] ?? 0
				const tileCol = coordinates[i + 1] ?? 0

				if (tileRow >= SHEET_MAX_ROWS / TILE_ROWS || tileCol >= SHEET_MAX_COLS / TILE_COLS) continue

				tiles.push(this.buildTile(sheet, tileRow, tileCol))
			}
		}

		const from = Math.min(Math.max(0, Math.floor(known)), this.styles.styles.length)

		return { tiles, styles: { from, styles: this.styles.styles.slice(from) } }
	}

	private buildTile(sheet: SheetId, tileRow: number, tileCol: number): SheetTile {
		const builder = new TileBuilder(sheet, tileRow, tileCol, this.styles)

		this.document.fillTile(sheet, tileRow, tileCol, builder)

		const context = this.readContext(undefined)

		for (const produce of this.registry.tiles) produce(context, builder)

		return builder.finish(this.version)
	}

	// The cells whose look follows the changed cells (SheetFeature.dependents) join the change. Cells moved by a
	// structure edit count as changed from where the edit is to the sheet's end.
	private dependents(collector: ChangeCollector): void {
		if (this.registry.dependents.length === 0 || (collector.contents.size === 0 && collector.moves.length === 0)) return

		const context = this.readContext(undefined)
		const changed: [SheetId, SheetRange][] = []

		for (const [sheet, ranges] of collector.contents) for (const range of ranges) changed.push([sheet, range])

		for (const move of collector.moves)
			changed.push([
				move.sheet,
				move.axis === "rows"
					? { startRow: move.at, startCol: 0, endRow: SHEET_MAX_ROWS - 1, endCol: SHEET_MAX_COLS - 1 }
					: { startRow: 0, startCol: move.at, endRow: SHEET_MAX_ROWS - 1, endCol: SHEET_MAX_COLS - 1 }
			])

		const add = (sheet: SheetId, range: SheetRange): void => collector.look(sheet, range)

		for (const [sheet, range] of changed) for (const [, dependents] of this.registry.dependents) dependents(context, sheet, range, add)
	}

	// What a collector holds, as the change the client applies: held tiles in changed ranges rebuilt, moved regions
	// invalidated (and no longer held), layouts and the sheet list as they now are.
	private change(collector: ChangeCollector): SheetChange {
		if (collector.any) this.version++

		this.dependents(collector)

		if (this.registry.observe.length > 0 && (collector.ranges.size > 0 || collector.layouts.size > 0)) {
			const context = this.readContext(undefined)

			for (const observe of this.registry.observe) observe(context, { ranges: collector.ranges, layouts: collector.layouts })
		}

		const invalidated: SheetRegion[] = []

		for (const move of collector.moves) {
			const region: SheetRegion =
				move.axis === "rows"
					? { sheet: move.sheet, startRow: move.at, startCol: 0, endRow: SHEET_MAX_ROWS - 1, endCol: SHEET_MAX_COLS - 1 }
					: { sheet: move.sheet, startRow: 0, startCol: move.at, endRow: SHEET_MAX_ROWS - 1, endCol: SHEET_MAX_COLS - 1 }

			invalidated.push(region)

			for (const key of [...this.held]) {
				if (tileKeySheet(key) !== move.sheet) continue

				const first = move.axis === "rows" ? (tileKeyRow(key) + 1) * TILE_ROWS - 1 : (tileKeyCol(key) + 1) * TILE_COLS - 1

				if (first >= move.at) this.held.delete(key)
			}
		}

		const patches: SheetTilePatch[] = []

		for (const key of this.held) {
			const sheet = tileKeySheet(key)
			const ranges = collector.ranges.get(sheet)

			if (ranges === undefined) continue

			const tileRow = tileKeyRow(key)
			const tileCol = tileKeyCol(key)
			const startRow = tileRow * TILE_ROWS
			const startCol = tileCol * TILE_COLS

			if (!ranges.some(range => intersects(range, startRow, startCol, startRow + TILE_ROWS - 1, startCol + TILE_COLS - 1))) continue

			patches.push({ ...this.buildTile(sheet, tileRow, tileCol), mode: "replace" })
		}

		const layouts: SheetLayoutPatch[] = []

		for (const sheet of collector.layouts) {
			if (!this.document.isReady(sheet)) continue

			const { sheet: _sheet, ...layout } = this.fullLayout(sheet)

			// The extensions go whole, empty too: one a feature no longer produces (its last object deleted) then leaves the
			// client, which keeps any field a patch leaves out.
			layouts.push({ sheet, layout: { ...layout, extensions: layout.extensions ?? {} } })
		}

		const styles = this.styles.take()

		return {
			state: this.state(),
			patches,
			invalidated,
			layouts,
			...(collector.sheetList && { sheets: this.document.sheets() }),
			...(styles !== undefined && { styles }),
			...(collector.selection !== undefined && { selection: collector.selection })
		}
	}

	// --- Writability ---

	private setWritability(writability: SheetWritability): void {
		this.writability = writability
		this.onEvent({ type: "writability", writability })
	}

	// The verdict, proving the file first (once).
	private verdict(): Promise<SheetWritability> {
		if (this.writability.state === "writable" || this.writability.state === "viewOnly") return Promise.resolve(this.writability)

		this.proof ??= (async () => {
			this.setWritability({ state: "checking" })

			const verdict = await this.document.prove(this.slicing, this.loading, (done, total) =>
				this.onEvent({ type: "progress", task: "proof", done, total })
			)

			this.setWritability(verdict)

			return verdict
		})()

		return this.proof
	}

	private async prepare(): Promise<void> {
		if (!this.document.needsPreparing(this.writability.state === "writable")) return

		const editing = this.writability.state === "writable"

		if (editing) {
			this.engine = "building"
			this.onEvent({ type: "engine", state: "building" })
		}

		const collector = new ChangeCollector()

		try {
			await this.document.prepare(collector)
		} catch (error) {
			if (editing) {
				this.engine = "failed"
				this.onEvent({ type: "engine", state: "failed" })
			}

			throw error
		}

		if (editing) {
			this.engine = "ready"
			this.onEvent({ type: "engine", state: "ready" })
		}

		if (collector.any) this.onEvent({ type: "change", change: this.change(collector) })
	}

	// --- SheetSessionApi ---

	tiles(sheet: SheetId, coordinates: Uint32Array): Promise<{ readonly tiles: readonly SheetTile[]; readonly styles?: SheetStyleAppend }> {
		this.loadFeatures(sheet)

		return this.enqueue(async () => {
			// A sheet an edit took away while the request was on its way has no tiles.
			if (this.gone(sheet)) return { tiles: [] }

			this.loadFeatures(sheet)

			const tileRows: number[] = []

			for (let i = 0; i + 1 < coordinates.length; i += 2) tileRows.push(coordinates[i] ?? 0)

			// Tiles a preview holds answer at once; the sheet's parse sends them again (previewDone).
			if (!this.document.isReady(sheet) && this.document.previewCovers?.(sheet, tileRows) !== true)
				await this.document.ready(sheet, this.slicing)

			const tiles: SheetTile[] = []

			for (let i = 0; i + 1 < coordinates.length; i += 2) {
				const tileRow = coordinates[i] ?? 0
				const tileCol = coordinates[i + 1] ?? 0

				if (tileRow >= SHEET_MAX_ROWS / TILE_ROWS || tileCol >= SHEET_MAX_COLS / TILE_COLS) continue

				tiles.push(this.buildTile(sheet, tileRow, tileCol))
				this.held.add(tileKey(sheet, tileRow, tileCol))
			}

			const styles = this.styles.take()

			return styles === undefined ? { tiles } : { tiles, styles }
		})
	}

	release(keys: Float64Array): void {
		for (const key of keys) this.held.delete(key)
	}

	layout(sheet: SheetId): Promise<SheetLayout> {
		this.loadFeatures(sheet)

		return this.enqueue(async () => {
			// A sheet an edit took away while the request was on its way: an empty sheet's layout.
			if (this.gone(sheet)) return goneLayout(sheet, this.version)

			this.loadFeatures(sheet)

			await this.document.ready(sheet, this.slicing)

			return this.fullLayout(sheet)
		})
	}

	private gone(sheet: SheetId): boolean {
		return !this.document.sheets().some(summary => summary.id === sheet)
	}

	command(command: SheetCommand): Promise<SheetCommandResult> {
		return this.enqueue(() => this.run(command))
	}

	private refused(refusal: SheetRefusal): SheetCommandResult {
		return { ok: false, refusal, state: this.state() }
	}

	// Why a command cannot run now, by the checks every command shares.
	private async gate(command: SheetCommand): Promise<SheetRefusal | null> {
		const handler = this.registry.command(command.type)

		if (handler === undefined) return { reason: "unsupported", detail: command.type }

		const info = handler.info

		if (info.write) {
			if (this.declined) return { reason: "readOnly" }

			const verdict = await this.verdict()

			if (verdict.state !== "writable") return { reason: "readOnly", ...(verdict.state === "viewOnly" && { detail: verdict.reason }) }
		}

		if (info.structure === true && this.document.workbookProtection()?.structure === true) return { reason: "protectedWorkbook" }

		const sheet = (command as { readonly sheet?: unknown }).sheet

		if (typeof sheet === "number") {
			const kind = this.document.sheets().find(summary => summary.id === sheet)?.kind

			// A sheet an undo took away while the command was on its way, or one without cells to change.
			if (kind === undefined || !runsOn(info, kind)) return { reason: "unsupported", detail: "sheet" }
		}

		if (info.protection !== undefined && typeof sheet === "number") return this.document.protects(sheet, info.protection)

		return null
	}

	private async run(command: SheetCommand): Promise<SheetCommandResult> {
		const refusal = await this.gate(command)

		if (refusal !== null) return this.refused(refusal)

		const handler = this.registry.command(command.type) as unknown as {
			run(
				context: SheetCommandContext<D>,
				command: SheetCommand
			): ReturnType<NonNullable<ReturnType<SheetRegistry<D>["command"]>>["run"]>
		}
		const collector = new ChangeCollector()

		this.document.beginEdit?.(command)

		const handled = await handler.run({ ...this.readContext(undefined), changes: collector }, command)

		if (handled !== null && "refused" in handled) {
			// A refused edit may have read (a sheet parsed) but changed nothing the client holds.
			return this.refused(handled.refused)
		}

		if (handled !== null) {
			const unwritable = this.document.checkEdit?.(collector.ranges, command) ?? null

			if (unwritable !== null) {
				await handled.undo(new ChangeCollector())
				this.document.editUndone?.()

				return this.refused(unwritable)
			}

			this.history.record(handled)
		}

		return { ok: true, change: this.change(collector) }
	}

	undo(): Promise<SheetCommandResult> {
		return this.enqueue(async () => {
			const entry = this.history.peekUndo()

			if (entry === undefined) return { ok: true, change: this.change(new ChangeCollector()) }

			const collector = new ChangeCollector()

			await entry.step.undo(collector)
			this.history.undone()

			return { ok: true, change: this.change(collector) }
		})
	}

	redo(): Promise<SheetCommandResult> {
		return this.enqueue(async () => {
			const entry = this.history.peekRedo()

			if (entry === undefined) return { ok: true, change: this.change(new ChangeCollector()) }

			const collector = new ChangeCollector()

			await entry.step.redo(collector)
			this.history.redone()

			return { ok: true, change: this.change(collector) }
		})
	}

	query<Q extends SheetQueryName>(
		name: Q,
		request: SheetQueryRequest<Q>,
		options?: { readonly signal?: SheetAbortSignal }
	): Promise<SheetQueryResult<Q>> {
		return this.enqueue(async () => {
			const handler = this.registry.query(name)

			if (handler === undefined) throw new Error(`Unsupported query ${name}`)

			return await handler.run(this.readContext(options?.signal), request)
		})
	}

	// Whether commands could run on a selection (the commandState query).
	commandState(request: SheetQueryRequest<"commandState">): SheetQueryResult<"commandState"> {
		const enabled: boolean[] = []
		const reasons: (SheetRefusal["reason"] | null)[] = []
		const context = this.readContext(undefined)
		const kind = this.document.sheets().find(summary => summary.id === request.sheet)?.kind

		for (const type of request.types) {
			const handler = this.registry.command(type)
			let reason: SheetRefusal["reason"] | null = null

			if (handler === undefined || (kind !== undefined && !runsOn(handler.info, kind))) reason = "unsupported"
			else if (handler.info.write && (this.declined || this.writability.state === "viewOnly")) reason = "readOnly"
			else if (handler.info.structure === true && this.document.workbookProtection()?.structure === true) reason = "protectedWorkbook"
			else if (handler.info.protection !== undefined && this.document.protects(request.sheet, handler.info.protection) !== null)
				reason = "protectedSheet"
			else reason = handler.check?.(context, { sheet: request.sheet, ranges: request.ranges })?.reason ?? null

			enabled.push(reason === null)
			reasons.push(reason)
		}

		return { enabled, reasons }
	}

	intent(): Promise<SheetWritability> {
		return this.enqueue(async () => {
			if (this.declined) return this.writability

			const verdict = await this.verdict()

			// Built while the first entry is typed: after this answer goes.
			if (verdict.state === "writable" && this.engine === "none" && this.document.needsPreparing(true))
				void later(this.slicing).then(() => this.enqueue(() => this.prepare()).catch(() => undefined))

			return verdict
		})
	}

	viewOnly(): void {
		if (this.declined) return

		this.declined = true
		this.document.viewOnly()
	}

	configure(settings: SheetSessionSettings): void {
		this.document.settings = { ...this.document.settings, ...settings }
	}

	save(options?: { readonly signal?: SheetAbortSignal }): Promise<SheetSaveResult> {
		return this.enqueue(async (): Promise<SheetSaveResult> => {
			const version = this.history.current

			const restores: (() => void)[] = []

			const saved = await (async () => {
				try {
					if (version !== 0)
						for (const save of this.registry.save) {
							const restore = await save(this.readContext(options?.signal))

							if (restore !== undefined) restores.push(restore)
						}

					return await this.document.save({
						untouched: version === 0,
						...(this.slicing !== undefined && { slicing: this.slicing }),
						...(options?.signal !== undefined && { signal: options.signal })
					})
				} finally {
					for (const restore of restores.reverse()) restore()
				}
			})()

			if (!saved.ok) return saved

			return {
				ok: true,
				bytes: saved.bytes,
				version,
				encrypted: this.document.encrypted !== undefined,
				changedParts: saved.changedParts
			}
		}).catch(
			(error: unknown) => ({ ok: false, reason: "closed", message: error instanceof Error ? error.message : String(error) }) as const
		)
	}

	export(
		format: "xlsx" | "csv",
		options?: { readonly sheet?: SheetId }
	): Promise<{ readonly ok: true; readonly bytes: Uint8Array } | { readonly ok: false; readonly refusal: SheetRefusal }> {
		return this.enqueue(async () => {
			// A protected workbook's cells never leave it unsealed.
			if (format !== "csv" || this.document.encrypted !== undefined) return { ok: false, refusal: { reason: "unsupported" } } as const

			const sheet = options?.sheet ?? this.document.activeSheet()

			// A sheet that cannot be read (its part missing or damaged) gives no CSV: refused, never an error left open.
			try {
				await this.document.ready(sheet, this.slicing)
			} catch {
				return { ok: false, refusal: { reason: "unsupported", detail: "unreadable" } } as const
			}

			const bytes = this.document.csv(sheet)

			if (bytes === null) return { ok: false, refusal: { reason: "unsupported" } } as const

			return bytes instanceof Uint8Array ? ({ ok: true, bytes } as const) : ({ ok: false, refusal: bytes } as const)
		})
	}

	markSaved(version: number): Promise<SheetDocState> {
		return this.enqueue(() => {
			this.history.saved = version

			return this.state()
		})
	}

	close(): void {
		if (this.closed) return

		this.closed = true
		this.loading.aborted = true
		this.held.clear()
		this.document.close()
	}
}

// The layout of a sheet that is no longer there: empty, at the default sizes.
function goneLayout(sheet: SheetId, version: number): SheetLayout {
	const axis = (defaultSize: number) => ({
		defaultSize,
		indices: new Uint32Array(0),
		sizes: new Float32Array(0),
		styles: new Uint32Array(0),
		flags: new Uint16Array(0)
	})

	return {
		sheet,
		version,
		rowCount: 0,
		colCount: 0,
		rows: axis(DEFAULT_ROW_HEIGHT),
		cols: axis(DEFAULT_COL_WIDTH),
		merges: new Uint32Array(0),
		pane: null,
		zoom: 100,
		gridLines: true,
		headings: true,
		rightToLeft: false,
		protection: null
	}
}

// The commandState query, answered by the session itself.
export function sessionFeature<D extends SheetSessionDocument>(session: SheetSession<D>): SheetFeature<D> {
	return defineSheetFeature<D>({
		id: "session",
		queries: {
			commandState: { run: (_context, request) => session.commandState(request) },
			"print.tiles": {
				run: async (context, request) => {
					if (context.doc.sheets().some(summary => summary.id === request.sheet) && !context.doc.isReady(request.sheet))
						await context.doc.ready(request.sheet, context.slicing, context.signal)

					return session.printTiles(request.sheet, request.coordinates, request.known)
				}
			},
			// A cell of a sheet still being parsed (a preview shows its first rows only) is read once it is.
			cell: {
				run: async (context, request) => {
					// A sheet an edit took away while the request was on its way holds nothing.
					if (!context.doc.sheets().some(summary => summary.id === request.sheet))
						return { input: "", numFmt: "General", style: 0, flags: 0 }
					if (!context.doc.isReady(request.sheet)) await context.doc.ready(request.sheet, context.slicing, context.signal)

					return context.doc.cellDetail(request)
				}
			}
		}
	})
}
