import path from "node:path"
import { describe, expect, it } from "vitest"
import { suppliedPathFits } from "../main/dragOut/service.ts"
import { dragFakes, dragImage, dragItem, flush, preparedId, treeDir, treeFile } from "./dragOutFakes.ts"

describe("drag-out service: macOS", () => {
	it("a write downloads to the supplied path, shows progress on the temp file and fulfils", async () => {
		const f = dragFakes("promise")
		const page = f.page(1)
		const id = await preparedId(f.service.prepare(page, [dragItem("a.txt"), dragItem("d", "directory")]))
		const begun = f.service.begin(page, id, dragImage())
		const begin = f.mac.begins[0]

		expect(begin?.items).toEqual([
			{ name: "a.txt", directory: false, contentType: null },
			{ name: "d", directory: true, contentType: null }
		])
		expect(begin?.image).toMatchObject({ width: 100, height: 20 })
		expect(begin?.view).toEqual(Buffer.alloc(8, 1))

		begin?.onWrite(7, 0, "/Users/me/Desktop/a.txt")
		await flush()

		expect(f.started.map(s => s.path)).toEqual(["/Users/me/Desktop/a.txt"])

		f.started[0]?.watch.onTemp?.("t0", "/Users/me/Desktop/.t0.filendl")
		f.started[0]?.watch.onProgress?.("t0", 4, 10)
		f.settle(f.started[0])

		expect(f.mac.progressAt).toEqual([[7, "/Users/me/Desktop/.t0.filendl"]])
		expect(f.mac.progress).toEqual([[7, 4, 10]])
		expect(f.mac.fulfilled).toEqual([[7, null]])

		begin?.onEnded("copy")

		expect(await begun).toBe("dropped")
		expect(f.service.nativeDragRunning()).toBe(false)
	})

	it("Finder's unique name is taken; a path with another name, a separator or no root is fulfilled with an error", async () => {
		const f = dragFakes("promise")
		const page = f.page(1)
		const id = await preparedId(f.service.prepare(page, [dragItem("a.txt")]))

		void f.service.begin(page, id, dragImage())

		const begin = f.mac.begins[0]

		begin?.onWrite(1, 0, "/d/a 2.txt")

		for (const [ticket, target] of [
			[2, "/d/x/../a.txt"],
			[3, "/d/b.txt"],
			[4, "d/a.txt"],
			[5, "/d/a.txt/"],
			[6, "/d/a 1.txt"]
		] as const) {
			begin?.onWrite(ticket, 0, target)
		}

		begin?.onWrite(8, 3, "/d/a.txt")
		await flush()

		expect(f.started.map(s => s.path)).toEqual(["/d/a 2.txt"])
		expect(f.mac.fulfilled).toEqual([2, 3, 4, 5, 6, 8].map(ticket => [ticket, "invalidPath"]))
	})

	it("Finder cancel cancels that transfer", async () => {
		const f = dragFakes("promise")
		const page = f.page(1)
		const id = await preparedId(f.service.prepare(page, [dragItem("a"), dragItem("b")]))

		void f.service.begin(page, id, dragImage())
		f.mac.begins[0]?.onWrite(1, 0, "/d/a")
		f.mac.begins[0]?.onWrite(2, 1, "/d/b")
		await flush()
		f.mac.begins[0]?.onCancel(2)

		expect(f.cancelled).toEqual(["t1"])
	})

	it("a released button cancels, and the next drag can begin", async () => {
		const f = dragFakes("promise")
		const page = f.page(1)
		const id = await preparedId(f.service.prepare(page, [dragItem("a")]))

		f.mac.beginError = { code: "buttonReleased" }

		expect(await f.service.begin(page, id, dragImage())).toBe("cancelled")
		expect(f.service.nativeDragRunning()).toBe(false)

		f.mac.beginError = null

		const next = await preparedId(f.service.prepare(page, [dragItem("a")]))

		void f.service.begin(page, next, dragImage())
		expect(f.mac.begins).toHaveLength(1)
	})

	it("quit fails Finder's waiting writes and settles the running begin", async () => {
		const f = dragFakes("promise")
		const page = f.page(1)
		const id = await preparedId(f.service.prepare(page, [dragItem("a")]))
		const begun = f.service.begin(page, id, dragImage())
		const idle = f.service.idle()

		f.mac.begins[0]?.onWrite(1, 0, "/d/a")
		await flush()
		f.service.quit()

		expect(f.mac.fulfilled).toEqual([[1, "quit"]])
		expect(await begun).toBe("cancelled")
		await idle
	})

	it("a drag whose end never arrives is ended failed after 10 minutes", async () => {
		const f = dragFakes("promise")
		const page = f.page(1)
		const id = await preparedId(f.service.prepare(page, [dragItem("a")]))
		const begun = f.service.begin(page, id, dragImage())

		f.advance(10 * 60_000)

		expect(await begun).toBe("failed")
		expect(f.service.nativeDragRunning()).toBe(false)
	})

	it("a missing addon answers unavailable", async () => {
		const f = dragFakes("promise", { macAddon: null })

		expect(await f.service.prepare(f.page(1), [dragItem("a")])).toEqual({ refused: { reason: "unavailable" } })
	})

	it("supplied paths: the planned name or Finder's unique form, directly in an absolute directory", () => {
		expect(suppliedPathFits("/d/a.tar.gz", "a.tar.gz")).toBe(true)
		expect(suppliedPathFits("/d/a 2.tar.gz", "a.tar.gz")).toBe(true)
		expect(suppliedPathFits("/d/a.tar 12.gz", "a.tar.gz")).toBe(true)
		expect(suppliedPathFits("/d/dir 2", "dir")).toBe(true)
		expect(suppliedPathFits("/d/dir 1", "dir")).toBe(false)
		expect(suppliedPathFits("/d/dir 02", "dir")).toBe(false)
		expect(suppliedPathFits("/d//dir", "dir")).toBe(false)
		expect(suppliedPathFits("/", "")).toBe(false)
	})
})

