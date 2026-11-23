import {
	DESKTOP_ONLY_ERROR,
	DRIVE_NAME_RULES,
	estimateCaptureTimestamp,
	formatBytes,
	mountsStatus,
	storageSummary,
	syncStatus
} from "@filen/shared"
import {
	APP_HELP,
	APP_HELP_NO_MATCH_NOTE,
	appHelpWords,
	ASSISTANT_OFFICE_DOCUMENT_EXTENSIONS,
	assistantToolByName,
	batchOrganizeCount,
	composerBusyMessage,
	CONTACT_NEEDS_WORDS,
	CONTACT_WITHOUT_CHAT_NOTE,
	contextName,
	datedElsewhereNote,
	dateFilterNote,
	dayRangeBounds,
	describeDayRange,
	DIRECTORIES_BY_SIZE_NOTE,
	DIRECTORY_SIZE_READS,
	DOCUMENT_READ_MAX_CHARS,
	DOCUMENT_SELECTION_LABEL,
	documentRangeText,
	documentReadRange,
	DRAFTED_NOTE,
	engineTokens,
	inDayRange,
	joinNotes,
	listingPage,
	listRest,
	MAX_ARRAY_ITEMS,
	NO_CONTACT_NOTE,
	NO_TRANSFERS_NOTE,
	normalizeText,
	nothingSelected,
	matchScore,
	NOTE_TEXT_IN_TITLES,
	NOTE_TEXT_NEEDS_WORDS,
	NOTE_TEXT_NO_MATCH_NOTE,
	noteTextCoverage,
	NOTES_ITEMS,
	OUTSIDE_DATES_ITEMS,
	openDocumentContext,
	OWN_SHARING_UNCHECKED,
	PARTIAL_MATCH_NOTE,
	parseToolInput,
	PHOTOS_ITEMS,
	planBatchRename,
	planOrganizeByDate,
	rankAppHelp,
	rawSearchTokens,
	readWithDocument,
	readWithTextFile,
	RECENT_ITEMS,
	recentsReachNote,
	resolveDateFilter,
	ROOT_NOT_SHAREABLE,
	sameName,
	screenOpened,
	SEARCH_ENGINE_WORDS,
	SEARCH_NEEDS_WORDS,
	SEARCH_RESULT_ITEMS,
	searchTokens,
	SHARED_WITH_YOU_NOTE,
	tokenMatches,
	trashSectionNote,
	unknownSizesNote,
	type AssistantPeriodFilter,
	type BatchDateField,
	type BatchItem,
	type BatchOrganizeBy,
	type BatchRenameScheme
} from "@filen/shared/assistant"
import {
	createFixtureState,
	HELP_ROWS,
	HELP_SECTION_LABELS,
	SHORTCUT_ROWS,
	type AppContext,
	type AppState,
	type DriveItem,
	type FixtureDocument,
	type Note,
	type NoteType
} from "./fixture"
import { EVAL_NOW, EVAL_TIME_ZONE, evalLocalDay } from "./prompts"

export type Candidate = {
	handle: string
	name: string
}

export type ToolOutcome =
	| {
			ok: true
			result: unknown
			// Every handle the result shows, with its name, where the result names one under another key than
			// "handle" (as the app reports them to the loop).
			returned?: Candidate[]
	  }
	| {
			ok: false
			// A malformed call (schema, unknown or wrong-kind handle) as opposed to a valid call the app refused.
			invalid: boolean
			error: string
			// Items whose names match a name the model passed where a handle belongs.
			candidates?: Candidate[]
	  }

class CallError extends Error {
	readonly invalid: boolean
	readonly candidates: Candidate[] | undefined

	constructor(message: string, invalid: boolean, candidates?: Candidate[]) {
		super(message)
		this.invalid = invalid
		this.candidates = candidates
	}
}

type EntityKind = "drive" | "note" | "chat" | "playlist"

const LOOKUP_TOOL: Record<EntityKind, string> = {
	drive: "search_items or list_directory",
	note: "list_notes",
	chat: "list_chats",
	playlist: "list_playlists"
}

const EXTENSIONS: Record<string, readonly string[]> = {
	image: ["jpg", "jpeg", "png", "heic", "gif", "webp", "svg"],
	video: ["mp4", "mov", "mkv", "webm"],
	audio: ["mp3", "flac", "m4a", "wav", "ogg"],
	// What the app previews as a document (PDF, Word, spreadsheets, text, markdown), plus the shared list of
	// office files it has no viewer for.
	document: ["pdf", "docx", "txt", "md", "xlsx", "csv", ...ASSISTANT_OFFICE_DOCUMENT_EXTENSIONS]
}

// Messages and mailboxes read as their parsed text extract, as the app's read_text_file returns it.
const TEXT_EXTENSIONS = ["txt", "md", "csv", "json", "eml", "msg", "mbox"]

// Files the app has no reader for (closedDocuments.ts): Keynote, Pages, Numbers, e-books, legacy decks.
const UNREADABLE_DOCUMENT_EXTENSIONS: ReadonlySet<string> = new Set(["key", "pages", "numbers", "epub", "ppt", "pps", "doc", "rtf"])

// Screens where the web app's context names a current directory and a selection.
const DRIVE_SCREENS: ReadonlySet<string> = new Set(["drive"])

// Like the web app's trash screen: a selection there is named, with no current directory.
const SELECTION_SCREENS: ReadonlySet<string> = new Set(["trash"])

// Like the app's Recents screen, which ages files out by upload time.
const RECENT_DAYS = 45

// The graders fold names as the app does.
export { normalizeText }

const EVAL_CALENDAR = {
	now: EVAL_NOW,
	timeZone: EVAL_TIME_ZONE
}

// The date filter of a call, as the app resolves it: which date it looks at, and the days it leaves.
type DateSelection = {
	field: string
	bounds: {
		start: number
		end: number
	} | null
	range: string | null
}

type ListingSort = "name" | "largest" | "smallest" | "newest" | "oldest"

// The directory the Photos screen shows.
const PHOTOS_ROOT = "d4"

function extension(name: string): string {
	const dot = name.lastIndexOf(".")

	return dot === -1 ? "" : name.slice(dot + 1).toLowerCase()
}

// Sections the app has no screen for: no camera upload anywhere, no sync, mounts or desktop settings on the web, and
// no plans in the desktop app (as the web app's routes.ts UNAVAILABLE_ROUTES).
const UNAVAILABLE_ROUTES = {
	web: ["settings_camera_upload", "sync", "mounts", "settings_desktop"],
	desktop: ["settings_camera_upload", "settings_plans"]
} as const

function routeUnavailable(route: string): CallError {
	return new CallError(`"${route}" is not available in this app`, false)
}

export class FakeApp {
	readonly state: AppState
	readonly exposed = new Set<string>()
	// The desktop app (sync, mounts and its own settings) rather than the web app.
	readonly desktop: boolean
	private returned: Candidate[] | null = null
	// app_help results by registry id and sync pairs by id, numbered as the app hands them out.
	private readonly helpHandles = new Map<string, string>()
	private readonly pairHandles = new Map<string, string>()

	constructor(context: Partial<AppContext> = {}, { desktop = false }: { desktop?: boolean } = {}) {
		this.state = createFixtureState(context)
		this.desktop = desktop

		for (const handle of this.contextHandles()) {
			this.exposed.add(handle)
		}
	}

	// The name an app_help or sync pair handle was shown with.
	shownName(handle: string): string | undefined {
		const help = [...this.helpHandles].find(([, shown]) => shown === handle)?.[0]
		const pair = [...this.pairHandles].find(([, shown]) => shown === handle)?.[0]

		return HELP_ROWS.find(row => row.id === help)?.title ?? this.state.desktop.sync.pairs.find(row => row.id === pair)?.name
	}

	private pairHandle(id: string): string {
		const handle = this.pairHandles.get(id) ?? `s${String(this.pairHandles.size + 1)}`

		this.pairHandles.set(id, handle)
		this.exposed.add(handle)

		return handle
	}

