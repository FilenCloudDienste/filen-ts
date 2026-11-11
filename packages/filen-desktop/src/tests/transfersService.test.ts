import path from "node:path"
import type { DesktopTransferEvent, DesktopTransferKind } from "@filen/shared/desktop"
import { localCollisionKey } from "@filen/shared/localName"
import { stringifyEnvelope } from "@filen/shared/session"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { DEFAULT_PREFS } from "../main/prefs.ts"
import { createTransfersService, type DownloadWatch, type NativeDownloadItem } from "../main/transfers/service.ts"
import { CHANNELS, TRANSFER_ITEMS_MAX } from "../shared/channels.ts"
import {
	type FromNative,
	LISTING_TTL_MS,
	type NativeOpArgs,
	type NativeTransferEvent,
	type NativeTransferSpec,
	type TransfersOp
} from "../shared/nativeProtocol.ts"
import { wasmDir, wasmFile } from "./nativeFakes.ts"

const DOWNLOADS = path.resolve("Downloads")
const FIXED = path.resolve("Fixed")
const PICKED = path.resolve("Picked")
const at = (dir: string, ...names: string[]) => path.join(dir, ...names)
const FILE_UUID = "4f8e2c1a-3b5d-4e6f-8a9b-0c1d2e3f4a5b"
const DIR_UUID = "6c5d4e3f-2a1b-4c0d-9e8f-7a6b5c4d3e2f"
const PARENT_UUID = "7d6e5f4a-3b2c-4d1e-8f9a-8b7c6d5e4f3a"
const LISTING = "2f5e8d3a-0b6c-4e4f-9d9a-7c3b5a4f6e8d"
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

function fileItem(name = "a.txt", uuid = FILE_UUID): NativeDownloadItem {
	return { kind: "file", ref: { variant: "AnyFile.File", value: stringifyEnvelope(wasmFile(uuid, 10n, name)) }, name, size: 10 }
}

function dirItem(name = "Projects"): NativeDownloadItem {
	return {
		kind: "directory",
		ref: { variant: "AnyDirWithContext.Normal.Dir", value: stringifyEnvelope(wasmDir(DIR_UUID, name)) },
		name,
		size: 0
	}
}

const PARENT = { uuid: PARENT_UUID, ref: { variant: "AnyNormalDir.Dir" as const, value: stringifyEnvelope(wasmDir(PARENT_UUID)) } }

type Answer = (args: unknown) => Promise<unknown>

function setup(
	options: { platform?: NodeJS.Platform; downloadDirectory?: string | null; userId?: string | null; now?: () => number } = {}
) {
	let generation = 1
	const answers: Partial<Record<TransfersOp, Answer>> = {}
	const ok = (value: unknown = null) => Promise.resolve({ ok: true, value })
	const supervisor = {
		callTransfers: vi.fn(
			<K extends TransfersOp>(op: K, args: NativeOpArgs<K>, _userId?: string, _timeoutMs?: number) =>
				(answers[op]?.(args) ?? ok()) as never
		),
		callTransfersIfRunning: vi.fn(<K extends TransfersOp>(_op: K, _args: NativeOpArgs<K>, _userId?: string) => ok() as never),
		user: vi.fn(() => Promise.resolve(options.userId === null ? null : { userId: options.userId ?? "1" })),
		ensure: vi.fn(),
		generation: () => generation
	}
	const disk = new Map<string, "file" | "directory">([
		[DOWNLOADS, "directory"],
		[PICKED, "directory"],
		[FIXED, "directory"]
	])
	const sizes = new Map<string, number>()
	let downloadDirectory = options.downloadDirectory === undefined ? null : options.downloadDirectory
	const prefs = {
		get: () => ({ ...DEFAULT_PREFS, downloadDirectory }),
		setDownloadDirectory: vi.fn((value: string | null) => {
			downloadDirectory = value

			return Promise.resolve({ ...DEFAULT_PREFS, downloadDirectory })
		})
	}
	const dialogs = {
		save: vi.fn((_options: Electron.SaveDialogOptions): Promise<string | null> => Promise.resolve(at(PICKED, "chosen.txt"))),
		open: vi.fn((_options: Electron.OpenDialogOptions): Promise<string[] | null> => Promise.resolve([PICKED]))
	}
	const fs = {
		stat: vi.fn((target: string) => {
			const kind = disk.get(target)

			return Promise.resolve(
				kind === undefined
					? null
					: { isFile: () => kind === "file", isDirectory: () => kind === "directory", size: sizes.get(target) ?? 0 }
			)
		}),
		exists: vi.fn((target: string) => Promise.resolve(disk.has(target)))
	}
	const shell = { showItemInFolder: vi.fn(), openPath: vi.fn((_target: string) => Promise.resolve("")) }
	const journal = { add: vi.fn(), remove: vi.fn(), discard: vi.fn(() => Promise.resolve()), sweep: vi.fn(() => Promise.resolve()) }
	const log = { info: vi.fn(), warn: vi.fn() }
	const service = createTransfersService({
		supervisor,
		prefs,
		dialogs,
		fs,
		shell,
		journal,
		downloadsDir: () => DOWNLOADS,
		platform: options.platform ?? "darwin",
		now: options.now ?? (() => 1000),
		log
	})
	const sent: DesktopTransferEvent[][] = []
	const page = {
		id: 7,
		send: vi.fn((channel: string, payload: unknown) => {
			if (channel === CHANNELS.transfersEvents) {
				sent.push(payload as DesktopTransferEvent[])
			}
		})
	}
	const startCalls = () =>
		supervisor.callTransfers.mock.calls
			.filter(call => call[0] === "transfersStart")
			.map(call => call[1] as { specs: NativeTransferSpec[] })
	const specs = () => startCalls().flatMap(call => call.specs)
	const host = (events: NativeTransferEvent[], userId = "1") => {
		service.nativeEvent({ t: "transfers", events } satisfies FromNative, userId)
	}

	return {
		service,
		supervisor,
		answers,
		prefs,
		dialogs,
		fs,
		disk,
		sizes,
		shell,
		journal,
		log,
		page,
		sent,
		startCalls,
		specs,
		host,
		setGeneration: (next: number) => {
			generation = next
		}
	}
}

