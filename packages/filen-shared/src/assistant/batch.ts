import { localIsoDay } from "./dates"

// The batch tools' plans (rename_by_pattern, organize_by_date), worked out in code: the model picks a scheme and a
// scope, never a name, a date or a count. Pure, so the apps and the eval's fake app plan alike.

// Files one request may rename or sort; more is refused, never cut.
export const BATCH_MAX_ITEMS = 500

export const BATCH_DATE_FIELDS = ["taken", "created", "modified", "uploaded"] as const

export type BatchDateField = (typeof BATCH_DATE_FIELDS)[number]

export const BATCH_RENAME_SCHEMES = ["date_prefix", "date_name", "number", "add_prefix", "add_suffix", "replace_text", "lowercase"] as const

export type BatchRenameScheme = (typeof BATCH_RENAME_SCHEMES)[number]

export const BATCH_ORGANIZE_BY = ["year", "month", "day"] as const

export type BatchOrganizeBy = (typeof BATCH_ORGANIZE_BY)[number]

// A file of the batch. Dates are instants (ms); a date the file does not carry is left out. `taken` is a photo's or
// video's capture date, `uploaded` the server's own and always known. `parent` keys the directory it sits in.
export interface BatchItem {
	id: string
	name: string
	parent: string
	uploaded: number
	taken?: number | undefined
	created?: number | undefined
	modified?: number | undefined
}

// Why a file stays as it is: the new name is not a valid one, or a file holds the name its subdirectory needs.
export type BatchSkipReason = "invalid-name" | "destination-is-file"

export interface BatchSkip {
	id: string
	name: string
	reason: BatchSkipReason
}

export interface BatchRenameChange {
	id: string
	parent: string
	from: string
	to: string
	// Took " (2)", " (3)"… because the name was taken.
	suffixed: boolean
}

export interface BatchRenamePlan {
	changes: BatchRenameChange[]
	skipped: BatchSkip[]
}

export interface BatchOrganizeMove {
	id: string
	from: string
	// The name it moves under when its own is taken in the subdirectory.
	to?: string
}

export interface BatchOrganizeGroup {
	// The subdirectory's name: an existing one's own spelling.
	directory: string
	// The existing subdirectory's id; absent for one the batch creates.
	existing?: string
	items: BatchOrganizeMove[]
}

export interface BatchOrganizePlan {
	groups: BatchOrganizeGroup[]
	skipped: BatchSkip[]
}

// How the names of one directory relate: `key` is what two colliding names share, `compare` the drive's name order.
// The apps and the eval pass @filen/shared's DRIVE_NAME_RULES, so every planner call collides and orders alike.
export interface BatchNameRules {
	key: (name: string) => string
	compare: (a: string, b: string) => number
}

export type BatchPlanResult<Plan> = { ok: true; plan: Plan } | { ok: false; error: string }

// The date a file is named or sorted by: the asked one, else the first it carries of taken, created, modified, and
// the upload as the last resort.
export function batchDate(item: BatchItem, field: BatchDateField = "taken"): number {
	return item[field] ?? item.taken ?? item.created ?? item.modified ?? item.uploaded
}

function extensionDot(name: string): number {
	const dot = name.lastIndexOf(".")

	return dot > 0 && dot < name.length - 1 ? dot : -1
}

function splitName(name: string): { stem: string; extension: string } {
	const dot = extensionDot(name)

	return dot === -1 ? { stem: name, extension: "" } : { stem: name.slice(0, dot), extension: name.slice(dot) }
}

function validName(name: string): boolean {
	const trimmed = name.trim()

	return trimmed.length > 0 && trimmed !== "." && trimmed !== ".." && !name.includes("/")
}

// "photo.jpg" → "photo (2).jpg", "(3)"… until `free` takes it.
function suffixedName(name: string, free: (name: string) => boolean): string {
	const { stem, extension } = splitName(name)

	for (let n = 2; ; n++) {
		const candidate = `${stem} (${String(n)})${extension}`

		if (free(candidate)) {
			return candidate
		}
	}
}

