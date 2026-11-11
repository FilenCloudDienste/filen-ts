import path from "node:path"
import { describe, expect, it } from "vitest"
import type { DesktopDownloadItem, DesktopDragState, DesktopTransferResult, DesktopTransferStart } from "@filen/shared/desktop"
import { type DragSessionEffects, DragSessions } from "../main/dragOut/session.ts"
import type { DragTemp } from "../main/dragOut/temp.ts"
import type { DownloadDestination, DownloadWatch, NativeDownloadItem } from "../main/transfers/service.ts"
import type { NativeTreeEntry } from "../shared/nativeProtocol.ts"

const MIB = 1024 ** 2

function item(name: string, kind: "file" | "directory" = "file", size = 10): DesktopDownloadItem {
	return { kind, ref: { variant: kind === "file" ? "AnyFile.File" : "AnyNormalDir.Dir", value: `{"name":"${name}"}` }, name, size }
}

function fileEntry(segments: string[], listIndex: number | null, size = 10, source = 0): NativeTreeEntry {
	return { segments, directory: false, size, mtimeMs: null, listIndex, source }
}

function dirEntry(segments: string[], source = 0): NativeTreeEntry {
	return { segments, directory: true, size: 0, mtimeMs: null, listIndex: null, source }
}

interface Started {
	id: string
	path: string
	watch: DownloadWatch
	kind: "ref" | "listed"
	index: number | null
	items: readonly NativeDownloadItem[]
	destination: DownloadDestination | null
}

const flush = async () => {
	for (let i = 0; i < 10; i++) {
		await Promise.resolve()
	}
}

function fakes(options: { tree?: NativeTreeEntry[] | { tooMany: number }; startError?: boolean } = {}) {
	const calls: string[] = []
	const started: Started[] = []
	const cancelled: string[] = []
	const released: string[] = []
	const listings: { listingId: string; maxEntries: number }[] = []
	const states: DesktopDragState[] = []
	const timers = new Map<number, { run: () => void; at: number }>()
	const deleted: { id: string; later: number | null }[] = []
	const directories: string[][] = []
	let clock = 0
	let nextTimer = 0
	let nextTransfer = 0
	const started$ = (entry: Omit<Started, "id">): DesktopTransferResult<DesktopTransferStart> => {
		if (options.startError === true) {
			return { ok: false, error: { code: "hostUnavailable" } }
		}

		const id = `t${nextTransfer++}`

		started.push({ id, ...entry })

		return { ok: true, value: { status: "started", ids: [id] } }
	}
	const temp: DragTemp = {
		sessionDir: id => Promise.resolve(`/temp/s-${id}`),
		makeDirectories: (_id, relativePaths) => {
			directories.push([...relativePaths])

			return Promise.resolve()
		},
		deleteLater: (id, afterMs) => {
			deleted.push({ id, later: afterMs })
		},
		deleteNow: id => {
			deleted.push({ id, later: null })

			return Promise.resolve()
		},
		sweep: () => Promise.resolve(),
		removeAll: () => {
			calls.push("removeAll")

			return Promise.resolve()
		},
		removeAllSync: () => {
			calls.push("removeAllSync")
		}
	}
	const effects: DragSessionEffects = {
		transfers: {
			startDownload: request => {
				const [only] = request.items
				const destination = request.destination

				calls.push("startDownload")

				return Promise.resolve(
					started$({
						path: destination.kind === "exact" ? destination.path : "",
						watch: request.watch ?? { onSettled: () => undefined },
						kind: "ref",
						index: null,
						items: only === undefined ? [] : [only],
						destination
					})
				)
			},
			startListedDownload: request => {
				calls.push("startListedDownload")

				const results = request.entries.map(entry =>
					started$({ path: entry.path, watch: request.watch, kind: "listed", index: entry.index, items: [], destination: null })
				)
				const failed = results.find(result => !result.ok)

				return Promise.resolve(
					failed ??
						({
							ok: true,
							value: {
								status: "started",
								ids: results.flatMap(result => (result.ok && result.value.status === "started" ? result.value.ids : []))
							}
						} as const)
				)
			},
			listTree: request => {
				calls.push("listTree")
				listings.push({ listingId: request.listingId, maxEntries: request.maxEntries })

				const tree = options.tree ?? []

				return Promise.resolve({ ok: true, value: Array.isArray(tree) ? { entries: tree } : tree })
			},
			releaseTree: listingId => {
				released.push(listingId)
			},
			cancel: ids => {
				cancelled.push(...ids)
			}
		},
		temp,
		emit: state => {
			states.push(state)
		},
		now: () => clock,
		setTimer: (run, ms) => {
			const id = nextTimer++

			timers.set(id, { run, at: clock + ms })

			return () => {
				timers.delete(id)
			}
		}
	}
	const advance = (ms: number) => {
		clock += ms

		for (const [id, timer] of [...timers]) {
			if (timer.at <= clock) {
				timers.delete(id)
				timer.run()
			}
		}
	}
	const settle = (transfer: Started, outcome: "done" | "error" | "cancelled") => {
		transfer.watch.onSettled({ id: transfer.id, outcome, path: transfer.path })
	}

	return {
		effects,
		calls,
		started,
		cancelled,
		released,
		listings,
		states,
		deleted,
		directories,
		advance,
		settle,
		timers,
		now: () => clock
	}
}