function started(result: unknown): string[] {
	const value = result as { ok: true; value: { status: "started"; ids: string[] } }

	expect(value).toMatchObject({ ok: true, value: { status: "started" } })

	return value.value.ids
}

beforeEach(() => {
	vi.useRealTimers()
})

describe("transfers service: downloads", () => {
	it("downloads one file into the fixed directory without a dialog", async () => {
		const { service, dialogs, specs } = setup({ downloadDirectory: FIXED })
		const ids = started(await service.startDownload({ items: [fileItem()], destination: { kind: "prefs" }, origin: "page" }))

		expect(dialogs.save).not.toHaveBeenCalled()
		expect(dialogs.open).not.toHaveBeenCalled()
		expect(specs()).toEqual([{ id: ids[0], t: "downloadFile", file: fileItem().ref, path: at(FIXED, "a.txt"), conflict: "keepBoth" }])
		expect(ids[0]).toMatch(UUID)
	})

	it("asks with a save dialog for one file when no directory is set and replaces there", async () => {
		const { service, dialogs, specs } = setup()

		await service.startDownload({ items: [fileItem()], destination: { kind: "prefs" }, origin: "page" })

		expect(dialogs.save).toHaveBeenCalledWith({ defaultPath: at(DOWNLOADS, "a.txt") })
		expect(specs()).toMatchObject([{ t: "downloadFile", path: at(PICKED, "chosen.txt"), conflict: "replace" }])

		// The next save dialog opens where the last one saved.
		await service.startDownload({ items: [fileItem("b.txt")], destination: { kind: "prefs" }, origin: "page" })

		expect(dialogs.save).toHaveBeenLastCalledWith({ defaultPath: at(PICKED, "b.txt") })
	})

	it("a fixed directory that no longer exists falls back to the dialog and logs the path", async () => {
		const { service, dialogs, log } = setup({ downloadDirectory: path.resolve("Gone") })

		await service.startDownload({ items: [fileItem()], destination: { kind: "prefs" }, origin: "page" })

		expect(dialogs.save).toHaveBeenCalledOnce()
		expect(log.warn).toHaveBeenCalledWith(expect.stringContaining(path.resolve("Gone")))
	})

	it("asks for a directory for a multi-selection", async () => {
		const { service, dialogs, specs } = setup()

		await service.startDownload({ items: [fileItem(), fileItem("b.txt")], destination: { kind: "prefs" }, origin: "page" })

		expect(dialogs.open).toHaveBeenCalledWith({ properties: ["openDirectory", "createDirectory"], defaultPath: DOWNLOADS })
		expect(specs().map(spec => spec.path)).toEqual([at(PICKED, "a.txt"), at(PICKED, "b.txt")])
	})

	it("ask forces the directory picker even with a fixed directory", async () => {
		const { service, dialogs, specs } = setup({ downloadDirectory: FIXED })

		await service.startDownload({ items: [fileItem()], destination: { kind: "prefs", ask: true }, origin: "page" })

		expect(dialogs.open).toHaveBeenCalledOnce()
		expect(specs()).toMatchObject([{ path: at(PICKED, "a.txt"), conflict: "keepBoth" }])
	})

	it("a canceled dialog starts nothing and calls no host", async () => {
		const { service, dialogs, supervisor } = setup()

		dialogs.save.mockResolvedValue(null)
		dialogs.open.mockResolvedValue(null)

		expect(await service.startDownload({ items: [fileItem()], destination: { kind: "prefs" }, origin: "page" })).toEqual({
			ok: true,
			value: { status: "canceled" }
		})
		expect(await service.startDownload({ items: [fileItem(), dirItem()], destination: { kind: "prefs" }, origin: "page" })).toEqual({
			ok: true,
			value: { status: "canceled" }
		})
		expect(supervisor.callTransfers).not.toHaveBeenCalled()
	})

	it("no signed-in user answers unauthenticated", async () => {
		const { service, supervisor } = setup({ userId: null })

		expect(await service.startDownload({ items: [fileItem()], destination: { kind: "prefs" }, origin: "page" })).toEqual({
			ok: false,
			error: { code: "unauthenticated" }
		})
		expect(supervisor.callTransfers).not.toHaveBeenCalled()
	})

	it("keeps both on a name collision, also between two downloads started together", async () => {
		const { service, disk, specs } = setup({ downloadDirectory: FIXED })

		disk.set(at(FIXED, "a.txt"), "file")
		await Promise.all([
			service.startDownload({ items: [fileItem(), fileItem("A.TXT")], destination: { kind: "prefs" }, origin: "page" }),
			service.startDownload({ items: [fileItem()], destination: { kind: "prefs" }, origin: "page" })
		])

		const paths = specs().map(spec => spec.path)

		// The fake disk is case-sensitive: "A.TXT" is free there, and only the reservations keep the three apart.
		expect(paths.map(target => localCollisionKey(path.basename(target))).sort()).toEqual(["a (1).txt", "a (2).txt", "a.txt"])
		expect(paths).not.toContain(at(FIXED, "a.txt"))
	})

	it("a settled download frees its reserved name", async () => {
		const { service, specs, host } = setup({ downloadDirectory: FIXED })
		const [id] = started(await service.startDownload({ items: [fileItem()], destination: { kind: "prefs" }, origin: "page" }))

		host([{ k: "settled", id: id ?? "", outcome: "error", error: { code: "unknown" } }])
		await service.startDownload({ items: [fileItem()], destination: { kind: "prefs" }, origin: "page" })

		expect(specs().map(spec => spec.path)).toEqual([at(FIXED, "a.txt"), at(FIXED, "a.txt")])
	})

	it("runs a remote name through localName", async () => {
		const { service, specs } = setup({ platform: "win32", downloadDirectory: FIXED })

		await service.startDownload({ items: [fileItem("CON")], destination: { kind: "prefs" }, origin: "page" })

		expect(specs()[0]?.path).toBe(at(FIXED, "CON_"))
	})

	it("downloads a directory as a downloadDirectory spec into a free name", async () => {
		const { service, disk, specs, journal } = setup({ downloadDirectory: FIXED })

		disk.set(at(FIXED, "Projects"), "directory")

		const [id] = started(await service.startDownload({ items: [dirItem()], destination: { kind: "prefs" }, origin: "page" }))

		expect(specs()).toEqual([{ id, t: "downloadDirectory", dir: dirItem().ref, path: at(FIXED, "Projects (1)") }])
		expect(journal.add).toHaveBeenCalledWith([{ id, dir: at(FIXED, "Projects (1)"), names: [], tree: true }])
	})

	it("journals the staging and SDK temp names of a file download", async () => {
		const { service, journal } = setup({ downloadDirectory: FIXED })
		const [id] = started(await service.startDownload({ items: [fileItem()], destination: { kind: "prefs" }, origin: "page" }))

		expect(journal.add).toHaveBeenCalledWith([{ id, dir: FIXED, names: [`${id ?? ""}.filendl`, `${FILE_UUID}.filendl`], tree: false }])
	})

	it("starts every item of one action with one host call", async () => {
		const { service, startCalls } = setup({ downloadDirectory: FIXED })

		await service.startDownload({
			items: [fileItem(), fileItem("b.txt"), dirItem()],
			destination: { kind: "prefs" },
			origin: "page"
		})

		expect(startCalls()).toHaveLength(1)
		expect(startCalls()[0]?.specs).toHaveLength(3)
	})

	it("a host failure at start settles every id error and returns the error", async () => {
		const { service, answers, page, sent, journal } = setup({ downloadDirectory: FIXED })

		service.subscribe(page, true)
		answers.transfersStart = () => Promise.resolve({ ok: false, error: { code: "hostUnavailable" } })

		const result = await service.startDownload({
			items: [fileItem(), fileItem("b.txt")],
			destination: { kind: "prefs" },
			origin: "page"
		})

		expect(result).toEqual({ ok: false, error: { code: "hostUnavailable" } })

		const ids = sent.flatMap(events => events.flatMap(event => (event.t === "added" ? event.transfers.map(row => row.id) : [])))

		expect(sent.flat().filter(event => event.t === "settled")).toEqual(
			ids.map(id => ({ t: "settled", id, outcome: "error", error: { code: "hostUnavailable" } }))
		)
		expect(journal.discard).toHaveBeenCalledWith(ids)
		expect(service.active()).toBe(0)
	})

	it("a timed-out start cancels on a running host and settles timeout", async () => {
		const { service, answers, supervisor } = setup({ downloadDirectory: FIXED })

		answers.transfersStart = () => Promise.resolve({ ok: false, error: { code: "timeout" } })

		const result = await service.startDownload({ items: [fileItem()], destination: { kind: "prefs" }, origin: "page" })

		expect(result).toEqual({ ok: false, error: { code: "timeout" } })
		expect(supervisor.callTransfersIfRunning).toHaveBeenCalledWith("transfersCancel", { ids: [expect.stringMatching(UUID)] }, "1")
		expect(service.active()).toBe(0)
	})

	it("a host that is starting while transfersStart runs does not interrupt the new rows", async () => {
		const { service, answers } = setup({ downloadDirectory: FIXED })
		const reply = Promise.withResolvers<unknown>()

		answers.transfersStart = () => reply.promise

		const starting = service.startDownload({ items: [fileItem()], destination: { kind: "prefs" }, origin: "page" })

		await vi.waitFor(() => {
			expect(service.active()).toBe(1)
		})
		service.hostChanged({ state: "running" }, 1)
		service.hostChanged({ state: "starting" }, 1)
		service.hostChanged({ state: "running" }, 2)
		reply.resolve({ ok: true, value: null })
		started(await starting)

		expect(service.active()).toBe(1)
	})

	it("running to off settles only rows of that generation interrupted and unlinks their staging files", async () => {
		const { service, journal, setGeneration } = setup({ downloadDirectory: FIXED })
		const watch = { onSettled: vi.fn() }

		service.hostChanged({ state: "running" }, 1)

		const [first] = started(await service.startDownload({ items: [fileItem()], destination: { kind: "prefs" }, origin: "page", watch }))

		service.hostChanged({ state: "off" }, 1)
		setGeneration(2)
		service.hostChanged({ state: "running" }, 2)

		const [second] = started(
			await service.startDownload({ items: [fileItem("b.txt")], destination: { kind: "prefs" }, origin: "page" })
		)

		service.hostChanged({ state: "restarting", retryAt: 5 }, 1)

		expect(watch.onSettled).toHaveBeenCalledWith({
			id: first,
			outcome: "error",
			error: { code: "interrupted" },
			path: at(FIXED, "a.txt")
		})
		expect(journal.discard).toHaveBeenCalledWith([first])
		expect(service.list().map(row => row.id)).toEqual([second])
	})

	it("host stop settles active transfers interrupted and calls watch.onSettled", async () => {
		const { service, page, sent } = setup({ downloadDirectory: FIXED })
		const watch = { onSettled: vi.fn() }

		service.hostChanged({ state: "running" }, 1)

		const [id] = started(await service.startDownload({ items: [fileItem()], destination: { kind: "prefs" }, origin: "page", watch }))

		service.subscribe(page, true)
		service.hostChanged({ state: "failed", reason: "crashLoop" }, 1)

		expect(sent.at(-1)).toEqual([{ t: "settled", id, outcome: "error", error: { code: "interrupted" } }])
		expect(watch.onSettled).toHaveBeenCalledOnce()
		expect(service.active()).toBe(0)
	})

	it("pushes added, progress and settled to a subscribed page and nothing to an unsubscribed one", async () => {
		const { service, page, sent, host } = setup({ downloadDirectory: FIXED })
		const other = { id: 8, send: vi.fn() }

		service.subscribe(page, true)
		service.subscribe(other, true)
		service.subscribe(other, false)

		const [id = ""] = started(await service.startDownload({ items: [fileItem()], destination: { kind: "prefs" }, origin: "page" }))

		host([
			{ k: "progress", id, size: 10, bytes: 4, files: null },
			{ k: "settled", id, outcome: "done", savedPath: at(FIXED, "a.txt") }
		])

		expect(sent).toEqual([
			[{ t: "snapshot", transfers: [] }],
			[
				{
					t: "added",
					transfers: [
						{
							id,
							direction: "download",
							kind: "file",
							origin: "page",
							group: expect.stringMatching(UUID) as string,
							name: "a.txt",
							parentUuid: null,
							size: 10,
							bytes: 0,
							files: null,
							paused: false,
							startedAt: 1000,
							revealable: true
						}
					]
				}
			],
			[
				{ t: "progress", updates: [{ id, size: 10, bytes: 4, files: null }] },
				{ t: "settled", id, outcome: "done" }
			]
		])
		expect(other.send).toHaveBeenCalledTimes(1)
	})

	it("ignores another user's events and progress for unknown ids", async () => {
		const { service, page, sent, host } = setup({ downloadDirectory: FIXED })
		const [id = ""] = started(await service.startDownload({ items: [fileItem()], destination: { kind: "prefs" }, origin: "page" }))

		service.subscribe(page, true)
		host([{ k: "settled", id, outcome: "done" }], "2")
		host([{ k: "progress", id: LISTING, size: 1, bytes: 1, files: null }])

		expect(sent).toHaveLength(1)
		expect(service.active()).toBe(1)
	})

	it("a page subscribing late gets a snapshot with bytes and paused state", async () => {
		const { service, page, sent, host } = setup({ downloadDirectory: FIXED })
		const [id = ""] = started(await service.startDownload({ items: [fileItem()], destination: { kind: "prefs" }, origin: "page" }))

		host([{ k: "progress", id, size: 10, bytes: 6, files: null }])
		service.setPaused([id], true)
		service.subscribe(page, true)

		expect(sent).toEqual([[{ t: "snapshot", transfers: [expect.objectContaining({ id, bytes: 6, paused: true }) as unknown] }]])
	})

	it("pageGone stops sends to that page", async () => {
		const { service, page, sent } = setup({ downloadDirectory: FIXED })

		service.subscribe(page, true)
		service.pageGone(page.id)
		await service.startDownload({ items: [fileItem()], destination: { kind: "prefs" }, origin: "page" })

		expect(sent).toHaveLength(1)
	})

	it("signedOut settles cancelled without calling the host", async () => {
		const { service, supervisor, page, sent, journal } = setup({ downloadDirectory: FIXED })
		const watch = { onSettled: vi.fn() }
		const [id] = started(await service.startDownload({ items: [fileItem()], destination: { kind: "prefs" }, origin: "page", watch }))

		supervisor.callTransfers.mockClear()
		service.subscribe(page, true)

		const discardStaging = service.signedOut()

		expect(sent.at(-1)).toEqual([{ t: "settled", id, outcome: "cancelled" }])
		expect(watch.onSettled).toHaveBeenCalledWith({ id, outcome: "cancelled", path: at(FIXED, "a.txt") })
		// The host may still write there until it has stopped.
		expect(journal.discard).not.toHaveBeenCalled()
		await discardStaging()
		expect(journal.discard).toHaveBeenCalledWith([id])
		expect(supervisor.callTransfers).not.toHaveBeenCalled()
		expect(supervisor.callTransfersIfRunning).not.toHaveBeenCalled()
		expect(service.active()).toBe(0)
	})

	it("sign-out during a pending start ends its rows cancelled once and discards staging after the host stopped", async () => {
		const { service, answers, page, sent, journal } = setup({ downloadDirectory: FIXED })
		const reply = Promise.withResolvers<unknown>()

		answers.transfersStart = () => reply.promise
		service.subscribe(page, true)

		const starting = service.startDownload({ items: [fileItem()], destination: { kind: "prefs" }, origin: "page" })

		await vi.waitFor(() => {
			expect(service.active()).toBe(1)
		})

		const [id] = service.list().map(row => row.id)
		const discardStaging = service.signedOut()

		reply.resolve({ ok: true, value: null })
		await starting
		expect(journal.discard).not.toHaveBeenCalled()
		await discardStaging()

		expect(journal.discard).toHaveBeenCalledWith([id])
		expect(sent.flat().filter(event => event.t === "settled")).toEqual([{ t: "settled", id, outcome: "cancelled" }])
		expect(service.active()).toBe(0)
	})

	it("a start still asking for its destination when sign-out lands starts nothing", async () => {
		const { service, dialogs, supervisor, journal } = setup()
		const saved = Promise.withResolvers<string | null>()

		dialogs.save.mockReturnValue(saved.promise)

		const starting = service.startDownload({ items: [fileItem()], destination: { kind: "prefs" }, origin: "page" })

		await vi.waitFor(() => {
			expect(dialogs.save).toHaveBeenCalled()
		})
		service.signedOut()
		saved.resolve(at(PICKED, "a.txt"))

		expect(await starting).toEqual({ ok: false, error: { code: "unauthenticated" } })
		expect(supervisor.callTransfers).not.toHaveBeenCalled()
		expect(journal.add).not.toHaveBeenCalled()
		expect(service.active()).toBe(0)
	})

	it("a session restart (running to starting) interrupts the old generation's rows", async () => {
		const { service } = setup({ downloadDirectory: FIXED })

		service.hostChanged({ state: "running" }, 1)
		await service.startDownload({ items: [fileItem()], destination: { kind: "prefs" }, origin: "page" })
		service.hostChanged({ state: "starting" }, 1)

		expect(service.active()).toBe(0)
	})

	it("a host crash while transfersStart is pending leaves the rows to the start's own result", async () => {
		const { service, answers, page, sent } = setup({ downloadDirectory: FIXED })
		const reply = Promise.withResolvers<unknown>()

		answers.transfersStart = () => reply.promise
		service.hostChanged({ state: "running" }, 1)
		service.subscribe(page, true)

		const starting = service.startDownload({ items: [fileItem()], destination: { kind: "prefs" }, origin: "page" })

		await vi.waitFor(() => {
			expect(service.active()).toBe(1)
		})
		service.hostChanged({ state: "restarting", retryAt: 5 }, 1)
		expect(service.active()).toBe(1)
		reply.resolve({ ok: false, error: { code: "hostUnavailable" } })

		expect(await starting).toEqual({ ok: false, error: { code: "hostUnavailable" } })
		expect(sent.flat().filter(event => event.t === "settled")).toEqual([
			{ t: "settled", id: expect.stringMatching(UUID) as string, outcome: "error", error: { code: "hostUnavailable" } }
		])
	})

	it("settles a row once: a duplicate settle in one message and a host settle after a local one are dropped", async () => {
		const { service, page, sent, host, journal } = setup({ downloadDirectory: FIXED })
		const [a = "", b = ""] = started(
			await service.startDownload({ items: [fileItem(), fileItem("b.txt")], destination: { kind: "prefs" }, origin: "page" })
		)

		service.hostChanged({ state: "running" }, 1)
		service.subscribe(page, true)
		host([
			{ k: "settled", id: a, outcome: "done" },
			{ k: "settled", id: a, outcome: "error", error: { code: "unknown" } }
		])
		service.hostChanged({ state: "off" }, 1)
		host([{ k: "settled", id: b, outcome: "done" }])

		expect(sent.flat().filter(event => event.t === "settled")).toEqual([
			{ t: "settled", id: a, outcome: "done" },
			{ t: "settled", id: b, outcome: "error", error: { code: "interrupted" } }
		])
		expect(journal.remove).toHaveBeenCalledTimes(1)
	})

	it("two downloads started at once into one directory keep both", async () => {
		const { service, specs } = setup({ downloadDirectory: FIXED })

		await Promise.all([
			service.startDownload({ items: [fileItem()], destination: { kind: "prefs" }, origin: "page" }),
			service.startDownload({ items: [fileItem()], destination: { kind: "prefs" }, origin: "page" })
		])

		expect(
			specs()
				.map(spec => spec.path)
				.sort()
		).toEqual([at(FIXED, "a (1).txt"), at(FIXED, "a.txt")])
	})

	it("a reload re-subscribes for a fresh snapshot and two windows each get every round once", async () => {
		const { service, page, sent, host } = setup({ downloadDirectory: FIXED })
		const other = { id: 8, send: vi.fn() }

		service.subscribe(page, true)

		const [id = ""] = started(await service.startDownload({ items: [fileItem()], destination: { kind: "prefs" }, origin: "page" }))

		host([{ k: "progress", id, size: 10, bytes: 4, files: null }])
		service.subscribe(page, true)
		service.subscribe(other, true)
		host([{ k: "progress", id, size: 10, bytes: 8, files: null }])

		expect(sent.at(-2)).toEqual([{ t: "snapshot", transfers: [expect.objectContaining({ id, bytes: 4 }) as unknown] }])
		expect(sent.at(-1)).toEqual([{ t: "progress", updates: [{ id, size: 10, bytes: 8, files: null }] }])
		expect(sent.filter(events => events[0]?.t === "progress")).toHaveLength(2)
		expect(other.send).toHaveBeenCalledTimes(2)
	})

	it("a planning failure releases every name the action reserved", async () => {
		const { service, fs, specs } = setup({ downloadDirectory: FIXED })

		fs.exists.mockImplementation((target: string) =>
			target === at(FIXED, "b.txt") ? Promise.reject(new Error("EIO")) : Promise.resolve(false)
		)

		await expect(
			service.startDownload({ items: [fileItem(), fileItem("b.txt")], destination: { kind: "prefs" }, origin: "page" })
		).rejects.toThrow("EIO")
		expect(service.active()).toBe(0)

		fs.exists.mockResolvedValue(false)
		await service.startDownload({ items: [fileItem(), fileItem("b.txt")], destination: { kind: "prefs" }, origin: "page" })

		expect(specs().map(spec => spec.path)).toEqual([at(FIXED, "a.txt"), at(FIXED, "b.txt")])
	})

	it("reads the SDK temp's uuid wherever the File's uuid key sits", async () => {
		const { service, journal } = setup({ downloadDirectory: FIXED })
		const { uuid, ...rest } = wasmFile(FILE_UUID, 10n)
		const item: NativeDownloadItem = {
			kind: "file",
			ref: { variant: "AnyFile.File", value: stringifyEnvelope({ ...rest, uuid }) },
			name: "a.txt",
			size: 10
		}
		const [id] = started(await service.startDownload({ items: [item], destination: { kind: "prefs" }, origin: "page" }))

		expect(journal.add).toHaveBeenCalledWith([{ id, dir: FIXED, names: [`${id ?? ""}.filendl`, `${FILE_UUID}.filendl`], tree: false }])
	})

	it("cancel and pause never start the host", async () => {
		const { service, supervisor, page, sent } = setup({ downloadDirectory: FIXED })
		const [id = ""] = started(await service.startDownload({ items: [fileItem()], destination: { kind: "prefs" }, origin: "page" }))

		supervisor.callTransfers.mockClear()
		service.subscribe(page, true)
		service.setPaused([id], true)
		service.setPaused([id], true)
		service.cancel([id, LISTING])

		expect(supervisor.callTransfers).not.toHaveBeenCalled()
		expect(supervisor.callTransfersIfRunning.mock.calls).toEqual([
			["transfersPause", { ids: [id], paused: true }, "1"],
			["transfersCancel", { ids: [id] }, "1"]
		])
		expect(sent.at(-1)).toEqual([{ t: "paused", ids: [id], paused: true }])
	})

	it("a cancel or pause before the host acked the start is sent once it acks", async () => {
		const { service, answers, supervisor } = setup({ downloadDirectory: FIXED })
		const reply = Promise.withResolvers<unknown>()

		answers.transfersStart = () => reply.promise

		const starting = service.startDownload({ items: [fileItem(), fileItem("b.txt")], destination: { kind: "prefs" }, origin: "page" })

		await vi.waitFor(() => {
			expect(service.list()).toHaveLength(2)
		})

		const [first = "", second = ""] = service.list().map(row => row.id)

		service.setPaused([first], true)
		service.cancel([second])
		supervisor.callTransfersIfRunning.mockClear()
		reply.resolve({ ok: true, value: null })
		await starting

		expect(supervisor.callTransfersIfRunning.mock.calls).toEqual([
			["transfersPause", { ids: [first], paused: true }, "1"],
			["transfersCancel", { ids: [second] }, "1"]
		])
	})

	it("active(userId) counts only that user's running transfers", async () => {
		const { service } = setup({ downloadDirectory: FIXED })

		await service.startDownload({ items: [fileItem(), fileItem("b.txt")], destination: { kind: "prefs" }, origin: "page" })

		expect(service.active("1")).toBe(2)
		expect(service.active("2")).toBe(0)
		expect(service.active()).toBe(2)
	})

	it("the last settle calls supervisor.ensure", async () => {
		const { service, supervisor, host } = setup({ downloadDirectory: FIXED })
		const [a = "", b = ""] = started(
			await service.startDownload({ items: [fileItem(), fileItem("b.txt")], destination: { kind: "prefs" }, origin: "page" })
		)

		host([{ k: "settled", id: a, outcome: "done" }])
		expect(supervisor.ensure).not.toHaveBeenCalled()
		host([{ k: "settled", id: b, outcome: "done" }])

		expect(supervisor.ensure).toHaveBeenCalledWith("transfers settled")
	})

	it("startDownload with origin drag shows in the page like any other", async () => {
		const { service, page, sent } = setup()

		service.subscribe(page, true)
		await service.startDownload({
			items: [fileItem()],
			destination: { kind: "exact", path: at(PICKED, "drop.txt"), conflict: "replace" },
			origin: "drag",
			revealable: false
		})

		expect(sent.at(-1)).toEqual([
			{ t: "added", transfers: [expect.objectContaining({ origin: "drag", name: "a.txt", revealable: false }) as unknown] }
		])
	})

	it("watch reports progress, the SDK temp and the settle with the saved path", async () => {
		const { service, host } = setup({ downloadDirectory: FIXED })
		const watch = { onProgress: vi.fn(), onTemp: vi.fn(), onSettled: vi.fn() } satisfies DownloadWatch
		const [id = ""] = started(
			await service.startDownload({ items: [fileItem()], destination: { kind: "prefs" }, origin: "page", watch })
		)

		expect(watch.onTemp).toHaveBeenCalledWith(id, at(FIXED, `${FILE_UUID}.filendl`))
		host([
			{ k: "progress", id, size: 10, bytes: 3, files: null },
			{ k: "settled", id, outcome: "done", savedPath: at(FIXED, "a (1).txt") }
		])

		expect(watch.onProgress).toHaveBeenCalledWith(id, 3, 10)
		expect(watch.onSettled).toHaveBeenCalledWith({ id, outcome: "done", path: at(FIXED, "a (1).txt") })
	})
})