function byName(names: BatchNameRules): (a: BatchItem, b: BatchItem) => number {
	return (a, b) => names.compare(a.name, b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

export interface BatchRenameRequest {
	names: BatchNameRules
	items: readonly BatchItem[]
	// Every name each parent directory holds now, the batch's own files included.
	taken: ReadonlyMap<string, readonly string[]>
	scheme: BatchRenameScheme
	date?: BatchDateField | undefined
	text?: string | undefined
	find?: string | undefined
	timeZone?: string | undefined
}

// The new name a scheme gives a file; null when it needs an argument the call left out.
function schemeName(
	request: BatchRenameRequest,
	item: BatchItem,
	index: number,
	width: number
): { ok: true; name: string } | { ok: false; error: string } {
	const { stem, extension } = splitName(item.name)
	const text = request.text ?? ""
	const day = () => localIsoDay(batchDate(item, request.date), request.timeZone)

	switch (request.scheme) {
		case "date_prefix": {
			const prefix = `${day()} `

			return { ok: true, name: item.name.startsWith(prefix) ? item.name : `${prefix}${item.name}` }
		}
		case "date_name":
			return { ok: true, name: `${day()}${extension}` }
		case "number": {
			const number = String(index + 1).padStart(width, "0")

			return { ok: true, name: text.trim().length > 0 ? `${text.trim()} ${number}${extension}` : `${number} ${item.name}` }
		}
		case "add_prefix":
			return text.length === 0
				? { ok: false, error: "Pass the text to add as text" }
				: { ok: true, name: item.name.startsWith(text) ? item.name : `${text}${item.name}` }
		case "add_suffix":
			return text.length === 0
				? { ok: false, error: "Pass the text to add as text" }
				: { ok: true, name: stem.endsWith(text) ? item.name : `${stem}${text}${extension}` }
		case "replace_text": {
			const find = request.find ?? ""

			return find.length === 0
				? { ok: false, error: "Pass the text to replace as find" }
				: { ok: true, name: `${stem.replace(new RegExp(escapeRegExp(find), "giu"), () => text)}${extension}` }
		}
		case "lowercase":
			return { ok: true, name: item.name.toLowerCase() }
	}
}

// Every file's new name, in name order. A name another item of its directory holds, or one the batch already gave,
// takes " (2)", " (3)"…: the batch's own files count by their current names too, so no rename waits on another. A
// file whose name would not change drops out.
export function planBatchRename(request: BatchRenameRequest): BatchPlanResult<BatchRenamePlan> {
	if (request.items.length > BATCH_MAX_ITEMS) {
		return {
			ok: false,
			error: `That is ${String(request.items.length)} files; at most ${String(BATCH_MAX_ITEMS)} can be renamed at once. Narrow it down (a kind, or fewer files).`
		}
	}

	const { key: nameCollisionKey } = request.names
	const items = [...request.items].sort(byName(request.names))
	const width = String(items.length).length
	const occupied = new Map<string, Set<string>>()
	const changes: BatchRenameChange[] = []
	const skipped: BatchSkip[] = []

	for (const [index, item] of items.entries()) {
		const named = schemeName(request, item, index, width)

		if (!named.ok) {
			return named
		}

		if (named.name === item.name) {
			continue
		}

		if (!validName(named.name)) {
			skipped.push({ id: item.id, name: item.name, reason: "invalid-name" })

			continue
		}

		let taken = occupied.get(item.parent)

		if (taken === undefined) {
			taken = new Set((request.taken.get(item.parent) ?? []).map(nameCollisionKey))
			occupied.set(item.parent, taken)
		}

		const own = nameCollisionKey(item.name)
		const free = (name: string) => {
			const key = nameCollisionKey(name)

			return key === own || !taken.has(key)
		}
		const to = free(named.name) ? named.name : suffixedName(named.name, free)

		taken.add(nameCollisionKey(to))

		if (to !== item.name) {
			changes.push({ id: item.id, parent: item.parent, from: item.name, to, suffixed: to !== named.name })
		}
	}

	return { ok: true, plan: { changes, skipped } }
}

export interface BatchOrganizeRequest {
	names: BatchNameRules
	// The scope directory's files to sort.
	items: readonly BatchItem[]
	// Everything the scope directory holds now: its files and its subdirectories.
	children: readonly { id: string; name: string; directory: boolean }[]
	// The names each existing subdirectory the batch reuses holds, by its id.
	destinationNames: ReadonlyMap<string, readonly string[]>
	by: BatchOrganizeBy
	date?: BatchDateField | undefined
	timeZone?: string | undefined
}

const DAY_CHARS: Readonly<Record<BatchOrganizeBy, number>> = { year: 4, month: 7, day: 10 }

// The subdirectories a directory's files go into, each named by the ISO year, month or day of the file's date. An
// existing subdirectory of that name is reused; a file holding the name skips its files. A file whose name its
// subdirectory already holds moves under " (2)", " (3)"…, a name free in the directory it leaves too (it is renamed
// there first).
export function planOrganizeByDate(request: BatchOrganizeRequest): BatchPlanResult<BatchOrganizePlan> {
	if (request.items.length > BATCH_MAX_ITEMS) {
		return {
			ok: false,
			error: `That is ${String(request.items.length)} files; at most ${String(BATCH_MAX_ITEMS)} can be sorted at once. Narrow it down (a kind).`
		}
	}

	const { key: nameCollisionKey, compare } = request.names
	const children = new Map(request.children.map(child => [nameCollisionKey(child.name), child]))
	const sourceTaken = new Set(request.children.map(child => nameCollisionKey(child.name)))
	const groups = new Map<string, { group: BatchOrganizeGroup; taken: Set<string> }>()
	const skipped: BatchSkip[] = []

	for (const item of [...request.items].sort(byName(request.names))) {
		const directory = localIsoDay(batchDate(item, request.date), request.timeZone).slice(0, DAY_CHARS[request.by])
		const key = nameCollisionKey(directory)
		const existing = children.get(key)

		if (existing !== undefined && !existing.directory) {
			skipped.push({ id: item.id, name: item.name, reason: "destination-is-file" })

			continue
		}

		let entry = groups.get(key)

		if (entry === undefined) {
			entry = {
				group: existing === undefined ? { directory, items: [] } : { directory: existing.name, existing: existing.id, items: [] },
				taken: new Set((existing === undefined ? [] : (request.destinationNames.get(existing.id) ?? [])).map(nameCollisionKey))
			}
			groups.set(key, entry)
		}

		const { group, taken } = entry

		if (!taken.has(nameCollisionKey(item.name))) {
			taken.add(nameCollisionKey(item.name))
			group.items.push({ id: item.id, from: item.name })

			continue
		}

		const to = suffixedName(item.name, name => !taken.has(nameCollisionKey(name)) && !sourceTaken.has(nameCollisionKey(name)))

		taken.add(nameCollisionKey(to))
		sourceTaken.add(nameCollisionKey(to))
		group.items.push({ id: item.id, from: item.name, to })
	}

	return {
		ok: true,
		plan: {
			groups: [...groups.values()].map(entry => entry.group).sort((a, b) => compare(a.directory, b.directory)),
			skipped
		}
	}
}

// How many files a sort moves.
export function batchOrganizeCount(plan: BatchOrganizePlan): number {
	return plan.groups.reduce((sum, group) => sum + group.items.length, 0)
}