	// One line for the system prompt, so "this file" or "here" resolve without a get_context round trip. As the
	// web app writes it (features/assistant/tools/executor.ts describeContext): a current directory and a
	// selection only on a drive screen, names quoted and shortened, the open note or chat.
	describeContext(): string {
		const { screen, directory, selection, note, chat, playing } = this.state.context
		const parts = [`screen: ${screen}`]
		const onDrive = DRIVE_SCREENS.has(screen)

		if (onDrive) {
			parts.push(
				directory === "d0"
					? "current directory: / (handle d0)"
					: `current directory: ${contextName(this.pathOf(this.drive(directory)))} (handle ${directory})`
			)
			parts.push(
				selection.length === 0
					? "nothing selected"
					: `selected: ${selection.map(handle => `${contextName(this.drive(handle).name)} (handle ${handle})`).join(", ")}`
			)
		} else if (SELECTION_SCREENS.has(screen) && selection.length > 0) {
			parts.push(`selected: ${selection.map(handle => `${contextName(this.drive(handle).name)} (handle ${handle})`).join(", ")}`)
		}

		if (note !== undefined) {
			parts.push(`open note: ${contextName(this.noteItem(note).title)} (handle ${note})`)
		}

		if (chat !== undefined) {
			parts.push(`open chat: ${contextName(this.chat(chat).name)} (handle ${chat})`)
		}

		const open = this.state.context.openDocument

		if (open !== undefined) {
			const item = this.drive(open.handle)
			const document = this.documentOf(item)
			const kind = document?.kind ?? "text"
			const units = document?.units.length

			parts.push(
				openDocumentContext({
					name: item.name,
					handle: open.handle,
					kind,
					position:
						kind === "sheet"
							? { sheet: open.sheet ?? document?.units[0]?.label, sheets: document?.units.map(unit => unit.label) }
							: kind === "slides"
								? { slide: open.slide ?? 1, slides: units }
								: kind === "text"
									? {}
									: { page: open.page ?? 1, pages: units },
					selectionChars: open.selection === undefined ? null : Array.from(open.selection).length
				})
			)
		}

		parts.push(
			playing === null
				? "nothing playing"
				: `${playing.paused ? "paused" : "playing"}: ${contextName(this.drive(playing.handle).name)} (handle ${playing.handle})`
		)

		return parts.join("; ")
	}

	// The handles the context line names, which ground a call as the user's own (the web executor's context()).
	contextHandles(): string[] {
		const { screen, directory, selection, note, chat, openDocument, playing } = this.state.context
		const onDrive = DRIVE_SCREENS.has(screen)

		return [
			...new Set([
				"d0",
				...(onDrive ? [directory, ...selection] : SELECTION_SCREENS.has(screen) ? selection : []),
				...(note === undefined ? [] : [note]),
				...(chat === undefined ? [] : [chat]),
				...(openDocument === undefined ? [] : [openDocument.handle]),
				...(playing === null ? [] : [playing.handle])
			])
		]
	}

	execute({ name, args }: { name: string; args: unknown }): ToolOutcome {
		const tool = assistantToolByName(name)

		if (tool === undefined) {
			return {
				ok: false,
				invalid: true,
				error: `Unknown tool "${name}"`
			}
		}

		const parsed = parseToolInput(tool, args ?? {})

		if (!parsed.ok) {
			return {
				ok: false,
				invalid: true,
				error: parsed.error
			}
		}

		try {
			const result = this.run({
				name,
				input: parsed.args
			})
			const returned = this.takeReturned()

			return {
				ok: true,
				result,
				...(returned === null
					? {}
					: {
							returned
						})
			}
		} catch (e) {
			if (e instanceof CallError) {
				return {
					ok: false,
					invalid: e.invalid,
					error: e.message,
					...(e.candidates === undefined || e.candidates.length === 0
						? {}
						: {
								candidates: e.candidates
							})
				}
			}

			throw e
		}
	}

	private directoryAt(path: string): DriveItem {
		const wanted = normalizeText(path.trim().replace(/\/+$/, "") || "/")
		const found = this.state.drive.find(
			item => item.kind === "directory" && !item.trashed && this.inMyDrive(item) && normalizeText(this.pathOf(item)) === wanted
		)

		if (found === undefined) {
			throw new CallError(`No directory at "${path}"`, false)
		}

		return found
	}

	private isDirectoryPath(path: string): boolean {
		try {
			this.directoryAt(path)

			return true
		} catch (e) {
			if (e instanceof CallError) {
				return false
			}

			throw e
		}
	}

	// Like the app: a path wins, being unambiguous, but one that names nothing (a model's guess beside a valid
	// handle, e.g. a shared directory's name as a path) leaves the handle to decide.
	private directoryAtOr(path: string, handle: string | undefined): DriveItem {
		try {
			return this.directoryAt(path)
		} catch (e) {
			if (handle === undefined || !(e instanceof CallError)) {
				throw e
			}

			return this.directory(handle)
		}
	}

	// Paths are unambiguous, so a path where a handle belongs is resolved instead of rejected.
	resolvePaths(args: Record<string, unknown>): Record<string, unknown> {
		const resolve = (value: unknown): unknown => {
			if (typeof value !== "string" || !value.startsWith("/")) {
				return value
			}

			const wanted = normalizeText(value.trim().replace(/\/+$/, "") || "/")
			const found = this.state.drive.find(
				item => !item.trashed && this.inMyDrive(item) && normalizeText(this.pathOf(item)) === wanted
			)

			if (found === undefined) {
				return value
			}

			this.exposed.add(found.handle)

			return found.handle
		}

		return Object.fromEntries(
			Object.entries(args).map(([key, value]) => [
				key,
				["handle", "handles", "parent", "destination"].includes(key)
					? Array.isArray(value)
						? value.map(resolve)
						: resolve(value)
					: value
			])
		)
	}

	// Rejects handles the conversation has not seen before the guard judges the call, so a
	// hallucinated handle counts as an invalid output rather than a blocked one.
	checkHandles({ tool, args }: { tool: string; args: Record<string, unknown> }): ToolOutcome | null {
		const kindOf = (key: string, value: string): EntityKind => {
			if (key === "chat" || tool.includes("chat")) {
				return "chat"
			}

			if (key === "playlist" || tool === "open_playlist" || (tool === "play" && value.startsWith("p"))) {
				return "playlist"
			}

			return tool.includes("note") || (tool === "trash_items" && value.startsWith("n")) ? "note" : "drive"
		}

		try {
			for (const key of ["handle", "handles", "parent", "destination", "chat", "playlist"]) {
				const value = args[key]

				// Like the app: a path beside the handle decides, so a guessed handle there is left out, not refused.
				if (
					key === "handle" &&
					tool === "list_directory" &&
					typeof args["path"] === "string" &&
					this.isDirectoryPath(args["path"])
				) {
					continue
				}

				for (const handle of typeof value === "string" ? [value] : Array.isArray(value) ? value.map(String) : []) {
					this.known(handle, kindOf(key, handle))
				}
			}
		} catch (e) {
			if (e instanceof CallError) {
				return {
					ok: false,
					invalid: true,
					error: e.message,
					...(e.candidates === undefined || e.candidates.length === 0
						? {}
						: {
								candidates: e.candidates
							})
				}
			}

			throw e
		}

		return null
	}

	// What the call that just ran reported as returned, once.
	private takeReturned(): Candidate[] | null {
		const returned = this.returned

		this.returned = null

		return returned
	}

	// Under the drive root, as opposed to shared with the user from someone else's drive.
	inMyDrive(item: DriveItem): boolean {
		let current: DriveItem | undefined = item

		for (let depth = 0; current !== undefined && depth < 64; depth++) {
			if (current.parent === null) {
				return current.handle === "d0"
			}

			const parent: string = current.parent

			current = this.state.drive.find(candidate => candidate.handle === parent)
		}

		return false
	}

	pathOf(item: DriveItem): string {
		const names: string[] = []
		let current: DriveItem | undefined = item

		while (current !== undefined && current.parent !== null) {
			names.unshift(current.name)
			current = this.state.drive.find(candidate => candidate.handle === current?.parent)
		}

		return `/${names.join("/")}`
	}

	private drive(handle: string): DriveItem {
		const item = this.state.drive.find(candidate => candidate.handle === handle)

		if (item === undefined) {
			throw new CallError(`Unknown handle "${handle}"`, true)
		}

		return item
	}

	// Small models often pass a name where a handle belongs; answering with the matching handles
	// turns that into a recoverable error instead of a dead end.
	private known(handle: string, kind: EntityKind): void {
		if (this.exposed.has(handle)) {
			return
		}

		const wanted = normalizeText(handle.trim())
		const pool: Candidate[] =
			kind === "drive"
				? this.state.drive
						.filter(item => !item.trashed && item.parent !== null && this.inMyDrive(item))
						.map(item => ({
							handle: item.handle,
							name: item.name
						}))
				: kind === "note"
					? this.state.notes
							.filter(item => !item.trashed)
							.map(item => ({
								handle: item.handle,
								name: item.title
							}))
					: (kind === "chat" ? this.state.chats : this.state.playlists).map(item => ({
							handle: item.handle,
							name: item.name
						}))
		const candidates = /^[a-z]\d+$/.test(handle)
			? []
			: pool
					.filter(
						item =>
							wanted.length > 1 && (normalizeText(item.name).includes(wanted) || wanted.includes(normalizeText(item.name)))
					)
					.slice(0, 5)

		for (const candidate of candidates) {
			this.exposed.add(candidate.handle)
		}

		throw new CallError(
			candidates.length > 0
				? `"${handle}" is a name, not a handle. Matching handles: ${candidates.map(item => `${item.handle} "${item.name}"`).join(", ")}. Call again with the handle.`
				: `Unknown handle "${handle}". Find it first with ${LOOKUP_TOOL[kind]}.`,
			true,
			candidates
		)
	}