describe("drag-out service: Windows", () => {
	const tree = [treeFile(["a"], null), treeDir(["d"], 1), { ...treeFile(["d", "b"], 0, 1), mtimeMs: 1_700_000_000_000 }]

	it("contents completes the ticket with the temp path", async () => {
		const f = dragFakes("virtual", { tree })
		const page = f.page(1)
		const id = await preparedId(f.service.prepare(page, [dragItem("a"), dragItem("d", "directory")]))

		expect(await f.service.begin(page, id, dragImage())).toBe("dropped")

		const begin = f.win.begins[0]

		// No mtime is no property, never null: the addon refuses null for its Option<f64> and the drag never begins.
		expect(begin?.entries).toStrictEqual([
			{ path: "a", directory: false, size: 10n },
			{ path: "d", directory: true, size: 0n },
			{ path: "d\\b", directory: false, size: 10n, mtimeMs: 1_700_000_000_000 }
		])
		expect(begin?.image).toMatchObject({ width: 200, height: 40 })
		expect(begin?.image.bgra.byteLength).toBe(200 * 40 * 4)

		begin?.onContents(5, 0)
		await flush()
		f.settle(f.started[0])

		expect(f.win.completed).toEqual([[5, path.join(`/temp/s-${id}`, "0")]])

		begin?.onContents(6, 1)

		expect(f.win.failed).toEqual([6])
	})

	it("callbacks queued during the drag run after the session heard the drop", async () => {
		const f = dragFakes("virtual", { tree })
		const page = f.page(1)

		f.service.subscribe(page, true)

		const id = await preparedId(f.service.prepare(page, [dragItem("a"), dragItem("d", "directory")]))

		f.win.during = begin => {
			queueMicrotask(() => {
				begin.onOperationEnd("ok")
			})

			return "dropped"
		}

		expect(await f.service.begin(page, id, dragImage())).toBe("dropped")
		await flush()

		expect(page.states.at(-1)).toEqual({ id, state: "ended", outcome: "dropped" })
		expect(f.released).toHaveLength(1)
		expect(f.service.live()).toBe(0)
	})

	it("a drop without an async operation resolves failed and releases everything", async () => {
		const f = dragFakes("virtual", { tree })
		const page = f.page(1)
		const id = await preparedId(f.service.prepare(page, [dragItem("a"), dragItem("d", "directory")]))

		f.win.during = () => "failed"

		expect(await f.service.begin(page, id, dragImage())).toBe("failed")
		expect(f.released).toHaveLength(1)
		expect(f.service.live()).toBe(0)
	})

	it("a released stream lets the entry download again", async () => {
		const f = dragFakes("virtual", { tree })
		const page = f.page(1)
		const id = await preparedId(f.service.prepare(page, [dragItem("a"), dragItem("d", "directory")]))

		await f.service.begin(page, id, dragImage())

		const begin = f.win.begins[0]

		begin?.onContents(1, 0)
		await flush()
		f.settle(f.started[0])
		begin?.onRelease(1)
		begin?.onContents(2, 0)
		await flush()

		expect(f.started.map(s => s.path)).toEqual([
			path.join(`/temp/s-${id}`, "0"),
			path.join(`/temp/s-${id}`, "2"),
			path.join(`/temp/s-${id}`, "0")
		])
	})

	it("a loader that throws answers unavailable and is not tried again", async () => {
		let loads = 0
		const f = dragFakes("virtual", {
			tree,
			winLoader: () => {
				loads++

				throw new Error("not a valid Win32 application")
			}
		})

		expect(await f.service.prepare(f.page(1), [dragItem("a")])).toEqual({ refused: { reason: "unavailable" } })
		expect(await f.service.prepare(f.page(1), [dragItem("a")])).toEqual({ refused: { reason: "unavailable" } })
		expect(loads).toBe(1)
		expect(f.warnings).toHaveLength(1)
	})

	it("quit aborts the addon's waiting reads", async () => {
		const f = dragFakes("virtual", { tree })
		const page = f.page(1)

		await preparedId(f.service.prepare(page, [dragItem("a")]))
		f.service.quit()

		expect(f.win.aborted).toBe(1)
	})
})