function idOf(prepared: Awaited<ReturnType<DragSessions["prepare"]>>): string {
	if (!("id" in prepared)) {
		throw new Error(`refused: ${prepared.refused.reason}`)
	}

	return prepared.id
}

describe("drag sessions: staged", () => {
	it("prepare → notReady while staging → ready → ended", async () => {
		const f = fakes({
			tree: [fileEntry(["a.txt"], null, 4), dirEntry(["d"], 1), fileEntry(["d", "b"], 0, 6, 1), dirEntry(["d", "e"], 1)]
		})
		const sessions = new DragSessions(f.effects, "linux", "staged")
		const id = idOf(await sessions.prepare(1, [item("a.txt", "file", 4), item("d", "directory")]))

		expect(f.listings).toEqual([{ listingId: expect.any(String) as unknown, maxEntries: 2_000 }])
		expect(f.directories).toEqual([["d", "d/e"]])
		expect(f.started.map(s => [s.kind, s.path, s.index])).toEqual([
			["ref", `/temp/s-${id}/a.txt`, null],
			["listed", `/temp/s-${id}/d/b`, 0]
		])
		expect(f.started[0]?.destination).toEqual({ kind: "exact", path: `/temp/s-${id}/a.txt`, conflict: "replace" })
		expect(sessions.beginnable(1, id)).toBe("notReady")
		expect(sessions.live()).toBe(1)

		f.started[0]?.watch.onProgress?.("t0", 2, 4)
		f.advance(300)
		f.started[1]?.watch.onProgress?.("t1", 3, 6)

		// At most one staging state per 250 ms.
		expect(f.states).toEqual([
			{ id, state: "staging", bytes: 0, total: 10 },
			{ id, state: "staging", bytes: 5, total: 10 }
		])

		f.started[1]?.watch.onProgress?.("t1", 4, 6)
		expect(f.states).toHaveLength(2)

		for (const transfer of f.started) {
			f.settle(transfer, "done")
		}

		expect(f.states.at(-1)).toEqual({ id, state: "ready" })
		expect(sessions.beginnable(1, id)).toBe("ready")
		// Staged: the listing is released once every file is on disk.
		expect(f.released).toEqual([f.listings[0]?.listingId])
		expect(sessions.live()).toBe(0)
		expect(sessions.payload(1, id)).toEqual({ mode: "staged", paths: [`/temp/s-${id}/a.txt`, `/temp/s-${id}/d`] })
		expect(sessions.markBegun(id)).toBe(true)

		sessions.ended(id, "ended")

		expect(f.states.at(-1)).toEqual({ id, state: "ended", outcome: "ended" })
		expect(f.released).toEqual([f.listings[0]?.listingId])
		expect(sessions.live()).toBe(0)
		expect(sessions.beginnable(1, id)).toBe("unknown")
	})

	it("top-level files past 512 MiB are refused without a listing", async () => {
		const f = fakes()
		const sessions = new DragSessions(f.effects, "linux", "staged")

		expect(await sessions.prepare(1, [item("a", "file", 300 * MIB), item("b", "file", 300 * MIB)])).toEqual({
			refused: { reason: "tooLarge", bytes: 600 * MIB, limit: 512 * MIB }
		})
		expect(f.calls).toEqual([])
	})

	it("more than 2,000 items are refused without a listing", async () => {
		const f = fakes()
		const sessions = new DragSessions(f.effects, "linux", "staged")
		const items = Array.from({ length: 2_001 }, (_, index) => item(`f${index}`, "file", 1))

		expect(await sessions.prepare(1, items)).toEqual({ refused: { reason: "tooMany", entries: 2_001, limit: 2_000 } })
		expect(f.calls).toEqual([])
	})

	it("a listing past the cap is refused", async () => {
		const f = fakes({ tree: { tooMany: 2_001 } })
		const sessions = new DragSessions(f.effects, "linux", "staged")

		expect(await sessions.prepare(1, [item("d", "directory")])).toEqual({
			refused: { reason: "tooMany", entries: 2_001, limit: 2_000 }
		})
		expect(sessions.live()).toBe(0)
	})

	it("a refused plan downloads nothing and releases the listing", async () => {
		const f = fakes({ tree: [dirEntry(["d"]), fileEntry(["d", "big"], 0, 600 * MIB)] })
		const sessions = new DragSessions(f.effects, "linux", "staged")

		expect(await sessions.prepare(1, [item("d", "directory")])).toEqual({
			refused: { reason: "tooLarge", bytes: 600 * MIB, limit: 512 * MIB }
		})
		expect(f.started).toEqual([])
		expect(f.released).toEqual([f.listings[0]?.listingId])
		expect(f.deleted).toEqual([])
		expect(sessions.live()).toBe(0)
	})

	it("release before begin cancels staging downloads, deletes temp and emits ended cancelled", async () => {
		const f = fakes({ tree: [dirEntry(["d"]), fileEntry(["d", "b"], 0), fileEntry(["d", "c"], 1)] })
		const sessions = new DragSessions(f.effects, "linux", "staged")
		const id = idOf(await sessions.prepare(1, [item("d", "directory")]))

		f.settle(f.started[0] as Started, "done")
		sessions.release(1, id)

		expect(f.cancelled).toEqual(["t1"])
		expect(f.deleted).toEqual([{ id, later: null }])
		expect(f.released).toHaveLength(1)
		expect(f.states.at(-1)).toEqual({ id, state: "ended", outcome: "cancelled" })
		expect(sessions.live()).toBe(0)

		// The cancelled download settling later changes nothing.
		f.settle(f.started[1] as Started, "cancelled")
		expect(f.states.filter(state => state.state === "ended")).toHaveLength(1)
	})

	it("release after begin is ignored", async () => {
		const f = fakes({ tree: [fileEntry(["a"], null)] })
		const sessions = new DragSessions(f.effects, "linux", "staged")
		const id = idOf(await sessions.prepare(1, [item("a")]))

		f.settle(f.started[0] as Started, "done")
		sessions.markBegun(id)
		sessions.release(1, id)

		expect(f.states.filter(state => state.state === "ended")).toEqual([])
		expect(f.deleted).toEqual([])
	})

	it("a failed download ends the session failed and deletes its temp", async () => {
		const f = fakes({ tree: [fileEntry(["a"], null), fileEntry(["b"], null, 10, 1)] })
		const sessions = new DragSessions(f.effects, "linux", "staged")
		const id = idOf(await sessions.prepare(1, [item("a"), item("b")]))

		f.settle(f.started[0] as Started, "error")

		expect(f.cancelled).toEqual(["t1"])
		expect(f.states.at(-1)).toEqual({ id, state: "ended", outcome: "failed" })
		expect(f.deleted).toEqual([{ id, later: null }])
		expect(sessions.beginnable(1, id)).toBe("unknown")
	})

	it("staged Linux files are kept after ended; staged Windows files are deleted 30 min after", async () => {
		for (const platform of ["linux", "win32"] as const) {
			const f = fakes({ tree: [fileEntry(["a"], null)] })
			const sessions = new DragSessions(f.effects, platform, "staged")
			const id = idOf(await sessions.prepare(1, [item("a")]))

			f.settle(f.started[0] as Started, "done")
			sessions.markBegun(id)
			sessions.ended(id, "ended")

			expect(f.deleted).toEqual(platform === "linux" ? [] : [{ id, later: 30 * 60_000 }])
		}
	})

	it("staged temp is removed at once when the drag failed or was cancelled", async () => {
		for (const outcome of ["failed", "cancelled"] as const) {
			const f = fakes({ tree: [fileEntry(["a"], null)] })
			const sessions = new DragSessions(f.effects, "linux", "staged")
			const id = idOf(await sessions.prepare(1, [item("a")]))

			f.settle(f.started[0] as Started, "done")
			sessions.markBegun(id)
			sessions.ended(id, outcome)

			expect(f.deleted).toEqual([{ id, later: null }])
		}
	})

	it("the unbegun timer waits while staging and starts again once ready", async () => {
		const f = fakes({ tree: [fileEntry(["a"], null)] })
		const sessions = new DragSessions(f.effects, "linux", "staged")
		const id = idOf(await sessions.prepare(1, [item("a")]))

		f.advance(61_000)
		expect(sessions.beginnable(1, id)).toBe("notReady")
		f.advance(120_000)
		expect(f.states.filter(state => state.state === "ended")).toEqual([])

		f.settle(f.started[0] as Started, "done")
		f.advance(59_999)
		expect(f.states.filter(state => state.state === "ended")).toEqual([])
		f.advance(1)
		expect(f.states.at(-1)).toEqual({ id, state: "ended", outcome: "cancelled" })
	})

	it("staging that outlasts 10 minutes ends the session", async () => {
		const f = fakes({ tree: [fileEntry(["a"], null)] })
		const sessions = new DragSessions(f.effects, "linux", "staged")
		const id = idOf(await sessions.prepare(1, [item("a")]))

		f.advance(10 * 60_000 - 1)
		expect(sessions.beginnable(1, id)).toBe("notReady")
		f.advance(1)

		expect(sessions.beginnable(1, id)).toBe("unknown")
		expect(f.cancelled).toEqual(["t0"])
		expect(f.deleted).toEqual([{ id, later: null }])
	})

	it("payload is there only while the session is ready", async () => {
		const f = fakes({ tree: [fileEntry(["a"], null)] })
		const sessions = new DragSessions(f.effects, "linux", "staged")
		const id = idOf(await sessions.prepare(1, [item("a")]))

		expect(sessions.payload(1, id)).toBeNull()
		f.settle(f.started[0] as Started, "done")
		expect(sessions.payload(1, id)).toEqual({ mode: "staged", paths: [path.join(`/temp/s-${id}`, "a")] })
		sessions.markBegun(id)
		expect(sessions.payload(1, id)).toBeNull()
	})

	it("an empty directory alone is ready at once", async () => {
		const f = fakes({ tree: [dirEntry(["d"])] })
		const sessions = new DragSessions(f.effects, "linux", "staged")
		const id = idOf(await sessions.prepare(1, [item("d", "directory")]))

		expect(sessions.beginnable(1, id)).toBe("ready")
		expect(f.states).toEqual([{ id, state: "ready" }])
	})
})