	private driveItem(handle: string): DriveItem {
		this.known(handle, "drive")

		const item = this.state.drive.find(candidate => candidate.handle === handle && !candidate.trashed)

		if (item === undefined) {
			throw new CallError(`"${handle}" is not a file or directory`, true)
		}

		return item
	}

	private directory(handle: string): DriveItem {
		const item = this.driveItem(handle)

		if (item.kind !== "directory") {
			throw new CallError(`"${handle}" is a file, not a directory`, true)
		}

		return item
	}

	// An item of the user's own drive a write may change, as the app's menus offer it: never the root, nor one
	// someone else shares.
	private ownItem(handle: string, kind?: "directory"): DriveItem {
		const item = kind === "directory" ? this.directory(handle) : this.driveItem(handle)

		if (item.sharedBy !== undefined || !this.inMyDrive(item)) {
			throw new CallError(`"${item.name}" is shared with the user; its owner manages it`, false)
		}

		if (item.parent === null && kind !== "directory") {
			throw new CallError("The drive root cannot be renamed", false)
		}

		return item
	}

	// A file as the batch planner sees it, as the app builds it: fixture files carry no creation date of their own,
	// and a photo's or video's capture date is the Photos timeline's estimate.
	private batchItem(item: DriveItem): BatchItem {
		const uploaded = Date.parse(item.uploaded ?? item.modified)
		const modified = Date.parse(item.modified)
		const media = this.matchesKind(item, "image") || this.matchesKind(item, "video")

		return {
			id: item.handle,
			name: item.name,
			parent: item.parent ?? "",
			uploaded,
			modified,
			...(media ? { taken: estimateCaptureTimestamp(uploaded, undefined, modified) } : {})
		}
	}

	private noteItem(handle: string): Note {
		this.known(handle, "note")

		const item = this.state.notes.find(candidate => candidate.handle === handle && !candidate.trashed)

		if (item === undefined) {
			throw new CallError(`"${handle}" is not a note`, true)
		}

		return item
	}

	private summary(item: DriveItem): Record<string, unknown> {
		this.exposed.add(item.handle)

		return {
			handle: item.handle,
			name: item.name,
			kind: item.kind,
			...(this.inMyDrive(item)
				? {
						path: this.pathOf(item)
					}
				: {}),
			...(item.sharedBy === undefined
				? {}
				: {
						sharedBy: item.sharedBy
					})
		}
	}

	private noteSummary(item: Note): Record<string, unknown> {
		this.exposed.add(item.handle)

		return {
			handle: item.handle,
			title: item.title,
			type: item.type,
			// Like the app: dates as local days.
			edited: evalLocalDay(item.edited),
			...(item.tags.length > 0
				? {
						tags: item.tags
					}
				: {}),
			...(item.pinned
				? {
						pinned: true
					}
				: {}),
			...(item.archived
				? {
						archived: true
					}
				: {}),
			...(item.trashed
				? {
						trashed: true
					}
				: {})
		}
	}

	private children(parent: string): DriveItem[] {
		return this.state.drive.filter(item => item.parent === parent && !item.trashed)
	}

	private descendants(parent: string): DriveItem[] {
		return this.children(parent).flatMap(item => (item.kind === "directory" ? [item, ...this.descendants(item.handle)] : [item]))
	}

	private assertFreeName({ parent, name, except }: { parent: string; name: string; except?: string }): void {
		if (name.trim().length === 0 || /[/\\]/.test(name)) {
			throw new CallError(`"${name}" is not a valid name`, false)
		}

		if (this.children(parent).some(item => item.handle !== except && sameName(item.name, name))) {
			throw new CallError(`An item named "${name}" already exists there`, false)
		}
	}

	private nextHandle(prefix: string): string {
		const pool = prefix === "n" ? this.state.notes : this.state.drive
		const highest = Math.max(
			...pool.filter(item => item.handle.startsWith(prefix)).map(item => Number(item.handle.slice(prefix.length)))
		)

		return `${prefix}${highest + 1}`
	}

	private dateSelection(input: Record<string, unknown>, fields: readonly [string, ...string[]]): DateSelection {
		const text = (key: string) => (typeof input[key] === "string" ? input[key] : undefined)
		const filter = resolveDateFilter(
			{
				period: text("period") as AssistantPeriodFilter | undefined,
				from: text("from"),
				to: text("to")
			},
			EVAL_CALENDAR
		)

		if (!filter.ok) {
			throw new CallError(filter.error, true)
		}

		return {
			field: text("date") ?? fields[0],
			bounds: filter.range === null ? null : dayRangeBounds(filter.range, EVAL_TIME_ZONE),
			range: filter.range === null ? null : describeDayRange(filter.range)
		}
	}

	// The note a date-filtered result carries when the filter alone emptied it.
	private emptyNote(selection: DateSelection, kept: number, outside: number): { note?: string } {
		return selection.range !== null && kept === 0 && outside > 0
			? {
					note: dateFilterNote(selection.range, outside)
				}
			: {}
	}

	// Fixture files record no creation date of their own, so "created" is the upload, as in the app.
	private driveDate(item: DriveItem, field: string): number {
		return Date.parse(field === "modified" ? item.modified : (item.uploaded ?? item.modified))
	}

	private matchesKind(item: DriveItem, kind: string | undefined): boolean {
		if (kind === undefined || kind === "any") {
			return true
		}

		if (kind === "directory" || kind === "file") {
			return item.kind === kind
		}

		return item.kind === "file" && (EXTENSIONS[kind] ?? []).includes(extension(item.name))
	}

	private inSelection(item: DriveItem, selection: DateSelection): boolean {
		return selection.bounds === null || inDayRange(this.driveDate(item, selection.field), selection.bounds)
	}

	// Like the app: a size-sorted listing reads the sizes of its first directories (by name), the rest stay
	// unknown.
	private directorySizes(items: readonly DriveItem[]): { sizes: Map<string, number>; unknown: number } {
		const directories = items.filter(item => item.kind === "directory").sort((a, b) => a.name.localeCompare(b.name))
		const sizes = new Map(
			directories.slice(0, DIRECTORY_SIZE_READS).map(item => [item.handle, this.directoryTotals(item.handle).bytes])
		)

		return {
			sizes,
			unknown: directories.length - sizes.size
		}
	}

	// Like the app: a size order ranks files and directories (by total size) together, directories of unknown
	// size last by name; a date order lists files first; by name, directories first.
	private sortListing(items: DriveItem[], sort: ListingSort, field: string, sizes: ReadonlyMap<string, number> = new Map()): DriveItem[] {
		const byName = (a: DriveItem, b: DriveItem) => a.name.localeCompare(b.name)

		if (sort === "name") {
			return [
				...items.filter(item => item.kind === "directory").sort(byName),
				...items.filter(item => item.kind === "file").sort(byName)
			]
		}

		const ascending = sort === "smallest" || sort === "oldest"
		const by = (key: (item: DriveItem) => number) => (a: DriveItem, b: DriveItem) =>
			(ascending ? key(a) - key(b) : key(b) - key(a)) || byName(a, b)

		if (sort === "largest" || sort === "smallest") {
			const size = (item: DriveItem) => (item.kind === "file" ? item.size : sizes.get(item.handle))

			return [
				...items.filter(item => size(item) !== undefined).sort(by(item => size(item) ?? 0)),
				...items.filter(item => size(item) === undefined).sort(byName)
			]
		}

		const order = by(item => this.driveDate(item, field))

		return [...items.filter(item => item.kind === "file").sort(order), ...items.filter(item => item.kind === "directory").sort(order)]
	}

	// The extra fields a filtered or sorted listing shows: the date it went by, the size it sorted by.
	private listingFields(
		item: DriveItem,
		{ date, size, sizes }: { date: string | null; size: boolean; sizes?: ReadonlyMap<string, number> }
	): Record<string, unknown> {
		const bytes = item.kind === "file" ? item.size : sizes?.get(item.handle)

		return {
			...(date === null
				? {}
				: {
						[date]: evalLocalDay(date === "modified" ? item.modified : (item.uploaded ?? item.modified))
					}),
			...(size && bytes !== undefined
				? {
						size: formatBytes(bytes)
					}
				: {})
		}
	}