describe("drag-out service: staged (Linux)", () => {
	const tree = [treeDir(["d"]), treeFile(["d", "b"], 0), treeFile(["top"], null, 1)]

	it("notReady until staged, then startDrag with the top-level paths only, ended", async () => {
		const f = dragFakes("staged", { tree })
		const page = f.page(1)
		const id = await preparedId(f.service.prepare(page, [dragItem("d", "directory"), dragItem("top")]))

		expect(await f.service.begin(page, id, dragImage())).toBe("notReady")

		for (const download of f.started) {
			f.settle(download)
		}

		expect(await f.service.begin(page, id, dragImage())).toBe("ended")
		expect(f.drags).toEqual([
			{ owner: 1, files: [path.join(`/temp/s-${id}`, "d"), path.join(`/temp/s-${id}`, "top")], icon: expect.anything() as unknown }
		])
		expect(f.drags[0]?.icon.scale).toBe(2)
	})

	it("an empty icon fails before startDrag", async () => {
		const f = dragFakes("staged", { tree: [treeDir(["d"])] })
		const page = f.page(1)
		const id = await preparedId(f.service.prepare(page, [dragItem("d", "directory")]))

		f.icons.empty = true

		expect(await f.service.begin(page, id, dragImage())).toBe("failed")
		expect(f.drags).toEqual([])
		expect(f.sessions.beginnable(1, id)).toBe("ready")
	})

	it("a second begin while a native drag runs fails", async () => {
		const f = dragFakes("staged", { tree: [treeDir(["d"])] })
		const one = f.page(1)
		const two = f.page(2)
		const first = await preparedId(f.service.prepare(one, [dragItem("d", "directory")]))
		const second = await preparedId(f.service.prepare(two, [dragItem("d", "directory")]))
		let nested: Promise<string> | null = null

		// startDrag's nested loop runs IPC: the page's second begin arrives meanwhile.
		f.onStartDrag(() => {
			nested = f.service.begin(two, second, dragImage())
		})

		expect(await f.service.begin(one, first, dragImage())).toBe("ended")
		expect(await nested).toBe("failed")
		expect(f.drags).toHaveLength(1)
	})
})

describe("drag-out service: every platform", () => {
	it("begin from an unfocused window fails", async () => {
		const f = dragFakes("promise")
		const page = f.page(1)
		const id = await preparedId(f.service.prepare(page, [dragItem("a")]))

		f.focused.clear()

		expect(await f.service.begin(page, id, dragImage())).toBe("failed")
		expect(f.mac.begins).toEqual([])
	})

	it("no user answers unavailable", async () => {
		const f = dragFakes("staged", { user: null })

		expect(await f.service.prepare(f.page(1), [dragItem("a")])).toEqual({ refused: { reason: "unavailable" } })
	})

	it("an id another page prepared does not begin", async () => {
		const f = dragFakes("promise")
		const id = await preparedId(f.service.prepare(f.page(1), [dragItem("a")]))

		expect(await f.service.begin(f.page(2), id, dragImage())).toBe("failed")
		expect(f.mac.begins).toEqual([])
	})

	it("states go to the owner page only, and the latest is replayed to it on subscribe", async () => {
		const f = dragFakes("promise")
		const one = f.page(1)
		const two = f.page(2)

		f.service.subscribe(one, true)
		f.service.subscribe(two, true)

		const id = await preparedId(f.service.prepare(one, [dragItem("a")]))

		expect(one.states).toEqual([{ id, state: "ready" }])
		expect(two.states).toEqual([])

		const late = f.page(1)

		f.service.subscribe(late, true)
		expect(late.states).toEqual([{ id, state: "ready" }])

		f.service.release(one, id)
		expect(late.states.at(-1)).toEqual({ id, state: "ended", outcome: "cancelled" })

		const after = f.page(1)

		f.service.subscribe(after, true)
		expect(after.states).toEqual([])
	})

	it("a page gone ends its unbegun sessions and hears nothing more", async () => {
		const f = dragFakes("promise")
		const page = f.page(1)

		f.service.subscribe(page, true)

		const id = await preparedId(f.service.prepare(page, [dragItem("a")]))

		f.service.pageGone(1)

		expect(f.sessions.beginnable(1, id)).toBe("unknown")
		expect(page.states).toEqual([{ id, state: "ready" }])
	})

	it("sign-out ends the sessions and removes the temp once asked", async () => {
		const f = dragFakes("staged", { tree: [treeFile(["a"], null)] })
		const page = f.page(1)

		await preparedId(f.service.prepare(page, [dragItem("a")]))

		const discard = f.service.signedOut()

		expect(f.cancelled).toEqual(["t0"])
		expect(f.temp.removeAll).not.toHaveBeenCalled()

		await discard()

		expect(f.temp.removeAll).toHaveBeenCalledOnce()
	})
})