describe("drag sessions: ownership and lifetime", () => {
	it("an unbegun session expires after 60 s", async () => {
		const f = fakes()
		const sessions = new DragSessions(f.effects, "darwin", "promise")
		const id = idOf(await sessions.prepare(1, [item("a")]))

		f.advance(59_999)
		expect(sessions.beginnable(1, id)).toBe("ready")

		f.advance(60_000)
		expect(sessions.beginnable(1, id)).toBe("unknown")
		expect(f.states.at(-1)).toEqual({ id, state: "ended", outcome: "cancelled" })
	})

	it("an unbegun session ends 10 minutes after prepare, however often the page asks", async () => {
		const f = fakes()
		const sessions = new DragSessions(f.effects, "darwin", "promise")
		const id = idOf(await sessions.prepare(1, [item("a")]))

		for (let at = 50_000; at < 10 * 60_000; at += 50_000) {
			f.advance(50_000)
			expect(sessions.beginnable(1, id)).toBe("ready")
		}

		f.advance(10 * 60_000 - f.now())
		expect(sessions.beginnable(1, id)).toBe("unknown")
	})

	it("a begun drag the OS never ends is ended failed after 10 minutes", async () => {
		const f = fakes()
		const sessions = new DragSessions(f.effects, "darwin", "promise")
		const id = idOf(await sessions.prepare(1, [item("a")]))

		sessions.markBegun(id)
		f.advance(10 * 60_000)

		expect(sessions.nativeDragRunning()).toBe(false)
		expect(f.states.at(-1)).toEqual({ id, state: "ended", outcome: "failed" })
	})

	it("a begun session does not expire", async () => {
		const f = fakes()
		const sessions = new DragSessions(f.effects, "darwin", "promise")
		const id = idOf(await sessions.prepare(1, [item("a")]))

		sessions.markBegun(id)
		f.advance(120_000)

		expect(f.states.filter(state => state.state === "ended")).toEqual([])
	})

	it("a second prepare from the same owner replaces the first unbegun one", async () => {
		const f = fakes()
		const sessions = new DragSessions(f.effects, "darwin", "promise")
		const first = idOf(await sessions.prepare(1, [item("a")]))
		const other = idOf(await sessions.prepare(2, [item("a")]))
		const second = idOf(await sessions.prepare(1, [item("b")]))

		expect(second).not.toBe(first)
		expect(sessions.beginnable(1, first)).toBe("unknown")
		expect(sessions.beginnable(1, second)).toBe("ready")
		expect(sessions.beginnable(2, other)).toBe("ready")
		expect(f.states).toContainEqual({ id: first, state: "ended", outcome: "cancelled" })
	})

	it("another owner cannot begin or release a session", async () => {
		const f = fakes()
		const sessions = new DragSessions(f.effects, "darwin", "promise")
		const id = idOf(await sessions.prepare(1, [item("a")]))

		expect(sessions.beginnable(2, id)).toBe("unknown")
		expect(sessions.payload(2, id)).toBeNull()

		sessions.release(2, id)

		expect(sessions.beginnable(1, id)).toBe("ready")
	})

	it("ownerGone releases that owner's unbegun sessions", async () => {
		const f = fakes({ tree: [dirEntry(["d"]), fileEntry(["d", "b"], 0)] })
		const sessions = new DragSessions(f.effects, "linux", "staged")
		const id = idOf(await sessions.prepare(1, [item("d", "directory")]))
		const kept = idOf(await sessions.prepare(2, [item("d", "directory")]))

		sessions.ownerGone(1)

		expect(sessions.beginnable(1, id)).toBe("unknown")
		expect(sessions.beginnable(2, kept)).toBe("notReady")
		expect(f.cancelled).toEqual(["t0"])
		expect(f.deleted).toEqual([{ id, later: null }])
	})

	it("a release while the listing is pending releases it once it arrives", async () => {
		const f = fakes({ tree: [dirEntry(["d"]), fileEntry(["d", "b"], 0)] })
		const sessions = new DragSessions(f.effects, "linux", "staged")
		const pending = sessions.prepare(1, [item("d", "directory")])

		sessions.ownerGone(1)

		expect(await pending).toEqual({ refused: { reason: "unavailable" } })
		expect(f.started).toEqual([])
		expect(f.released).toHaveLength(1)
		expect(sessions.live()).toBe(0)
	})

	it("markBegun refuses a second native drag", async () => {
		const f = fakes()
		const sessions = new DragSessions(f.effects, "darwin", "promise")
		const one = idOf(await sessions.prepare(1, [item("a")]))
		const two = idOf(await sessions.prepare(2, [item("b")]))

		expect(sessions.markBegun(one)).toBe(true)
		expect(sessions.markBegun(one)).toBe(false)
		expect(sessions.markBegun(two)).toBe(false)
		expect(sessions.nativeDragRunning()).toBe(true)

		sessions.ended(one, "cancelled")

		expect(sessions.nativeDragRunning()).toBe(false)
		expect(sessions.markBegun(two)).toBe(true)
	})

	it("markBegun refuses a staging session", async () => {
		const f = fakes({ tree: [fileEntry(["a"], null)] })
		const sessions = new DragSessions(f.effects, "linux", "staged")
		const id = idOf(await sessions.prepare(1, [item("a")]))

		expect(sessions.markBegun(id)).toBe(false)
	})

	it("a host that is not there refuses as unavailable", async () => {
		const f = fakes()

		f.effects.transfers.listTree = () => Promise.resolve({ ok: false, error: { code: "hostUnavailable" } })

		const sessions = new DragSessions(f.effects, "linux", "staged")

		expect(await sessions.prepare(1, [item("d", "directory")])).toEqual({ refused: { reason: "unavailable" } })
	})
})