	private directoryTotals(handle: string): { bytes: number; files: number; directories: number } {
		const totals = {
			bytes: 0,
			files: 0,
			directories: 0
		}

		for (const child of this.children(handle)) {
			if (child.kind === "file") {
				totals.bytes += child.size
				totals.files++
			} else {
				const inner = this.directoryTotals(child.handle)

				totals.bytes += inner.bytes
				totals.files += inner.files
				totals.directories += inner.directories + 1
			}
		}

		return totals
	}

	private search({ query, kind, input }: { query: string; kind: string | undefined; input: Record<string, unknown> }): unknown {
		const selection = this.dateSelection(input, ["modified", "uploaded", "created"])
		const queryTokens = searchTokens(query)

		const words = engineTokens(rawSearchTokens(query), SEARCH_ENGINE_WORDS)

		// Like the app: a search is by name, so it needs words.
		if (queryTokens.length === 0 || words.length === 0) {
			throw new CallError(SEARCH_NEEDS_WORDS, true)
		}

		// Like the app's search engine: names that contain one word, as written but for case, the first word
		// (longest first) that any name contains.
		const searchable = this.state.drive.filter(item => item.parent !== null && !item.trashed && this.inMyDrive(item))
		const hits =
			words
				.map(word => searchable.filter(item => item.name.normalize("NFC").toLowerCase().includes(word)))
				.find(found => found.length > 0) ?? []
		const matching = hits
			.filter(item => this.matchesKind(item, kind))
			.map(item => {
				const haystack = normalizeText(item.name)

				return {
					item,
					score: queryTokens.filter(token => tokenMatches(haystack, token)).length
				}
			})
			.filter(({ score }) => score > 0)
		const scored = matching.filter(({ item }) => this.inSelection(item, selection))

		const all = scored.filter(({ score }) => score === queryTokens.length)
		// Like the app: full matches when there are any, and "more" counts what that same pool left out.
		const pool = all.length > 0 ? all : scored.sort((a, b) => b.score - a.score)

		return {
			results: pool.slice(0, SEARCH_RESULT_ITEMS).map(({ item }) => ({
				...this.summary(item),
				...this.listingFields(item, {
					date: selection.range === null ? null : selection.field,
					size: false
				})
			})),
			...listRest(pool.length, SEARCH_RESULT_ITEMS),
			...(selection.range === null
				? {}
				: {
						dates: `${selection.field} ${selection.range}`
					}),
			...joinNotes(
				this.emptyNote(selection, scored.length, matching.length),
				all.length === 0 && scored.length > 0 && queryTokens.length > 1 ? { note: PARTIAL_MATCH_NOTE } : {}
			)
		}
	}