describe("transfers service: listings", () => {
	const entries = [
		{ segments: ["Projects"], directory: true, size: 0, mtimeMs: null, listIndex: null, source: 0 },
		{ segments: ["Projects", "b.txt"], directory: false, size: 5, mtimeMs: 2, listIndex: 0, source: 0 }
	]

	it("listTree holds the listing for demand until released", async () => {
		const { service, answers, supervisor } = setup()

		answers.transfersListTree = () => Promise.resolve({ ok: true, value: { entries } })

		expect(await service.listTree({ listingId: LISTING, items: [dirItem()], maxEntries: 100 })).toEqual({
			ok: true,
			value: { entries }
		})
		expect(supervisor.callTransfers).toHaveBeenCalledWith(
			"transfersListTree",
			{ listingId: LISTING, items: [{ ref: dirItem().ref, name: "Projects" }], maxEntries: 100 },
			"1",
			600_000
		)
		expect(service.active("1")).toBe(1)
		service.releaseTree(LISTING)

		expect(service.active("1")).toBe(0)
		expect(supervisor.callTransfersIfRunning).toHaveBeenCalledWith("transfersReleaseTree", { listingId: LISTING }, "1")
		expect(supervisor.ensure).toHaveBeenCalledWith("listing released")
	})

	it("a timed-out listTree releases the listing on a running host", async () => {
		const { service, answers, supervisor } = setup()

		answers.transfersListTree = () => Promise.resolve({ ok: false, error: { code: "timeout" } })

		expect(await service.listTree({ listingId: LISTING, items: [dirItem()], maxEntries: 100 })).toEqual({
			ok: false,
			error: { code: "timeout" }
		})
		expect(supervisor.callTransfersIfRunning).toHaveBeenCalledWith("transfersReleaseTree", { listingId: LISTING }, "1")
		expect(service.active()).toBe(0)
	})

	it("a listing main holds expires with the host's TTL", async () => {
		vi.useFakeTimers()

		const { service, answers, supervisor } = setup({ now: Date.now })

		answers.transfersListTree = () => Promise.resolve({ ok: true, value: { entries } })
		await service.listTree({ listingId: LISTING, items: [dirItem()], maxEntries: 100 })
		await vi.advanceTimersByTimeAsync(LISTING_TTL_MS - 1)
		expect(service.active()).toBe(1)
		await vi.advanceTimersByTimeAsync(1)

		expect(service.active()).toBe(0)
		expect(supervisor.ensure).toHaveBeenCalledWith("listing expired")
		expect(vi.getTimerCount()).toBe(0)
		vi.useRealTimers()
	})

	it("startListedDownload rows are not revealable", async () => {
		const { service, answers, specs, page, sent, journal } = setup()

		answers.transfersListTree = () => Promise.resolve({ ok: true, value: { entries } })
		await service.listTree({ listingId: LISTING, items: [dirItem()], maxEntries: 100 })
		service.subscribe(page, true)

		const temp = path.resolve("drag", "Projects", "b.txt")
		const [id] = started(
			await service.startListedDownload({
				listingId: LISTING,
				entries: [{ index: 0, path: temp, name: "b.txt", size: 5 }],
				watch: { onSettled: vi.fn() }
			})
		)

		expect(specs()).toEqual([{ id, t: "downloadListed", listingId: LISTING, index: 0, path: temp }])
		expect(sent.at(-1)).toEqual([
			{ t: "added", transfers: [expect.objectContaining({ origin: "drag", revealable: false, size: 5 }) as unknown] }
		])
		expect(journal.add).toHaveBeenCalledWith([{ id, dir: path.dirname(temp), names: [`${id ?? ""}.filendl`], tree: false }])
	})

	it("startListedDownload of a listing main does not hold answers invalidItem", async () => {
		const { service, supervisor } = setup()

		expect(
			await service.startListedDownload({
				listingId: LISTING,
				entries: [{ index: 0, path: path.resolve("x"), name: "x", size: 1 }],
				watch: { onSettled: vi.fn() }
			})
		).toEqual({ ok: false, error: { code: "invalidItem" } })
		expect(supervisor.callTransfers).not.toHaveBeenCalled()
	})

	it("a host stop drops the listings it held", async () => {
		const { service, answers } = setup()

		service.hostChanged({ state: "running" }, 1)
		answers.transfersListTree = () => Promise.resolve({ ok: true, value: { entries } })
		await service.listTree({ listingId: LISTING, items: [dirItem()], maxEntries: 100 })
		service.hostChanged({ state: "off" }, 1)

		expect(service.active()).toBe(0)
	})
})

