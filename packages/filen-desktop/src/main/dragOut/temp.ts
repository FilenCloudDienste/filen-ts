import { lstatSync, rmSync, type Stats } from "node:fs"
import { lstat, mkdir, mkdtemp, readdir, rm } from "node:fs/promises"
import path from "node:path"

// Where drag-out copies live until the OS has them: one directory per session under a root in userData (per app
// identity, so "Filen Dev" and "Filen" never share one), never in a shared temp directory another user can write.
// The root is lstat-checked before each use, and only `s-` session directories, lstat-checked themselves, are removed.

export interface DragTemp {
	// The session's directory (0700), made on first use.
	sessionDir(id: string): Promise<string>
	// Inside the session's directory, parents first.
	makeDirectories(id: string, relativePaths: readonly string[]): Promise<void>
	deleteLater(id: string, afterMs: number): void
	deleteNow(id: string): Promise<void>
	// At startup: the session directories an earlier run left, older than `olderThanMs`.
	sweep(olderThanMs: number): Promise<void>
	// Sign-out, once nothing writes them: this run's session directories, those still being made or deleted later
	// included. Sessions made afterwards work as before.
	removeAll(): Promise<void>
	// At quit, once nothing writes them: this run's own session directories. No session directory is made afterwards;
	// one whose mkdtemp is still in flight is removed when it lands, or by the next start's sweep if the app exits first.
	removeAllSync(): void
}

export interface DragTempDeps {
	// join(app.getPath("userData"), "drag-out")
	root: string
	// Our uid (POSIX); null on Windows, where owner and mode are not checked.
	uid: number | null
	now(): number
	setTimer(run: () => void, ms: number): () => void
	log: { warn(message: string): void }
}

const SESSION_PREFIX = "s-"

// mkdtemp appends six characters.
const SESSION_NAME = /^s-[A-Za-z0-9]{6}$/

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

function errorCode(error: unknown): unknown {
	return typeof error === "object" && error !== null && "code" in error ? error.code : undefined
}

export function createDragTemp(deps: DragTempDeps): DragTemp {
	const { root, uid, log } = deps
	// This run's session directories by session id: being made, and made (what the synchronous quit removes).
	const dirs = new Map<string, Promise<string>>()
	const made = new Map<string, string>()
	const timers = new Map<string, () => void>()
	let stopped = false

	// Ours: a real directory (no symlink) of our uid, open to no one else.
	function ours(stats: Stats): boolean {
		return stats.isDirectory() && !stats.isSymbolicLink() && (uid === null || (stats.uid === uid && (stats.mode & 0o077) === 0))
	}

	// False when the root is missing and `create` is not set; throws when it is not ours.
	async function checkedRoot(create: boolean): Promise<boolean> {
		let stats: Stats

		try {
			stats = await lstat(root)
		} catch (error) {
			if (errorCode(error) !== "ENOENT") {
				throw error
			}

			if (!create) {
				return false
			}

			await mkdir(root, { mode: 0o700 })
			stats = await lstat(root)
		}

		if (!ours(stats)) {
			throw new Error(`drag-out: ${root} is not a private directory of ours`)
		}

		return true
	}

	async function removeSession(dir: string): Promise<void> {
		if (ours(await lstat(dir))) {
			await rm(dir, { recursive: true, force: true })
		}
	}

	async function remove(id: string, pending: Promise<string>): Promise<void> {
		try {
			await removeSession(await pending)

			if (dirs.get(id) === pending) {
				dirs.delete(id)
				made.delete(id)
			}
		} catch (error) {
			// Kept for removeAllSync (a file the OS still holds open).
			log.warn(`drag-out: session temp not removed: ${message(error)}`)
		}
	}

	async function deleteNow(id: string): Promise<void> {
		timers.get(id)?.()
		timers.delete(id)

		const pending = dirs.get(id)

		if (pending !== undefined) {
			await remove(id, pending)
		}
	}

	function stopTimers(): void {
		for (const cancel of timers.values()) {
			cancel()
		}

		timers.clear()
	}

	return {
		sessionDir: id => {
			if (stopped) {
				return Promise.reject(new Error("drag-out: quitting"))
			}

			let pending = dirs.get(id)

			if (pending === undefined) {
				const created = checkedRoot(true)
					.then(() => mkdtemp(path.join(root, SESSION_PREFIX)))
					.then(dir => {
						if (stopped) {
							rmSync(dir, { recursive: true, force: true })

							throw new Error("drag-out: quitting")
						}

						if (dirs.get(id) === created) {
							made.set(id, dir)
						}

						return dir
					})

				pending = created
				dirs.set(id, created)
				created.catch(() => {
					if (dirs.get(id) === created) {
						dirs.delete(id)
					}
				})
			}

			return pending
		},
		makeDirectories: async (id, relativePaths) => {
			const dir = made.get(id)

			if (dir === undefined) {
				throw new Error("drag-out: no session directory")
			}

			for (const relativePath of relativePaths) {
				await mkdir(path.join(dir, relativePath), { mode: 0o700 })
			}
		},
		deleteLater: (id, afterMs) => {
			timers.get(id)?.()
			timers.set(
				id,
				deps.setTimer(() => {
					timers.delete(id)
					void deleteNow(id)
				}, afterMs)
			)
		},
		deleteNow,
		sweep: async olderThanMs => {
			try {
				if (!(await checkedRoot(false))) {
					return
				}

				// A session made meanwhile is younger than any cut-off.
				const own = new Set(made.values())
				const before = deps.now() - olderThanMs

				for (const entry of await readdir(root, { withFileTypes: true })) {
					const dir = path.join(root, entry.name)

					// A symlink is not a directory here.
					if (!entry.isDirectory() || !SESSION_NAME.test(entry.name) || own.has(dir)) {
						continue
					}

					try {
						const stats = await lstat(dir)

						if (ours(stats) && stats.mtimeMs < before) {
							await rm(dir, { recursive: true, force: true })
						}
					} catch (error) {
						log.warn(`drag-out: ${dir} not swept: ${message(error)}`)
					}
				}
			} catch (error) {
				log.warn(`drag-out: temp not swept: ${message(error)}`)
			}
		},
		removeAll: async () => {
			stopTimers()
			await Promise.all([...dirs].map(([id, pending]) => remove(id, pending)))
		},
		removeAllSync: () => {
			stopped = true
			stopTimers()

			for (const dir of made.values()) {
				try {
					if (ours(lstatSync(dir))) {
						rmSync(dir, { recursive: true, force: true })
					} else {
						log.warn(`drag-out: ${dir} is not ours; not removed`)
					}
				} catch (error) {
					log.warn(`drag-out: ${dir} not removed: ${message(error)}`)
				}
			}

			dirs.clear()
			made.clear()
		}
	}
}