	private run({ name, input }: { name: string; input: Record<string, unknown> }): unknown {
		const str = (key: string): string => String(input[key])
		const optionalStr = (key: string): string | undefined => (typeof input[key] === "string" ? input[key] : undefined)
		const list = (key: string): string[] => (Array.isArray(input[key]) ? input[key].map(String) : [])

		switch (name) {
			case "get_context": {
				return {
					context: this.describeContext()
				}
			}

			case "search_items": {
				return this.search({
					query: str("query"),
					kind: optionalStr("kind"),
					input
				})
			}

			case "list_directory": {
				// Models fill both optional fields or put a path into "handle"; take whichever resolves.
				const handleArg = optionalStr("handle")
				const path = optionalStr("path") ?? (handleArg?.startsWith("/") === true ? handleArg : undefined)
				const byHandle = handleArg !== undefined && !handleArg.startsWith("/")
				const target =
					path !== undefined
						? this.directoryAtOr(path, byHandle ? handleArg : undefined)
						: handleArg !== undefined
							? this.directory(handleArg)
							: this.directoryAt("/")

				this.exposed.add(target.handle)

				const selection = this.dateSelection(input, ["modified", "uploaded", "created"])
				const sort = optionalStr("sort") as ListingSort | undefined
				const kind = optionalStr("kind")
				const children = this.children(target.handle)
				const ofKind = children.filter(item => this.matchesKind(item, kind))
				const kept = ofKind.filter(item => this.inSelection(item, selection))
				const byDate = selection.range !== null || sort === "newest" || sort === "oldest"
				const bySize = sort === "largest" || sort === "smallest"
				const sizes = bySize
					? this.directorySizes(kept)
					: {
							sizes: new Map<string, number>(),
							unknown: 0
						}

				const page = listingPage(
					sort === undefined ? kept : this.sortListing(kept, sort, selection.field, sizes.sizes),
					input["offset"],
					{
						filtered: kept.length < children.length
					}
				)

				return {
					directory: {
						handle: target.handle,
						...(this.inMyDrive(target)
							? {
									path: this.pathOf(target)
								}
							: {}),
						...(target.sharedBy === undefined
							? {}
							: {
									sharedBy: target.sharedBy
								})
					},
					...(page.offset > 0
						? {
								offset: page.offset
							}
						: {}),
					items: page.rows.map(item => {
						this.exposed.add(item.handle)

						return {
							handle: item.handle,
							name: item.name,
							kind: item.kind,
							...(item.sharedBy === undefined
								? {}
								: {
										sharedBy: item.sharedBy
									}),
							...this.listingFields(item, {
								date: byDate ? selection.field : null,
								size: bySize,
								sizes: sizes.sizes
							})
						}
					}),
					...(page.shown === undefined
						? {}
						: {
								shown: page.shown
							}),
					...(page.more > 0
						? {
								more: page.more,
								next: page.next
							}
						: {}),
					...(selection.range === null
						? {}
						: {
								dates: `${selection.field} ${selection.range}`
							}),
					...joinNotes(
						this.emptyNote(selection, kept.length, ofKind.length),
						page.note === undefined
							? {}
							: {
									note: page.note
								},
						unknownSizesNote(sizes.unknown),
						bySize && kept.some(item => item.kind === "directory")
							? {
									note: DIRECTORIES_BY_SIZE_NOTE
								}
							: {}
					)
				}
			}

			case "recent_items": {
				const selection = this.dateSelection(input, ["uploaded", "modified"])
				const sort = (optionalStr("sort") ?? "newest") as ListingSort
				const kind = optionalStr("kind")
				const since = EVAL_NOW - RECENT_DAYS * 86_400_000
				const recents = this.state.drive.filter(
					item => item.kind === "file" && !item.trashed && this.inMyDrive(item) && this.driveDate(item, "uploaded") >= since
				)
				const oldest = Math.min(...recents.map(item => this.driveDate(item, "uploaded")))
				const ofKind = recents.filter(item => this.matchesKind(item, kind))
				const kept = this.sortListing(
					ofKind.filter(item => this.inSelection(item, selection)),
					sort,
					selection.field
				)
				const reachesBack = recents.length > 0 && selection.bounds !== null && selection.bounds.start < oldest
				// Like the app: the latest files, when the dates left none.
				const newest =
					selection.range !== null && kept.length === 0 && sort === "newest"
						? this.sortListing(ofKind, "newest", selection.field).slice(0, OUTSIDE_DATES_ITEMS)
						: []
				// Like the app: Recents rows carry no location; a path only where a listing the app holds has the
				// item's directory (here: one listed earlier in the conversation).
				const row = (item: DriveItem) => {
					const listed = item.parent !== null && this.exposed.has(item.parent)
					const { path, ...summary } = this.summary(item)

					return {
						...summary,
						...(listed
							? {
									path
								}
							: {}),
						...this.listingFields(item, {
							date: selection.field,
							size: sort === "largest" || sort === "smallest"
						})
					}
				}

				return {
					items: kept.slice(0, RECENT_ITEMS).map(row),
					...(newest.length === 0
						? {}
						: {
								newest: newest.map(row)
							}),
					...listRest(kept.length, RECENT_ITEMS),
					...(selection.range === null
						? {}
						: {
								dates: `${selection.field} ${selection.range}`
							}),
					...joinNotes(
						this.emptyNote(selection, kept.length, ofKind.length),
						reachesBack
							? {
									note: recentsReachNote(evalLocalDay(new Date(oldest).toISOString()))
								}
							: {}
					)
				}
			}

			case "list_photos": {
				const selection = this.dateSelection(input, ["taken"])
				const kind = optionalStr("kind") ?? "any"
				// Like the app: the Photos root's media, newest taken first; a fixture photo was taken when last modified.
				const photos = this.descendants(PHOTOS_ROOT)
					.filter(
						item =>
							item.kind === "file" &&
							[...(EXTENSIONS["image"] ?? []), ...(EXTENSIONS["video"] ?? [])].includes(extension(item.name))
					)
					.sort((a, b) => Date.parse(b.modified) - Date.parse(a.modified))
				const ofKind = photos.filter(item => kind === "any" || (EXTENSIONS[kind] ?? []).includes(extension(item.name)))
				const kept = ofKind.filter(item => this.inSelection(item, { ...selection, field: "modified" }))
				const ordered = optionalStr("sort") === "oldest" ? kept.toReversed() : kept

				return {
					photos: ordered.slice(0, PHOTOS_ITEMS).map(item => {
						this.exposed.add(item.handle)

						return {
							handle: item.handle,
							name: item.name,
							taken: evalLocalDay(item.modified)
						}
					}),
					...listRest(ordered.length, PHOTOS_ITEMS),
					...(selection.range === null
						? {}
						: {
								dates: `${selection.field} ${selection.range}`
							}),
					...this.emptyNote(selection, kept.length, ofKind.length)
				}
			}

			case "get_storage": {
				const { storageUsed, maxStorage, versionedStorage } = this.state.account

				return storageSummary({
					storageUsed: BigInt(storageUsed),
					maxStorage: BigInt(maxStorage),
					versionedStorage: BigInt(versionedStorage)
				})
			}

			case "get_item_info": {
				const item = this.driveItem(str("handle"))

				const totals = item.kind === "directory" ? this.directoryTotals(item.handle) : null

				return {
					...this.summary(item),
					size:
						totals === null
							? formatBytes(item.size)
							: `${formatBytes(totals.bytes)} in ${String(totals.files)} files and ${String(totals.directories)} directories`,
					// Like the app: the created day only where it differs from the modified one.
					...(evalLocalDay(item.uploaded ?? item.modified) === evalLocalDay(item.modified)
						? {}
						: {
								created: evalLocalDay(item.uploaded ?? item.modified)
							}),
					modified: evalLocalDay(item.modified),
					favorite: item.favorite,
					// Like the app: only what the row says, so an owned item's shares and links are get_sharing's.
					...(item.sharedBy === undefined
						? {
								sharing: OWN_SHARING_UNCHECKED
							}
						: {
								sharedWithYou: true
							})
				}
			}

			case "read_text_file": {
				const item = this.driveItem(str("handle"))

				if (item.kind !== "file" || !TEXT_EXTENSIONS.includes(extension(item.name)) || item.content === undefined) {
					// As the app: a document gets a pointer to read_document, any other file is no text.
					throw item.kind === "file" && item.document !== undefined
						? new CallError(readWithDocument(item.name), true)
						: new CallError(`"${item.name}" is not a text file`, false)
				}

				return {
					handle: item.handle,
					name: item.name,
					content: item.content
				}
			}

			case "reveal_item": {
				const item = this.driveItem(str("handle"))

				this.state.context.screen = "drive"
				this.state.context.directory = item.parent ?? "d0"
				this.state.context.selection = [item.handle]

				return {
					shown: this.pathOf(item)
				}
			}

			case "set_favorite": {
				const items = list("handles").map(handle => this.driveItem(handle))

				for (const item of items) {
					item.favorite = input["favorite"] === true
				}

				return {
					updated: items.map(item => item.name)
				}
			}

			case "create_directory": {
				const parent = this.directory(str("parent"))
				const directoryName = str("name").trim()

				this.assertFreeName({
					parent: parent.handle,
					name: directoryName
				})

				const created: DriveItem = {
					handle: this.nextHandle("d"),
					kind: "directory",
					name: directoryName,
					parent: parent.handle,
					size: 0,
					modified: "2025-10-07T12:00:00Z",
					favorite: false,
					trashed: false,
					shared: false
				}

				this.state.drive.push(created)

				return {
					created: this.summary(created)
				}
			}

			case "rename_item": {
				const item = this.driveItem(str("handle"))
				const newName = str("new_name").trim()

				if (item.parent === null) {
					throw new CallError("The drive root cannot be renamed", false)
				}

				this.assertFreeName({
					parent: item.parent,
					name: newName,
					except: item.handle
				})

				item.name = newName

				return {
					renamed: this.summary(item)
				}
			}

			case "move_items":
			case "copy_items": {
				const items = list("handles").map(handle => this.driveItem(handle))
				const destination = this.directory(str("destination"))

				for (const item of items) {
					let cursor: DriveItem | undefined = destination

					while (cursor !== undefined) {
						if (cursor.handle === item.handle) {
							throw new CallError(`Cannot put "${item.name}" inside itself`, false)
						}

						cursor = this.state.drive.find(candidate => candidate.handle === cursor?.parent)
					}

					this.assertFreeName({
						parent: destination.handle,
						name: item.name,
						except: item.handle
					})
				}

				if (name === "move_items") {
					for (const item of items) {
						item.parent = destination.handle
					}

					return {
						moved: items.map(item => item.name),
						to: this.pathOf(destination)
					}
				}

				const copies = items.map(item => {
					const copy: DriveItem = {
						...structuredClone(item),
						handle: this.nextHandle(item.kind === "directory" ? "d" : "f"),
						parent: destination.handle,
						favorite: false,
						shared: false
					}

					this.state.drive.push(copy)

					return copy
				})

				return {
					copied: copies.map(copy => this.summary(copy))
				}
			}

			case "trash_items": {
				// Every handle resolves before anything changes, so a call that fails trashed nothing; a repeated
				// handle is one item.
				const targets = [...new Set(list("handles"))].map(handle => {
					if (handle.startsWith("n")) {
						return this.noteItem(handle)
					}

					const item = this.driveItem(handle)

					if (item.parent === null) {
						throw new CallError("The drive root cannot be trashed", false)
					}

					return item
				})

				for (const item of targets) {
					item.trashed = true
				}

				return {
					trashed: targets.map(item => ("title" in item ? item.title : item.name)),
					restorable: true
				}
			}

			case "list_notes": {
				const query = optionalStr("query")
				const queryTokens = query === undefined ? [] : searchTokens(query)
				const selection = this.dateSelection(input, ["edited"])
				const only = optionalStr("only") ?? "any"
				const matches = this.state.notes.filter(item => {
					if (
						item.trashed !== (only === "trashed") ||
						(only === "pinned" && !item.pinned) ||
						(only === "favorite" && !item.favorite) ||
						(only === "archived" && !item.archived)
					) {
						return false
					}

					const haystack = normalizeText(`${item.title} ${item.tags.join(" ")}`)

					return queryTokens.length === 0 || queryTokens.some(token => tokenMatches(haystack, token))
				})

				const dated = matches.filter(item => selection.bounds === null || inDayRange(Date.parse(item.edited), selection.bounds))
				// Like the app: a period that alone empties a search by words gives way to the word matches.
				const undated = dated.length === 0 && queryTokens.length > 0 && matches.length > 0 && selection.range !== null
				const kept = undated ? matches : dated
				// Like the app's sidebar: pinned first, archived last, newest edit first, at most NOTES_ITEMS.
				const rank = (item: Note) => (item.pinned ? 0 : item.archived ? 2 : 1)
				const ordered = kept.toSorted((a, b) => rank(a) - rank(b) || Date.parse(b.edited) - Date.parse(a.edited))

				return {
					notes: ordered.slice(0, NOTES_ITEMS).map(item => this.noteSummary(item)),
					...listRest(ordered.length, NOTES_ITEMS),
					...(selection.range === null || undated
						? {}
						: {
								dates: `${selection.field} ${selection.range}`
							}),
					...(undated
						? {
								note: datedElsewhereNote(selection.range ?? "")
							}
						: this.emptyNote(selection, kept.length, matches.length))
				}
			}

			// Like the app: only the text the device holds, in the sidebar's order, most words matched first;
			// handles and titles, never the text.
			case "search_note_text": {
				const tokens = searchTokens(str("query"))

				if (tokens.length === 0) {
					throw new CallError(NOTE_TEXT_NEEDS_WORDS, true)
				}

				const rank = (item: Note) => (item.pinned ? 0 : item.archived ? 2 : 1)
				const notes = this.state.notes
					.filter(item => !item.trashed)
					.toSorted((a, b) => rank(a) - rank(b) || Date.parse(b.edited) - Date.parse(a.edited))
				const held = notes.filter(item => item.textOnDevice !== false)
				// As the app: the text only; words only in titles or tags ask for list_notes.
				const hits = held
					.map(item => ({ item, tokensMatched: matchScore(item.content, tokens) }))
					.filter(({ tokensMatched }) => tokensMatched > 0)
					.toSorted((a, b) => b.tokensMatched - a.tokensMatched)

				if (hits.length === 0 && notes.some(item => matchScore(`${item.title} ${item.tags.join(" ")}`, tokens) > 0)) {
					throw new CallError(NOTE_TEXT_IN_TITLES, true)
				}

				return {
					...noteTextCoverage({ searched: held.length, total: notes.length, cut: false }),
					notes: hits.slice(0, SEARCH_RESULT_ITEMS).map(({ item, tokensMatched }) => {
						this.exposed.add(item.handle)

						return {
							handle: item.handle,
							title: item.title,
							tokensMatched,
							...(item.maybeStale === true
								? {
										maybeStale: true
									}
								: {})
						}
					}),
					queryTokens: tokens.length,
					...listRest(hits.length, SEARCH_RESULT_ITEMS),
					...(hits.length === 0 ? { note: NOTE_TEXT_NO_MATCH_NOTE } : {})
				}
			}

			case "read_note": {
				const item = this.noteItem(str("handle"))

				return {
					handle: item.handle,
					title: item.title,
					content: item.content
				}
			}

			case "open_note": {
				const item = this.noteItem(str("handle"))

				this.state.context.screen = "note"
				this.state.opened = item.handle

				return {
					opened: item.title
				}
			}

			case "create_note": {
				const created: Note = {
					handle: this.nextHandle("n"),
					title: str("title").trim(),
					type: (optionalStr("type") ?? "text") as NoteType,
					content: optionalStr("content") ?? "",
					tags: [],
					pinned: false,
					favorite: false,
					archived: false,
					trashed: false,
					edited: "2025-10-07T12:00:00Z"
				}

				this.state.notes.push(created)

				return {
					created: this.noteSummary(created)
				}
			}

			case "set_note_flags": {
				const item = this.noteItem(str("handle"))
				const flags = (["pinned", "favorite", "archived"] as const).filter(flag => typeof input[flag] === "boolean")

				if (flags.length === 0) {
					throw new CallError("Pass at least one of pinned, favorite or archived", true)
				}

				// As the web app: a call that changes nothing is refused before its card.
				if (flags.every(flag => item[flag] === (input[flag] === true))) {
					throw new CallError(`"${item.title}" is already like that; nothing to change`, false)
				}

				for (const flag of flags) {
					item[flag] = input[flag] === true
				}

				return {
					updated: this.noteSummary(item)
				}
			}

			case "list_chats": {
				const query = optionalStr("query")
				const queryTokens = query === undefined ? [] : searchTokens(query)
				const matches = this.state.chats.filter(item => {
					const haystack = normalizeText(`${item.name} ${item.participants.join(" ")}`)

					return queryTokens.length === 0 || queryTokens.some(token => tokenMatches(haystack, token))
				})

				return {
					chats: matches.map(item => {
						this.exposed.add(item.handle)

						const last = item.messages.at(-1)

						return {
							handle: item.handle,
							name: item.name,
							// Like the app: a one-on-one chat's only participant is its name.
							...(item.participants.length === 1 && item.participants[0] === item.name
								? {}
								: {
										participants: item.participants
									}),
							...(last === undefined
								? {}
								: {
										lastActivity: evalLocalDay(last.sent)
									}),
							// Like the app: whether the last message is the user's own, and whether any are unread.
							...(last?.from === "me"
								? {
										lastFrom: "you"
									}
								: {}),
							...(item.unread === true
								? {
										unread: true
									}
								: {})
						}
					})
				}
			}

			case "read_chat": {
				const item = this.chat(str("handle"))
				const limit = typeof input["limit"] === "number" && input["limit"] > 0 ? input["limit"] : 20

				return {
					chat: item.name,
					messages: item.messages.slice(-limit).map(message => ({
						...message,
						sent: evalLocalDay(message.sent)
					}))
				}
			}

			case "open_chat": {
				const item = this.chat(str("handle"))

				this.state.context.screen = "chat"
				this.state.opened = item.handle

				return {
					opened: item.name
				}
			}

			case "draft_chat_message": {
				const item = this.chat(str("chat"))

				// Like the app: text the user left in the chat's message box is never overwritten.
				if (this.state.busyComposers.includes(item.handle)) {
					throw new CallError(composerBusyMessage(item.name), false)
				}

				this.state.context.screen = "chat"
				this.state.opened = item.handle
				this.state.draft = {
					chat: item.handle,
					text: str("text")
				}

				return {
					drafted: true,
					chat: item.name,
					note: DRAFTED_NOTE
				}
			}

			case "list_playlists": {
				return {
					playlists: this.state.playlists.map(item => {
						this.exposed.add(item.handle)

						return {
							handle: item.handle,
							name: item.name,
							tracks: item.tracks.length
						}
					})
				}
			}

			case "open_playlist": {
				const item = this.playlist(str("handle"))

				this.state.context.screen = "playlist"
				this.state.opened = item.handle

				return {
					opened: item.name,
					tracks: item.tracks.map(handle => this.summary(this.drive(handle)))
				}
			}

			case "play": {
				const handle = str("handle")

				if (handle.startsWith("p")) {
					const item = this.playlist(handle)
					const first = item.tracks[0]

					if (first === undefined) {
						throw new CallError(`Playlist "${item.name}" is empty`, false)
					}

					this.state.context.playing = {
						handle: first,
						playlist: item.handle,
						paused: false,
						shuffle: false,
						repeat: false
					}

					return {
						playing: this.drive(first).name,
						playlist: item.name
					}
				}

				const item = this.driveItem(handle)

				// Like the app: a directory plays its audio files in name order.
				if (item.kind === "directory") {
					const tracks = this.children(item.handle)
						.filter(child => child.kind === "file" && (EXTENSIONS["audio"] ?? []).includes(extension(child.name)))
						.sort((a, b) => a.name.localeCompare(b.name))
					const first = tracks[0]

					if (first === undefined) {
						throw new CallError(`"${item.name}" holds no audio files`, false)
					}

					this.state.context.playing = {
						handle: first.handle,
						playlist: null,
						paused: false,
						shuffle: false,
						repeat: false
					}

					return {
						playing: first.name,
						directory: item.name,
						tracks: tracks.length
					}
				}

				if (!(EXTENSIONS["audio"] ?? []).includes(extension(item.name))) {
					throw new CallError(`"${item.name}" is not an audio file`, true)
				}

				this.state.context.playing = {
					handle: item.handle,
					playlist: null,
					paused: false,
					shuffle: false,
					repeat: false
				}

				return {
					playing: item.name
				}
			}

			case "audio_control": {
				const playing = this.state.context.playing
				const action = str("action")

				if (playing === null) {
					throw new CallError("Nothing is playing", false)
				}

				if (action === "pause" || action === "resume") {
					playing.paused = action === "pause"
				} else if (action === "stop") {
					this.state.context.playing = null
				} else if (action === "shuffle_on" || action === "shuffle_off") {
					playing.shuffle = action === "shuffle_on"
				} else if (action === "repeat_on" || action === "repeat_off") {
					playing.repeat = action === "repeat_on"
				} else if (playing.playlist !== null) {
					// The player's own queue: the playlist need not have been shown to the model.
					const tracks = this.state.playlists.find(item => item.handle === playing.playlist)?.tracks ?? []
					const index = tracks.indexOf(playing.handle)
					const next = tracks[(index + (action === "next" ? 1 : tracks.length - 1)) % tracks.length]

					if (next !== undefined) {
						playing.handle = next
					}
				}

				return {
					done: action
				}
			}

			case "add_tracks_to_playlist": {
				const item = this.playlist(str("playlist"))
				const tracks = list("handles").map(handle => {
					const track = this.driveItem(handle)

					if (track.kind !== "file" || !(EXTENSIONS["audio"] ?? []).includes(extension(track.name))) {
						throw new CallError(`"${track.name}" is not an audio file`, true)
					}

					return track
				})
				const added = tracks.filter(track => !item.tracks.includes(track.handle))

				// As the web app: a call that adds nothing is refused before its card.
				if (added.length === 0) {
					throw new CallError(`Every one of these is already in "${item.name}"; nothing to add`, false)
				}

				item.tracks.push(...added.map(track => track.handle))

				return {
					added: added.map(track => track.name),
					alreadyThere: tracks.length - added.length,
					playlist: item.name
				}
			}

			case "list_section": {
				const section = str("section")
				const items = this.state.drive.filter(item => {
					switch (section) {
						case "favorites":
							return item.favorite && !item.trashed
						case "trash":
							return item.trashed
						case "shared_with_me":
							return item.sharedBy !== undefined && item.parent === null
						case "shared_by_me":
							return (item.sharedWith?.length ?? 0) > 0 && !item.trashed
						default:
							return item.link !== undefined && !item.trashed
					}
				})
				const queryTokens = searchTokens(optionalStr("query") ?? "")
				// Like the app: the words narrow by name or by whom an item is shared with or by, and a long list is cut.
				const kept = this.sortListing(
					items.filter(item => {
						const haystack = normalizeText([item.name, item.sharedBy ?? "", ...(item.sharedWith ?? [])].join(" "))

						return queryTokens.every(token => tokenMatches(haystack, token))
					}),
					"name",
					"modified"
				)

				return {
					section,
					items: kept.slice(0, MAX_ARRAY_ITEMS).map(item => {
						this.exposed.add(item.handle)

						return {
							handle: item.handle,
							name: item.name,
							kind: item.kind,
							...(section === "favorites"
								? {
										path: this.pathOf(item)
									}
								: {}),
							...(item.sharedBy === undefined
								? {}
								: {
										sharedBy: item.sharedBy
									}),
							...(section === "shared_by_me"
								? {
										sharedWith: item.sharedWith
									}
								: {})
						}
					}),
					...listRest(kept.length, MAX_ARRAY_ITEMS),
					...(section === "trash" ? trashSectionNote(kept.length) : {})
				}
			}

			case "get_sharing": {
				const item = this.driveItem(str("handle"))

				if (item.parent === null && item.handle === "d0") {
					throw new CallError(ROOT_NOT_SHAREABLE, false)
				}

				if (item.sharedBy !== undefined) {
					return {
						handle: item.handle,
						name: item.name,
						sharedWithYou: true,
						sharedBy: item.sharedBy,
						note: SHARED_WITH_YOU_NOTE
					}
				}

				const ancestors: DriveItem[] = []

				for (let parent = item.parent; parent !== null && parent !== "d0";) {
					const row = this.drive(parent)

					ancestors.push(row)
					parent = row.parent
				}

				const linkedThrough = item.link === undefined ? ancestors.find(ancestor => ancestor.link !== undefined) : undefined
				const sharedThrough = ancestors.find(ancestor => (ancestor.sharedWith?.length ?? 0) > 0)

				return {
					handle: item.handle,
					name: item.name,
					publicLink: item.link ?? "none",
					...(linkedThrough === undefined
						? {}
						: {
								linkedThrough: linkedThrough.name
							}),
					sharedWith: item.sharedWith ?? [],
					...(sharedThrough === undefined
						? {}
						: {
								sharedThrough: {
									directory: sharedThrough.name,
									with: sharedThrough.sharedWith
								}
							})
				}
			}

			case "find_contacts": {
				const query = str("query")
				const address = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/u.exec(query)?.[0].toLowerCase()
				const queryTokens = searchTokens(query)

				if (address === undefined && queryTokens.length === 0) {
					throw new CallError(CONTACT_NEEDS_WORDS, true)
				}

				// Like the app: an address matches only itself, words must all match the name or the address before
				// its "@", so a domain or a near miss lends no one's chat handle to a draft.
				const matches = this.state.contacts.filter(contact => {
					if (address !== undefined) {
						return contact.email.toLowerCase() === address
					}

					const haystack = normalizeText(`${contact.name} ${contact.email.split("@")[0] ?? ""}`)

					return queryTokens.every(token => tokenMatches(haystack, token))
				})
				const returned: Candidate[] = []
				const rows = matches.map(contact => {
					const chat = contact.chat === undefined ? undefined : this.state.chats.find(item => item.handle === contact.chat)

					if (chat !== undefined) {
						this.exposed.add(chat.handle)
						returned.push({
							handle: chat.handle,
							name: chat.name
						})
					}

					return {
						name: contact.name,
						email: contact.email,
						...(chat === undefined
							? {}
							: {
									chat: chat.handle
								})
					}
				})

				this.returned = returned

				return {
					contacts: rows,
					...(rows.length === 0
						? {
								note: NO_CONTACT_NOTE
							}
						: rows.some(row => row.chat === undefined)
							? {
									note: CONTACT_WITHOUT_CHAT_NOTE
								}
							: {})
				}
			}

			case "get_transfers": {
				const transfers = this.state.transfers
				const running = transfers.filter(transfer => transfer.status === "running" || transfer.status === "paused")
				const finished = transfers.filter(transfer => transfer.status === "done" || transfer.status === "failed")
				const sized = running.filter(transfer => transfer.size !== undefined && transfer.progress !== undefined)
				const total = sized.reduce((sum, transfer) => sum + (transfer.size ?? 0), 0)
				const done = sized.reduce((sum, transfer) => sum + ((transfer.size ?? 0) * (transfer.progress ?? 0)) / 100, 0)

				return {
					running: running.length,
					...(running.length > 0 && total > 0
						? {
								overall: `${String(Math.floor((done / total) * 100))}%`
							}
						: {}),
					failed: finished.filter(transfer => transfer.status === "failed").length,
					transfers: [
						...running.map(transfer => ({
							name: transfer.name,
							kind: transfer.kind,
							status: transfer.status,
							...(transfer.progress === undefined || transfer.size === undefined
								? {}
								: {
										progress: `${String(transfer.progress)}%`,
										size: formatBytes(transfer.size)
									}),
							...(transfer.left === undefined
								? {}
								: {
										left: transfer.left
									})
						})),
						...finished.map(transfer => {
							if (transfer.item !== undefined) {
								this.exposed.add(transfer.item)
							}

							return {
								name: transfer.name,
								...(transfer.item === undefined
									? {}
									: {
											handle: transfer.item
										}),
								kind: transfer.kind,
								status: transfer.status,
								...(transfer.error === undefined
									? {}
									: {
											error: transfer.error
										})
							}
						})
					],
					...(transfers.length === 0
						? {
								note: NO_TRANSFERS_NOTE
							}
						: {})
				}
			}

			case "open_route": {
				const help = typeof input["help"] === "string" && input["help"].trim().length > 0 ? input["help"].trim() : null
				const pair = typeof input["pair"] === "string" && input["pair"].trim().length > 0 ? input["pair"].trim() : null

				// A pair handle opens that pair's Issues tab, whatever the route says.
				if (pair !== null) {
					if (!this.desktop) {
						throw routeUnavailable("sync")
					}

					const id = [...this.pairHandles].find(([, handle]) => handle === pair)?.[0]

					if (id === undefined) {
						throw new CallError(`Unknown handle "${pair}". Find it first with get_desktop_status.`, true)
					}

					if (!this.state.desktop.sync.pairs.some(candidate => candidate.id === id)) {
						throw new CallError("That sync pair no longer exists", false)
					}

					this.state.context.screen = "sync"
					this.state.opened = `pair:${id}`

					return {
						...screenOpened("sync"),
						tab: "issues"
					}
				}

				// A help handle opens its setting's section, whatever the route says, and rings the setting there.
				if (help !== null) {
					const id = [...this.helpHandles].find(([, handle]) => handle === help)?.[0]
					const entry = APP_HELP.find(candidate => candidate.id === id)

					if (entry === undefined) {
						throw new CallError(`Unknown handle "${help}". Find it first with app_help.`, true)
					}

					this.state.context.screen = entry.route
					this.state.opened = `help:${entry.id}`

					return screenOpened(entry.route)
				}

				if ((UNAVAILABLE_ROUTES[this.desktop ? "desktop" : "web"] as readonly string[]).includes(str("route"))) {
					throw routeUnavailable(str("route"))
				}

				this.state.context.screen = str("route")
				this.state.opened = null

				return screenOpened(str("route"))
			}

			case "read_document": {
				return this.readDocument(input)
			}

			case "rename_by_pattern": {
				const handles = list("handles")
				const scope = optionalStr("scope")
				let files: DriveItem[]

				if (handles.length > 0) {
					files = [...new Set(handles)].map(handle => this.ownItem(handle))
				} else if (scope !== undefined) {
					const directory = this.ownItem(scope, "directory")

					files = this.children(directory.handle).filter(
						item => item.kind === "file" && this.matchesKind(item, optionalStr("kind"))
					)
				} else {
					throw new CallError("Pass scope (a directory) or handles (the files)", true)
				}

				const result = planBatchRename({
					names: DRIVE_NAME_RULES,
					items: files.map(item => this.batchItem(item)),
					taken: new Map(
						[...new Set(files.map(item => item.parent ?? ""))].map(parent => [
							parent,
							this.children(parent).map(item => item.name)
						])
					),
					scheme: str("scheme") as BatchRenameScheme,
					date: optionalStr("date") as BatchDateField | undefined,
					text: optionalStr("text"),
					find: optionalStr("find"),
					timeZone: EVAL_TIME_ZONE
				})

				if (!result.ok) {
					throw new CallError(result.error, result.invalid)
				}

				if (result.plan.changes.length === 0) {
					throw new CallError("No file would get a new name; nothing to rename", false)
				}

				for (const change of result.plan.changes) {
					const item = files.find(candidate => candidate.handle === change.id)

					if (item !== undefined) {
						item.name = change.to
					}
				}

				return {
					renamed: result.plan.changes.length,
					...(result.plan.skipped.length > 0
						? {
								skipped: result.plan.skipped.map(({ name: skippedName, reason }) => ({ name: skippedName, reason }))
							}
						: {})
				}
			}

			case "organize_by_date": {
				const directory = this.ownItem(str("scope"), "directory")
				const children = this.children(directory.handle)
				const files = children.filter(item => item.kind === "file" && this.matchesKind(item, optionalStr("kind")))
				const result = planOrganizeByDate({
					names: DRIVE_NAME_RULES,
					items: files.map(item => this.batchItem(item)),
					children: children.map(item => ({ id: item.handle, name: item.name, directory: item.kind === "directory" })),
					destinationNames: new Map(
						children
							.filter(item => item.kind === "directory")
							.map(item => [item.handle, this.children(item.handle).map(child => child.name)])
					),
					by: str("by") as BatchOrganizeBy,
					date: optionalStr("date") as BatchDateField | undefined,
					timeZone: EVAL_TIME_ZONE
				})

				if (!result.ok) {
					throw new CallError(result.error, result.invalid)
				}

				if (batchOrganizeCount(result.plan) === 0) {
					throw new CallError("No file to sort into a subdirectory; nothing to move", false)
				}

				let created = 0

				for (const group of result.plan.groups) {
					let destination = group.existing

					if (destination === undefined) {
						destination = this.nextHandle("d")
						created++
						this.state.drive.push({
							handle: destination,
							kind: "directory",
							name: group.directory,
							parent: directory.handle,
							size: 0,
							modified: "2025-10-07T12:00:00Z",
							favorite: false,
							trashed: false,
							shared: false
						})
					}

					for (const move of group.items) {
						const item = files.find(candidate => candidate.handle === move.id)

						if (item !== undefined) {
							item.name = move.to ?? item.name
							item.parent = destination
						}
					}
				}

				return {
					moved: batchOrganizeCount(result.plan),
					created,
					in: this.pathOf(directory),
					...(result.plan.skipped.length > 0
						? {
								skipped: result.plan.skipped.map(({ name: skippedName, reason }) => ({ name: skippedName, reason }))
							}
						: {})
				}
			}

			case "restore_items": {
				// Like the app: every handle resolves before anything changes, and only what is in the trash comes back.
				const targets = [...new Set(list("handles"))].map(handle => {
					const isNote = handle.startsWith("n")

					this.known(handle, isNote ? "note" : "drive")

					const item = isNote
						? this.state.notes.find(candidate => candidate.handle === handle)
						: this.state.drive.find(candidate => candidate.handle === handle)

					if (item === undefined) {
						throw new CallError(`"${handle}" is not a file, directory or note`, true)
					}

					if (!item.trashed) {
						throw new CallError(`"${"title" in item ? item.title : item.name}" is not in the trash`, false)
					}

					return item
				})

				for (const item of targets) {
					item.trashed = false
				}

				return {
					restored: targets.map(item => ("title" in item ? item.title : item.name))
				}
			}

			case "app_help": {
				// Settings and shortcuts in one ranking, as the app's index holds them.
				const settings = HELP_ROWS.flatMap(row => {
					const entry = APP_HELP.find(candidate => candidate.id === row.id)

					return entry !== undefined && (entry.platform === undefined || entry.platform === (this.desktop ? "desktop" : "web"))
						? [{ kind: "setting" as const, row, entry, words: [appHelpWords(row.title, row.description)] }]
						: []
				})
				const shortcuts = SHORTCUT_ROWS.map(row => ({
					kind: "shortcut" as const,
					row,
					words: [appHelpWords(row.shortcut, row.where)]
				}))
				const found = rankAppHelp(
					[...settings, ...shortcuts],
					str("query"),
					candidate => candidate.words,
					candidate => candidate.kind === "shortcut" && candidate.row.screen === this.state.context.screen
				)

				if (found.length === 0) {
					return {
						results: [],
						note: APP_HELP_NO_MATCH_NOTE
					}
				}

				return {
					results: found.map(found => {
						if (found.kind === "shortcut") {
							const { screen: _screen, ...row } = found.row

							return {
								...row,
								route: "settings_keyboard"
							}
						}

						const { row, entry } = found
						const handle = this.helpHandles.get(row.id) ?? `h${String(this.helpHandles.size + 1)}`

						this.helpHandles.set(row.id, handle)
						this.exposed.add(handle)

						return {
							handle,
							title: row.title,
							description: row.description,
							where: `Settings → ${HELP_SECTION_LABELS[entry.section]}`,
							route: entry.route
						}
					})
				}
			}

			case "get_desktop_status": {
				if (!this.desktop) {
					throw new CallError(DESKTOP_ONLY_ERROR, false)
				}

				if (str("section") === "mounts") {
					return mountsStatus(this.state.desktop.mounts)
				}

				return syncStatus({
					overview: this.state.desktop.sync,
					query: typeof input["query"] === "string" ? input["query"] : undefined,
					handle: pair => this.pairHandle(pair.id),
					remoteName: pair => this.state.desktop.remoteNames[pair.remoteRoot] ?? null,
					timeZone: EVAL_TIME_ZONE
				})
			}

			default: {
				throw new CallError(`Tool "${name}" is not implemented`, true)
			}
		}
	}

