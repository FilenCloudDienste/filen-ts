import path from "node:path"
import { type } from "arktype"
import { absolutePathSchema, transferIdSchema } from "../../shared/nativeProtocol.ts"
import { serialQueue } from "../../shared/serial.ts"
import { type AtomicFile, errorCode } from "../atomicFile.ts"

// The staging files of the downloads in flight, kept on disk so a start after an unclean exit (a crash, a killed host)
// removes what neither the host nor the SDK could: our `<id>.filendl` staging names and the SDK's `<file uuid>.filendl`
// temps. Only uuid-stem `.filendl` regular files are ever removed; a symlink or a user's own file never is.

// `names`: files in `dir`. `tree`: `dir` is a downloaded directory, walked (never through links) for uuid-stem temps.
export interface StagingEntry {
	id: string
	dir: string
	names: readonly string[]
	tree: boolean
}

export interface JournalFs {
	lstat(path: string): Promise<{ isFile(): boolean; isDirectory(): boolean }>
	unlink(path: string): Promise<void>
	// withFileTypes: a symlink is neither a file nor a directory here.
	readdir(path: string): Promise<{ name: string; isFile(): boolean; isDirectory(): boolean }[]>
}

export interface StagingJournal {
	add(entries: readonly StagingEntry[]): void
	// Settled by the host, which cleaned up itself: forgotten.
	remove(ids: readonly string[]): void
	// Ended without the host (interrupted, signed out, never started): their files are removed, then forgotten. One
	// that cannot be removed now (in use) stays for the next startup's sweep.
	discard(ids: readonly string[]): Promise<void>
	// At startup, before the host can start: removes what the last run left.
	sweep(): Promise<void>
}

const STAGING_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.filendl$/i

const storedSchema = type({
	id: transferIdSchema,
	dir: absolutePathSchema,
	names: type("string")
		.narrow(name => STAGING_NAME.test(name))
		.array(),
	tree: "boolean",
	"+": "delete"
}).array()

function missing(error: unknown): boolean {
	return errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR"
}

export function createStagingJournal(deps: {
	file: AtomicFile
	fs: JournalFs
	// Runs the write after the current round of changes (main: setImmediate).
	schedule(run: () => void): void
	log: { warn(message: string): void }
}): StagingJournal {
	const { file, fs, log } = deps
	const entries = new Map<string, StagingEntry>()
	const writes = serialQueue()
	let scheduled = false
	// What the file holds is not known to be empty (an earlier run's entries, or ours).
	let written = true

	function write(): Promise<void> {
		return writes(async () => {
			if (entries.size === 0) {
				if (written) {
					await file.remove()
					written = false
				}

				return
			}

			await file.write(Buffer.from(JSON.stringify([...entries.values()])))
			written = true
		}).catch((error: unknown) => {
			log.warn(`transfers: staging journal not written: ${errorCode(error)}`)
		})
	}

	function changed(): void {
		if (!scheduled) {
			scheduled = true
			deps.schedule(() => {
				scheduled = false
				void write()
			})
		}
	}

	async function removeFile(target: string): Promise<boolean> {
		try {
			if (!(await fs.lstat(target)).isFile()) {
				return true
			}

			await fs.unlink(target)

			return true
		} catch (error) {
			if (missing(error)) {
				return true
			}

			log.warn(`transfers: staging file ${target} not removed: ${errorCode(error)}`)

			return false
		}
	}

	// Depth first with an explicit stack; directories are entered only as readdir reports them (never a link), the root
	// only when it lstats as a directory.
	async function sweepTree(root: string): Promise<boolean> {
		try {
			if (!(await fs.lstat(root)).isDirectory()) {
				return true
			}
		} catch (error) {
			if (missing(error)) {
				return true
			}

			log.warn(`transfers: ${root} not swept: ${errorCode(error)}`)

			return false
		}

		const stack = [root]
		let clean = true

		for (let dir = stack.pop(); dir !== undefined; dir = stack.pop()) {
			let children: Awaited<ReturnType<JournalFs["readdir"]>>

			try {
				children = await fs.readdir(dir)
			} catch (error) {
				if (!missing(error)) {
					log.warn(`transfers: ${dir} not swept: ${errorCode(error)}`)
					clean = false
				}

				continue
			}

			for (const child of children) {
				const target = path.join(dir, child.name)

				if (child.isDirectory()) {
					stack.push(target)
				} else if (child.isFile() && STAGING_NAME.test(child.name)) {
					clean = (await removeFile(target)) && clean
				}
			}
		}

		return clean
	}

	async function clean(entry: StagingEntry): Promise<boolean> {
		let done = true

		for (const name of entry.names) {
			if (STAGING_NAME.test(name)) {
				done = (await removeFile(path.join(entry.dir, name))) && done
			}
		}

		return entry.tree ? (await sweepTree(entry.dir)) && done : done
	}

	return {
		add: added => {
			for (const entry of added) {
				entries.set(entry.id, entry)
			}

			if (added.length > 0) {
				changed()
			}
		},
		remove: ids => {
			let any = false

			for (const id of ids) {
				any = entries.delete(id) || any
			}

			if (any) {
				changed()
			}
		},
		discard: async ids => {
			const listed = ids.flatMap(id => entries.get(id) ?? [])
			const results = await Promise.all(listed.map(clean))

			listed.forEach((entry, index) => {
				if (results[index] === true && entries.get(entry.id) === entry) {
					entries.delete(entry.id)
				}
			})

			if (listed.length > 0) {
				changed()
			}
		},
		sweep: async () => {
			let stored: typeof storedSchema.infer = []

			try {
				const data = await file.read()
				const parsed = data === null ? [] : storedSchema(JSON.parse(data.toString("utf8")))

				if (parsed instanceof type.errors) {
					log.warn("transfers: staging journal unreadable; dropped")
				} else {
					stored = parsed
				}
			} catch (error) {
				log.warn(`transfers: staging journal unreadable (${errorCode(error)}); dropped`)
			}

			for (const entry of stored) {
				// Kept for the next start when something could not be removed.
				if (!entries.has(entry.id) && !(await clean(entry))) {
					entries.set(entry.id, entry)
				}
			}

			await write()
		}
	}
}
