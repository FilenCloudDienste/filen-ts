// A multi-file format's references (a model's materials and textures) resolved against the directory it sits in: the
// path rules, and a walk over listings that lists each directory once, and only when a reference names it. Nothing
// above the model's directory is ever reached.

// The segments a reference names below the model's directory, or null for one that climbs above it or names nothing.
// Percent-encoding is decoded and `\` read as `/`; `.` segments drop and `..` climbs. An absolute path (`/x`, `C:\x`,
// `file:///x`: written by the exporting machine) names the file by its base name in the model's directory.
export function referenceSegments(raw: string): string[] | null {
	let path: string

	try {
		path = decodeURIComponent(raw)
	} catch {
		path = raw
	}

	path = path.replace(/\\/g, "/")

	const absolute = /^(?:[a-z][a-z0-9+.-]*:)?\//i.test(path) || /^[a-z]:\//i.test(path)
	const parts = path.split("/").filter(part => part !== "" && part !== ".")

	if (absolute) {
		const name = parts.at(-1)

		return name === undefined || name === ".." ? null : [name]
	}

	const segments: string[] = []

	for (const part of parts) {
		if (part === "..") {
			if (segments.length === 0) return null

			segments.pop()
		} else {
			segments.push(part)
		}
	}

	return segments.length === 0 ? null : segments
}

// Distinct files a model may reference; the rest are not looked up.
export const MAX_REFERENCES = 256

// One key per file however a model spells its path: normalised, in one case and Unicode form.
export function referenceKey(path: string): string {
	const segments = referenceSegments(path)

	return segments === null ? path : segments.map(nameKey).join("/")
}

// A loader's references, each file asked for once however often it is named, at most MAX_REFERENCES of them; the rest
// are counted and not asked for.
export function onceEach<T>(ask: (path: string) => Promise<T | null>): {
	readonly ask: (path: string) => Promise<T | null>
	readonly unlisted: () => number
} {
	const asked = new Map<string, Promise<T | null>>()
	let unlisted = 0

	return {
		ask: path => {
			const key = referenceKey(path)
			const known = asked.get(key)

			if (known !== undefined) return known

			if (asked.size >= MAX_REFERENCES) {
				unlisted++

				return Promise.resolve(null)
			}

			const asking = ask(path)

			asked.set(key, asking)

			return asking
		},
		unlisted: () => unlisted
	}
}

// Names compare case-insensitively (exporters and file systems disagree on case) and in one Unicode form.
export function nameKey(name: string): string {
	return name.normalize("NFC").toLowerCase()
}

export interface ReferenceListing<D, F> {
	readonly dirs: readonly (readonly [name: string, dir: D])[]
	// Null: listed, but not readable on its own (an archive's entry the SDK cannot extract alone).
	readonly files: readonly (readonly [name: string, file: F | null])[]
}

export type ReferenceLookup<F> =
	| { readonly status: "found"; readonly file: F }
	| { readonly status: "missing" }
	| { readonly status: "unreadable" }
	// Climbs above the model's directory.
	| { readonly status: "refused" }

interface IndexedListing<D, F> {
	readonly dirs: Map<string, D>
	readonly files: Map<string, F | null>
}

function indexed<D, F>(listing: ReferenceListing<D, F>): IndexedListing<D, F> {
	const dirs = new Map<string, D>()
	const files = new Map<string, F | null>()

	// The first of two names that differ only in case wins.
	for (const [name, dir] of listing.dirs) if (!dirs.has(nameKey(name))) dirs.set(nameKey(name), dir)
	for (const [name, file] of listing.files) if (!files.has(nameKey(name))) files.set(nameKey(name), file)

	return { dirs, files }
}

// Looks references up through `root` (the model's directory) and `child` (a directory below it), each listing read at
// most once however many references name it; a failed listing counts as an empty one.
export function referenceWalker<D, F>(
	root: () => Promise<ReferenceListing<D, F>>,
	child: (dir: D) => Promise<ReferenceListing<D, F>>
): (raw: string) => Promise<ReferenceLookup<F>> {
	const listings = new Map<string, Promise<IndexedListing<D, F> | null>>()
	const empty: IndexedListing<D, F> = { dirs: new Map(), files: new Map() }

	function listingAt(segments: readonly string[]): Promise<IndexedListing<D, F> | null> {
		const key = segments.map(nameKey).join("/")
		const known = listings.get(key)

		if (known !== undefined) return known

		const parentSegments = segments.slice(0, -1)
		const last = segments.at(-1)
		const listing =
			last === undefined
				? root().then(indexed, () => empty)
				: listingAt(parentSegments).then(parent => {
						const dir = parent?.dirs.get(nameKey(last))

						return dir === undefined ? null : child(dir).then(indexed, () => empty)
					})

		listings.set(key, listing)

		return listing
	}

	return async raw => {
		const segments = referenceSegments(raw)

		if (segments === null) return { status: "refused" }

		const name = segments.at(-1) ?? ""
		const listing = await listingAt(segments.slice(0, -1))
		const file = listing?.files.get(nameKey(name))

		if (file === undefined) return { status: "missing" }

		return file === null ? { status: "unreadable" } : { status: "found", file }
	}
}