	// A drive file's text per page, sheet or slide; a text file's as one unit. Null for a file with none to read.
	private documentOf(item: DriveItem): FixtureDocument | null {
		if (item.document !== undefined) {
			return item.document
		}

		return TEXT_EXTENSIONS.includes(extension(item.name)) && item.content !== undefined
			? { kind: "text", units: [{ label: "text", text: item.content }] }
			: null
	}

	// As the web app's read_document (features/assistant/tools/documents.ts): the open document's selection, or the
	// units asked for, cut at DOCUMENT_READ_MAX_CHARS, as document units for the content extraction.
	private readDocument(input: Record<string, unknown>) {
		const item = this.driveItem(String(input["handle"]))

		if (item.kind !== "file") {
			throw new CallError(`"${item.name}" is a directory, not a document`, true)
		}

		const document = this.documentOf(item)

		if (document === null) {
			throw new CallError(
				UNREADABLE_DOCUMENT_EXTENSIONS.has(extension(item.name))
					? `"${item.name}" cannot be read here; the user can open it in the app`
					: `"${item.name}" is not a document this can read`,
				false
			)
		}

		// As the app: a text file is read_text_file's, except the selection in an open one (the fixture's text files are
		// all small enough for read_text_file).
		if (document.kind === "text" && input["part"] !== "selection") {
			throw new CallError(readWithTextFile(item.name), true)
		}

		const units = document.units.length
		const base = { handle: item.handle, name: item.name, kind: document.kind, units }

		if (input["part"] === "selection") {
			const open = this.state.context.openDocument

			if (open?.handle !== item.handle || open.selection === undefined || open.selection.length === 0) {
				throw new CallError(nothingSelected(item.name, document.kind), true)
			}

			return {
				...base,
				range: "the selection",
				content: [{ unit: 1, label: DOCUMENT_SELECTION_LABEL, text: open.selection.slice(0, DOCUMENT_READ_MAX_CHARS) }]
			}
		}

		let span = documentReadRange(input, units) ?? { from: 1, to: units }
		const sheet = typeof input["sheet"] === "string" ? input["sheet"].trim() : ""

		if (sheet.length > 0 && document.kind === "sheet") {
			const index = document.units.findIndex(unit => normalizeText(unit.label) === normalizeText(sheet))

			if (index === -1) {
				throw new CallError(`"${item.name}" has no sheet named "${sheet}"`, false)
			}

			span = { from: index + 1, to: index + 1 }
		}

		const content: { unit: number; label: string; text: string }[] = []
		let room = DOCUMENT_READ_MAX_CHARS
		let truncated = false

		for (let unit = span.from; unit <= span.to; unit++) {
			const entry = document.units[unit - 1]

			if (entry === undefined || room <= 0) {
				truncated = entry !== undefined
				break
			}

			const text = entry.text.slice(0, room)

			content.push({ unit, label: entry.label, text })
			// A blank line between units, as the app's readers join them.
			room -= text.length + 2
			truncated = text.length < entry.text.length
		}

		return {
			...base,
			range: documentRangeText(document.kind, span.from, span.to, units),
			content,
			...(truncated ? { truncated: true } : {})
		}
	}

	private chat(handle: string) {
		this.known(handle, "chat")

		const item = this.state.chats.find(candidate => candidate.handle === handle)

		if (item === undefined) {
			throw new CallError(`"${handle}" is not a chat`, true)
		}

		return item
	}

	private playlist(handle: string) {
		this.known(handle, "playlist")

		const item = this.state.playlists.find(candidate => candidate.handle === handle)

		if (item === undefined) {
			throw new CallError(`"${handle}" is not a playlist`, true)
		}

		return item
	}
}