describe("drag sessions: promise", () => {
	it("prepare names the items for Finder without a request", async () => {
		const f = fakes()
		const sessions = new DragSessions(f.effects, "darwin", "promise")
		const id = idOf(await sessions.prepare(1, [item("a/b:c"), item("d", "directory")]))

		expect(f.calls).toEqual([])
		expect(sessions.payload(1, id)).toEqual({
			mode: "promise",
			items: [
				{ name: "a_b:c", directory: false },
				{ name: "d", directory: true }
			]
		})
	})

	it("downloads replace at the supplied path and report the temp path", async () => {
		const f = fakes()
		const sessions = new DragSessions(f.effects, "darwin", "promise")
		const id = idOf(await sessions.prepare(1, [item("a"), item("d", "directory")]))
		const progress: [number, number][] = []
		const temps: string[] = []
		const done: (string | null)[] = []

		sessions.markBegun(id)
		sessions.promise(
			id,
			7,
			1,
			"/Users/me/Desktop/d 2",
			(bytes, size) => progress.push([bytes, size]),
			temp => temps.push(temp),
			error => done.push(error)
		)
		await flush()

		const [transfer] = f.started

		expect(transfer?.destination).toEqual({ kind: "exact", path: "/Users/me/Desktop/d 2", conflict: "replace" })
		expect(transfer?.items).toEqual([item("d", "directory")])

		transfer?.watch.onTemp?.(transfer.id, "/Users/me/Desktop/uuid.filendl")
		transfer?.watch.onProgress?.(transfer.id, 5, 10)
		sessions.ended(id, "dropped")

		expect(sessions.live()).toBe(1)

		f.settle(transfer as Started, "done")

		expect(temps).toEqual(["/Users/me/Desktop/uuid.filendl"])
		expect(progress).toEqual([[5, 10]])
		expect(done).toEqual([null])
		expect(sessions.live()).toBe(0)
	})

	it("Finder cancel of one ticket cancels only that transfer", async () => {
		const f = fakes()
		const sessions = new DragSessions(f.effects, "darwin", "promise")
		const id = idOf(await sessions.prepare(1, [item("a"), item("b")]))
		const done: [number, string | null][] = []

		sessions.markBegun(id)

		for (const ticket of [0, 1]) {
			sessions.promise(
				id,
				ticket,
				ticket,
				`/dest/${ticket}`,
				() => undefined,
				() => undefined,
				error => done.push([ticket, error])
			)
		}

		await flush()
		sessions.cancelTicket(id, 1)

		expect(f.cancelled).toEqual(["t1"])

		f.settle(f.started[1] as Started, "cancelled")
		f.settle(f.started[0] as Started, "done")

		expect(done).toEqual([
			[1, "cancelled"],
			[0, null]
		])
	})

	it("a Finder cancel before the start was answered cancels once it is", async () => {
		const f = fakes()
		const sessions = new DragSessions(f.effects, "darwin", "promise")
		const id = idOf(await sessions.prepare(1, [item("a")]))
		const done: (string | null)[] = []

		sessions.markBegun(id)
		sessions.promise(
			id,
			0,
			0,
			"/dest/a",
			() => undefined,
			() => undefined,
			error => done.push(error)
		)
		sessions.cancelTicket(id, 0)
		await flush()

		expect(f.cancelled).toEqual(["t0"])
	})

	it("a failed download completes its ticket with an error and leaves others running", async () => {
		const f = fakes()
		const sessions = new DragSessions(f.effects, "darwin", "promise")
		const id = idOf(await sessions.prepare(1, [item("a"), item("b")]))
		const done: [number, string | null][] = []

		sessions.markBegun(id)

		for (const ticket of [0, 1]) {
			sessions.promise(
				id,
				ticket,
				ticket,
				`/dest/${ticket}`,
				() => undefined,
				() => undefined,
				error => done.push([ticket, error])
			)
		}

		await flush()
		f.started[0]?.watch.onSettled({ id: "t0", outcome: "error", error: { code: "localFull" }, path: "/dest/0" })

		expect(done).toEqual([[0, "localFull"]])
		expect(f.cancelled).toEqual([])
		expect(sessions.live()).toBe(1)
	})

	it("a start that fails completes the ticket with its error", async () => {
		const f = fakes({ startError: true })
		const sessions = new DragSessions(f.effects, "darwin", "promise")
		const id = idOf(await sessions.prepare(1, [item("a")]))
		const done: (string | null)[] = []

		sessions.markBegun(id)
		sessions.promise(
			id,
			0,
			0,
			"/dest/a",
			() => undefined,
			() => undefined,
			error => done.push(error)
		)
		await flush()

		expect(done).toEqual(["hostUnavailable"])
	})

	it("a write for an unknown session or item completes at once with an error", async () => {
		const f = fakes()
		const sessions = new DragSessions(f.effects, "darwin", "promise")
		const id = idOf(await sessions.prepare(1, [item("a")]))
		const done: (string | null)[] = []

		sessions.promise(
			"nope",
			0,
			0,
			"/dest/a",
			() => undefined,
			() => undefined,
			error => done.push(error)
		)
		sessions.promise(
			id,
			1,
			5,
			"/dest/a",
			() => undefined,
			() => undefined,
			error => done.push(error)
		)

		expect(done).toEqual(["unknown", "unknown"])
		expect(f.calls).toEqual([])
	})
})