describe("transfers service: reveal, open, uploads, directory pref", () => {
	async function finished(setupResult: ReturnType<typeof setup>, revealable?: boolean) {
		const { service, host } = setupResult
		const [id = ""] = started(
			await service.startDownload({
				items: [fileItem()],
				destination: { kind: "prefs" },
				origin: "page",
				...(revealable === undefined ? {} : { revealable })
			})
		)

		host([{ k: "settled", id, outcome: "done", savedPath: at(FIXED, "a.txt") }])

		return id
	}

	it("reveal answers localMissing for an evicted or missing path and calls showItemInFolder otherwise", async () => {
		const harness = setup({ downloadDirectory: FIXED })
		const id = await finished(harness)

		expect(await harness.service.reveal(id)).toEqual({ ok: false, error: { code: "localMissing" } })
		harness.disk.set(at(FIXED, "a.txt"), "file")
		expect(await harness.service.reveal(id)).toEqual({ ok: true, value: null })
		expect(harness.shell.showItemInFolder).toHaveBeenCalledWith(at(FIXED, "a.txt"))
		expect(await harness.service.reveal(LISTING)).toEqual({ ok: false, error: { code: "localMissing" } })
	})

	it("open opens a finished download and reports the shell's refusal", async () => {
		const harness = setup({ downloadDirectory: FIXED })
		const id = await finished(harness)

		harness.disk.set(at(FIXED, "a.txt"), "file")
		expect(await harness.service.open(id)).toEqual({ ok: true, value: null })
		harness.shell.openPath.mockResolvedValue("no application")
		expect(await harness.service.open(id)).toEqual({ ok: false, error: { code: "unknown", message: "no application" } })
	})

	it("a download that is not revealable is never revealed", async () => {
		const harness = setup({ downloadDirectory: FIXED })
		const id = await finished(harness, false)

		harness.disk.set(at(FIXED, "a.txt"), "file")

		expect(await harness.service.reveal(id)).toEqual({ ok: false, error: { code: "localMissing" } })
	})

	it("keeps the last 200 finished downloads for reveal", async () => {
		const harness = setup({ downloadDirectory: FIXED })
		const first = await finished(harness)

		harness.disk.set(at(FIXED, "a.txt"), "file")

		for (let n = 0; n < 200; n++) {
			await finished(harness)
		}

		expect(await harness.service.reveal(first)).toEqual({ ok: false, error: { code: "localMissing" } })
	})

	it("upload stats paths: directories become uploadDirectory specs, missing paths are skipped", async () => {
		const { service, disk, sizes, specs, log } = setup()
		const file = path.resolve("up", "b.txt")
		const dir = path.resolve("up", "Photos")

		disk.set(file, "file")
		sizes.set(file, 42)
		disk.set(dir, "directory")

		const result = await service.startUpload({ paths: [file, path.resolve("up", "gone.txt"), dir], parent: PARENT, origin: "page" })

		expect(result).toEqual({ ok: true, value: { status: "started", ids: specs().map(spec => spec.id), skipped: [1] } })
		expect(specs()).toEqual([
			{ id: expect.stringMatching(UUID) as string, t: "uploadFile", path: file, parent: PARENT.ref },
			{ id: expect.stringMatching(UUID) as string, t: "uploadDirectory", path: dir, parent: PARENT.ref, name: "Photos" }
		])
		expect(log.warn).toHaveBeenCalledWith(expect.stringContaining(path.resolve("up", "gone.txt")))
	})

	it("an upload row names its parent and size", async () => {
		const { service, disk, sizes, page, sent } = setup()
		const file = path.resolve("up", "b.txt")

		disk.set(file, "file")
		sizes.set(file, 42)
		service.subscribe(page, true)
		await service.startUpload({ paths: [file], parent: PARENT, origin: "page" })

		expect(sent.at(-1)).toEqual([
			{
				t: "added",
				transfers: [
					expect.objectContaining({
						direction: "upload",
						kind: "file",
						name: "b.txt",
						parentUuid: PARENT_UUID,
						size: 42,
						revealable: false
					}) as unknown
				]
			}
		])
	})

	it("an upload with no usable path calls no host", async () => {
		const { service, supervisor } = setup()

		expect(await service.startUpload({ paths: [path.resolve("gone")], parent: PARENT, origin: "page" })).toEqual({
			ok: true,
			value: { status: "started", ids: [], skipped: [0] }
		})
		expect(supervisor.callTransfers).not.toHaveBeenCalled()
	})

	it("splits a start whose SDK values pass 16 MiB into several host calls", async () => {
		const { service, disk, startCalls } = setup()
		const parent = { uuid: PARENT_UUID, ref: { variant: "AnyNormalDir.Dir" as const, value: "x".repeat(8000) } }
		const paths = Array.from({ length: 2500 }, (_, n) => path.resolve("up", `${String(n)}.txt`))

		for (const file of paths) {
			disk.set(file, "file")
		}

		const ids = started(await service.startUpload({ paths, parent, origin: "page" }))

		expect(ids).toHaveLength(2500)
		expect(startCalls().length).toBeGreaterThan(1)
		expect(
			startCalls()
				.flatMap(call => call.specs)
				.map(spec => spec.id)
		).toEqual(ids)
	})

	it("a failed later batch cancels the acked rows of earlier batches and ends the rest", async () => {
		const { service, disk, answers, supervisor, startCalls, host, page, sent } = setup()
		const parent = { uuid: PARENT_UUID, ref: { variant: "AnyNormalDir.Dir" as const, value: "x".repeat(8000) } }
		const paths = Array.from({ length: 2500 }, (_, n) => path.resolve("up", `${String(n)}.txt`))
		let calls = 0

		for (const file of paths) {
			disk.set(file, "file")
		}

		answers.transfersStart = () =>
			Promise.resolve(++calls === 1 ? { ok: true, value: null } : { ok: false, error: { code: "unknown" } })
		service.subscribe(page, true)

		const result = await service.startUpload({ paths, parent, origin: "page" })

		expect(result).toEqual({ ok: false, error: { code: "unknown" } })

		const all = sent.flat().flatMap(event => (event.t === "added" ? event.transfers.map(row => row.id) : []))
		const acked = startCalls()[0]?.specs.map(spec => spec.id) ?? []

		expect(startCalls().length).toBeGreaterThan(1)
		expect(supervisor.callTransfersIfRunning).toHaveBeenCalledWith("transfersCancel", { ids: acked }, "1")
		expect(
			sent
				.flat()
				.filter(event => event.t === "settled")
				.map(event => (event.t === "settled" ? event.id : ""))
		).toEqual(all.slice(acked.length))
		expect(service.active()).toBe(acked.length)

		host(acked.map(id => ({ k: "settled", id, outcome: "cancelled" })))
		expect(service.active()).toBe(0)
	})

	it("more picked paths than one host call takes go in calls of TRANSFER_ITEMS_MAX specs", async () => {
		const { service, dialogs, disk, startCalls } = setup()
		const paths = Array.from({ length: TRANSFER_ITEMS_MAX + 1 }, (_, n) => path.resolve("up", `${String(n)}.txt`))

		for (const file of paths) {
			disk.set(file, "file")
		}

		dialogs.open.mockResolvedValue(paths)
		await service.pickUpload("file", PARENT)

		expect(startCalls().map(call => call.specs.length)).toEqual([TRANSFER_ITEMS_MAX, 1])
	})

	it("pickUpload opens a native dialog and uploads its paths", async () => {
		const { service, dialogs, disk, specs } = setup()
		const picked = path.resolve("up", "Photos")

		disk.set(picked, "directory")
		dialogs.open.mockResolvedValue([picked])

		const result = await service.pickUpload("directory" satisfies DesktopTransferKind, PARENT)

		expect(dialogs.open).toHaveBeenCalledWith({ properties: ["openDirectory", "multiSelections"] })
		expect(result).toEqual({ ok: true, value: { status: "started", ids: [specs()[0]?.id] } })

		dialogs.open.mockResolvedValue(null)
		expect(await service.pickUpload("file", PARENT)).toEqual({ ok: true, value: { status: "canceled" } })
		expect(dialogs.open).toHaveBeenLastCalledWith({ properties: ["openFile", "multiSelections"] })
	})

	it("chooseDownloadDirectory stores and returns the chosen path", async () => {
		const { service, dialogs, prefs } = setup()

		dialogs.open.mockResolvedValue([FIXED])

		expect(await service.chooseDownloadDirectory()).toEqual({ status: "chosen", path: FIXED })
		expect(dialogs.open).toHaveBeenCalledWith({ properties: ["openDirectory", "createDirectory"], defaultPath: DOWNLOADS })
		expect(prefs.setDownloadDirectory).toHaveBeenCalledWith(FIXED)

		dialogs.open.mockResolvedValue(null)
		expect(await service.chooseDownloadDirectory()).toEqual({ status: "canceled" })
		expect(dialogs.open).toHaveBeenLastCalledWith({ properties: ["openDirectory", "createDirectory"], defaultPath: FIXED })
	})
})