describe("drag sessions: virtual", () => {
	const tree = [
		dirEntry(["d"]),
		fileEntry(["d", "b"], 0),
		dirEntry(["d", "e"]),
		fileEntry(["d", "e", "c"], 1),
		fileEntry(["top"], null, 10, 1)
	]

	it("prepare lists and plans the tree for Windows", async () => {
		const f = fakes({ tree })
		const sessions = new DragSessions(f.effects, "win32", "virtual")
		const id = idOf(await sessions.prepare(1, [item("d", "directory"), item("top")]))

		expect(f.listings[0]?.maxEntries).toBe(10_000)
		expect(sessions.payload(1, id)).toEqual({
			mode: "virtual",
			entries: [
				{ relativePath: "d", directory: true, size: 0, mtimeMs: null, listIndex: null, source: 0 },
				{ relativePath: "top", directory: false, size: 10, mtimeMs: null, listIndex: null, source: 1 },
				{ relativePath: "d\\b", directory: false, size: 10, mtimeMs: null, listIndex: 0, source: 0 },
				{ relativePath: "d\\e", directory: true, size: 0, mtimeMs: null, listIndex: null, source: 0 },
				{ relativePath: "d\\e\\c", directory: false, size: 10, mtimeMs: null, listIndex: 1, source: 0 }
			]
		})
		expect(f.started).toEqual([])
	})

	it("contents starts that entry and prefetches the next file", async () => {
		const f = fakes({ tree })
		const sessions = new DragSessions(f.effects, "win32", "virtual")
		const id = idOf(await sessions.prepare(1, [item("d", "directory"), item("top")]))
		const done: [number, string | null][] = []

		sessions.markBegun(id)
		sessions.contents(id, 0, 1, file => done.push([0, file]))
		await flush()

		expect(f.started.map(s => [s.kind, s.index, s.path])).toEqual([
			["ref", null, path.join(`/temp/s-${id}`, "1")],
			["listed", 0, path.join(`/temp/s-${id}`, "2")]
		])
		expect(f.started[0]?.items).toEqual([item("top")])

		f.settle(f.started[1] as Started, "done")
		sessions.contents(id, 1, 2, file => done.push([1, file]))
		await flush()

		expect(done).toEqual([[1, path.join(`/temp/s-${id}`, "2")]])
		// The next file after index 2 (index 4) is prefetched; directory 3 is skipped.
		expect(f.started.map(s => s.index)).toEqual([null, 0, 1])

		f.settle(f.started[0] as Started, "done")

		expect(done).toEqual([
			[1, path.join(`/temp/s-${id}`, "2")],
			[0, path.join(`/temp/s-${id}`, "1")]
		])
	})

	it("contents of a directory fails at once", async () => {
		const f = fakes({ tree })
		const sessions = new DragSessions(f.effects, "win32", "virtual")
		const id = idOf(await sessions.prepare(1, [item("d", "directory"), item("top")]))
		const done: (string | null)[] = []

		sessions.markBegun(id)
		sessions.contents(id, 0, 0, file => done.push(file))

		expect(done).toEqual([null])
	})

	it("a dropped drag keeps the session until the operation ends", async () => {
		const f = fakes({ tree })
		const sessions = new DragSessions(f.effects, "win32", "virtual")
		const id = idOf(await sessions.prepare(1, [item("d", "directory"), item("top")]))
		const done: (string | null)[] = []

		sessions.markBegun(id)
		sessions.ended(id, "dropped")

		expect(f.released).toEqual([])

		sessions.contents(id, 0, 2, file => done.push(file))
		await flush()
		sessions.operationEnded(id)

		expect(done).toEqual([null])
		expect(f.cancelled).toEqual(["t0", "t1"])
		expect(f.released).toHaveLength(1)
		expect(f.deleted).toEqual([{ id, later: null }])
		expect(sessions.live()).toBe(0)
	})

	it("a cancelled drag releases everything at once", async () => {
		const f = fakes({ tree })
		const sessions = new DragSessions(f.effects, "win32", "virtual")
		const id = idOf(await sessions.prepare(1, [item("d", "directory"), item("top")]))

		sessions.markBegun(id)
		sessions.ended(id, "cancelled")

		expect(f.released).toHaveLength(1)
		expect(sessions.live()).toBe(0)
	})

	it("a long path is refused", async () => {
		const parent = "d".repeat(10)
		const f = fakes({ tree: [dirEntry([parent]), fileEntry([parent, "x".repeat(258)], 0)] })
		const sessions = new DragSessions(f.effects, "win32", "virtual")

		expect(await sessions.prepare(1, [item(parent, "directory")])).toEqual({
			refused: { reason: "pathTooLong", path: `${parent}\\${"x".repeat(255)}` }
		})
		expect(f.released).toHaveLength(1)
	})
})

describe("drag sessions: quit and demand", () => {
	it("quit aborts every transfer and completes every pending ticket with an error", async () => {
		const f = fakes()
		const sessions = new DragSessions(f.effects, "darwin", "promise")
		const id = idOf(await sessions.prepare(1, [item("a"), item("b")]))
		const unbegun = idOf(await sessions.prepare(2, [item("c")]))
		const done: (string | null)[] = []

		sessions.markBegun(id)

		for (const ticket of [0, 1]) {
			sessions.promise(
				id,
				ticket,
				ticket,
				`/dest/${ticket}`,
				() => undefined,
				() => undefined,
				error => done.push(error)
			)
		}

		await flush()
		sessions.abortAll("quit")

		expect(done).toEqual(["quit", "quit"])
		expect(f.cancelled).toEqual(["t0", "t1"])
		expect(f.states).toContainEqual({ id: unbegun, state: "ended", outcome: "cancelled" })
		expect(f.states).toContainEqual({ id, state: "ended", outcome: "cancelled" })
		expect(sessions.live()).toBe(0)
		expect(sessions.nativeDragRunning()).toBe(false)
		// The settles arriving after the abort fulfil nothing twice.
		f.settle(f.started[0] as Started, "cancelled")
		expect(done).toHaveLength(2)
		// Quit leaves temp removal to removeAllSync once the host stopped.
		expect(f.deleted).toEqual([])
	})

	it("sign-out ends every session and leaves the temp to the caller, once the host stopped writing it", async () => {
		const f = fakes({ tree: [fileEntry(["a"], null)] })
		const sessions = new DragSessions(f.effects, "linux", "staged")
		const id = idOf(await sessions.prepare(1, [item("a")]))

		sessions.abortAll("signedOut")

		expect(f.cancelled).toEqual(["t0"])
		expect(f.states.at(-1)).toEqual({ id, state: "ended", outcome: "cancelled" })
		expect(f.deleted).toEqual([])
	})

	it("live counts sessions with listings or tickets", async () => {
		const f = fakes({ tree: [dirEntry(["d"]), fileEntry(["d", "b"], 0)] })
		const staged = new DragSessions(f.effects, "linux", "staged")

		expect(staged.live()).toBe(0)

		const id = idOf(await staged.prepare(1, [item("d", "directory")]))

		expect(staged.live()).toBe(1)
		staged.release(1, id)
		expect(staged.live()).toBe(0)

		const virtual = new DragSessions(fakes({ tree: [dirEntry(["d"]), fileEntry(["d", "b"], 0)] }).effects, "win32", "virtual")
		const listed = idOf(await virtual.prepare(1, [item("d", "directory")]))

		// Holds its listing until the drag ends.
		expect(virtual.live()).toBe(1)
		virtual.markBegun(listed)
		virtual.ended(listed, "cancelled")
		expect(virtual.live()).toBe(0)

		const promised = new DragSessions(fakes().effects, "darwin", "promise")

		idOf(await promised.prepare(1, [item("a")]))
		expect(promised.live()).toBe(0)
	})
})
