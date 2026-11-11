import path from "node:path"
import type { DesktopSdkRef, DesktopSdkVariant } from "@filen/shared/desktop"
import { ubrnOf, wasmOf } from "@filen/shared/sdkShapes"
import { parseEnvelope, stringifyEnvelope } from "@filen/shared/session"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { FEED_INTERVAL_MS } from "../native/reducer.ts"
import { classifyTransfer, TransferCommitError } from "../native/transferErrors.ts"
import { createTransferRegistry, type DirDownloadCallback, type DirUploadCallback, type ManagedFuture } from "../native/transfers.ts"
import {
	type FromNative,
	LISTING_TTL_MS,
	type NativeTransferEvent,
	type NativeTransferSpec,
	TRANSFER_EVENTS_MAX
} from "../shared/nativeProtocol.ts"
import { memoryFs } from "./fileFakes.ts"
import {
	FakeManagedAbortSignal,
	FakePauseSignal,
	FakeTransferClient,
	fakeSdk,
	fakeTransferSdk,
	REMOTE_ROOT,
	sdkError,
	wasmDir,
	wasmFile
} from "./nativeFakes.ts"

const hoisted = vi.hoisted(() => ({ client: null as unknown }))

// The host itself (native/index.ts), for the test that transfer ops need no engine: its addon, client and engine.
vi.mock("../native/addon.ts", async () => {
	const fakes = await import("./nativeFakes.ts")

	return { loadAddon: () => ({ ...fakes.fakeSdk, ...fakes.fakeTransferSdk }) }
})
vi.mock("../native/client.ts", () => ({ clientFromSession: () => hoisted.client }))
vi.mock("../native/engine.ts", () => ({ openEngine: () => new Promise(() => undefined) }))

const DIR = path.resolve("downloads")
const at = (...names: string[]) => path.join(DIR, ...names)
const ID = "0d3c6b1e-8f4a-4c2d-9b7e-5a1f3e2d4c6b"
const ID2 = "1e4d7c2f-9a5b-4d3e-8c8f-6b2a4f3e5d7c"
const FILE_UUID = "4f8e2c1a-3b5d-4e6f-8a9b-0c1d2e3f4a5b"
const DIR_UUID = "6c5d4e3f-2a1b-4c0d-9e8f-7a6b5c4d3e2f"
const NEW_DIR_UUID = "7d6e5f4a-3b2c-4d1e-8f9a-8b7c6d5e4f3a"
const LISTING = "2f5e8d3a-0b6c-4e4f-9d9a-7c3b5a4f6e8d"

function ref(variant: DesktopSdkVariant, value: unknown): DesktopSdkRef {
	return { variant, value: stringifyEnvelope(value) }
}

const FILE_REF = ref("AnyFile.File", wasmFile(FILE_UUID, 100_000n))
const PARENT_REF = ref("AnyNormalDir.Dir", wasmDir(DIR_UUID, "parent"))
const DIR_REF = ref("AnyDirWithContext.Normal.Dir", wasmDir(DIR_UUID, "Projects"))

function innerOf(value: unknown): unknown {
	return (value as { inner: unknown[] }).inner[0]
}

// What napi returns for these items.
const ubrnFile = (uuid = FILE_UUID, size = 100_000n) => innerOf(ubrnOf("AnyFile.File", wasmFile(uuid, size)))
const ubrnDir = (uuid = NEW_DIR_UUID) => innerOf(ubrnOf("AnyNormalDir.Dir", wasmDir(uuid, "Photos")))

function downloadFile(
	id = ID,
	target = at("a.txt"),
	conflict: "replace" | "keepBoth" = "keepBoth"
): Extract<NativeTransferSpec, { t: "downloadFile" }> {
	return { id, t: "downloadFile", file: FILE_REF, path: target, conflict }
}

function setup(options: { platform?: NodeJS.Platform } = {}) {
	const client = new FakeTransferClient()
	const { fs, state } = memoryFs()
	const posts: FromNative[] = []
	const quarantine = { mark: vi.fn((_files: readonly string[], _directories: readonly string[]) => Promise.resolve()) }
	const onAuthFailed = vi.fn()
	const warn = vi.fn()
	const registry = createTransferRegistry({
		client,
		sdk: fakeTransferSdk,
		fs,
		quarantine,
		platform: options.platform ?? "darwin",
		post: message => {
			posts.push(message)
		},
		onAuthFailed,
		log: { warn }
	})
	const events = (): NativeTransferEvent[] => posts.flatMap(message => (message.t === "transfers" ? message.events : []))
	const settled = (id = ID) => events().find(event => event.k === "settled" && event.id === id)

	return { client, fs, state, posts, quarantine, onAuthFailed, warn, registry, events, settled }
}

// Lets the registry's awaits run, then one round.
const flush = () => vi.advanceTimersByTimeAsync(0)
const round = () => vi.advanceTimersByTimeAsync(FEED_INTERVAL_MS)

function futureOf(call: { args: unknown[] }): ManagedFuture {
	return call.args[3] as ManagedFuture
}

beforeEach(() => {
	vi.useFakeTimers()
})

afterEach(() => {
	vi.useRealTimers()
})

describe("transfer registry", () => {
	it("coalesces byte deltas into one progress event per interval", async () => {
		const { client, registry, posts } = setup()

		registry.start([downloadFile()])
		await flush()

		const callback = client.last("downloadFileToPath").args[2] as { onUpdate(bytes: bigint): void }

		for (let i = 0; i < 50; i++) {
			callback.onUpdate(1000n)
			await vi.advanceTimersByTimeAsync(4)
		}

		await round()

		expect(posts).toEqual([{ t: "transfers", events: [{ k: "progress", id: ID, size: 100_000, bytes: 50_000, files: null }] }])
	})

	it("posts nothing while idle", async () => {
		const { client, state, registry } = setup()

		expect(vi.getTimerCount()).toBe(0)
		registry.start([downloadFile()])
		await flush()
		state.files.add(at(`${ID}.filendl`))
		client.last("downloadFileToPath").resolve()
		await round()
		await round()

		expect(vi.getTimerCount()).toBe(0)
		expect(registry.active()).toBe(0)
	})

	it("orders a transfer's last progress before its settle in the same round", async () => {
		const { client, state, registry, posts } = setup()

		registry.start([downloadFile()])
		await round()
		posts.length = 0
		;(client.last("downloadFileToPath").args[2] as { onUpdate(bytes: bigint): void }).onUpdate(100_000n)
		state.files.add(at(`${ID}.filendl`))
		client.last("downloadFileToPath").resolve()
		await round()

		expect(posts).toHaveLength(1)
		expect(posts[0]).toEqual({
			t: "transfers",
			events: [
				{ k: "progress", id: ID, size: 100_000, bytes: 100_000, files: null },
				{ k: "settled", id: ID, outcome: "done", savedPath: at("a.txt") }
			]
		})
	})

	it("passes a required managedFuture with a ManagedAbortController signal and a PauseSignal", async () => {
		const { client, registry } = setup()

		registry.start([downloadFile()])
		await flush()

		const future = futureOf(client.last("downloadFileToPath"))

		expect(Object.keys(future).sort()).toEqual(["abortSignal", "pauseSignal"])
		expect(future.abortSignal).toBeInstanceOf(FakeManagedAbortSignal)
		expect(future.pauseSignal).toBeInstanceOf(FakePauseSignal)
	})

	it("cancel aborts the controller and settles cancelled", async () => {
		const { client, registry, settled } = setup()

		registry.start([downloadFile()])
		await flush()

		const call = client.last("downloadFileToPath")

		registry.cancel([ID])
		expect((futureOf(call).abortSignal as FakeManagedAbortSignal).aborted()).toBe(true)
		call.reject(sdkError(fakeSdk.ErrorKind.Cancelled))
		await round()

		expect(settled()).toEqual({ k: "settled", id: ID, outcome: "cancelled" })
	})

	it("cancelling an unknown id does nothing", async () => {
		const { registry, posts } = setup()

		registry.cancel([ID2])
		await round()

		expect(posts).toEqual([])
		expect(vi.getTimerCount()).toBe(0)
	})

	it("pause and resume call the transfer's PauseSignal and post nothing", async () => {
		const { client, registry, posts } = setup()

		registry.start([downloadFile()])
		await round()

		const pause = futureOf(client.last("downloadFileToPath")).pauseSignal as FakePauseSignal
		const before = posts.length

		registry.setPaused([ID], true)
		expect(pause.isPaused()).toBe(true)
		registry.setPaused([ID], false)
		expect(pause.isPaused()).toBe(false)
		await round()

		expect(posts).toHaveLength(before)
	})

	it("uploadDirectory creates the directory under the parent, uploads into it and settles with the Dir", async () => {
		const { client, registry, settled } = setup()
		const local = path.resolve("Photos")

		registry.start([{ id: ID, t: "uploadDirectory", path: local, parent: PARENT_REF, name: "Photos" }])
		await flush()

		const create = client.last("createDir")

		expect(create.args).toEqual([ubrnOf("AnyNormalDir.Dir", wasmDir(DIR_UUID, "parent")), "Photos"])
		create.resolve(ubrnDir())
		await flush()

		const upload = client.last("uploadDirRecursively")

		expect(upload.args[0]).toBe(local)
		expect(upload.args[2]).toEqual(ubrnDir())
		upload.resolve()
		await round()

		const event = settled()

		expect(event).toMatchObject({ outcome: "done" })
		expect(parseEnvelope((event as { uploaded: string }).uploaded)).toEqual(wasmOf("Dir", ubrnDir()))
	})

	it("a root parent uses client.root() without a request", async () => {
		const { client, state, registry, settled } = setup()
		const local = path.resolve("b.txt")

		state.files.add(local)
		state.sizes.set(local, 42)
		registry.start([{ id: ID, t: "uploadFile", path: local, parent: ref("AnyNormalDir.Root", { uuid: REMOTE_ROOT }) }])
		await flush()

		const upload = client.last("uploadFile")

		expect(client.root).toHaveBeenCalledOnce()
		expect(client.of("createDir")).toEqual([])
		expect(upload.args[0]).toEqual({
			parent: { tag: "Root", inner: [{ uuid: REMOTE_ROOT }] },
			name: undefined,
			created: undefined,
			modified: undefined,
			mime: undefined,
			noExif: false,
			noExifOverride: false
		})
		expect(upload.args[1]).toBe(local)
		upload.resolve(ubrnFile())
		await round()

		expect(parseEnvelope((settled() as { uploaded: string }).uploaded)).toEqual(wasmFile(FILE_UUID, 100_000n))
	})

	it("counts directory files done and failed and settles completedWithErrors", async () => {
		const { client, registry, events, settled } = setup()

		registry.start([{ id: ID, t: "uploadDirectory", path: path.resolve("Photos"), parent: PARENT_REF, name: "Photos" }])
		await flush()
		client.last("createDir").resolve(ubrnDir())
		await flush()

		const upload = client.last("uploadDirRecursively")
		const callback = upload.args[1] as DirUploadCallback

		callback.onScanComplete(1n, 3n, 300n)
		callback.onUploadUpdate([], [ubrnFile(), ubrnFile()], 200n)
		callback.onUploadErrors([{ path: path.resolve("Photos", "c.jpg"), error: sdkError(fakeSdk.ErrorKind.Io) }])
		upload.resolve()
		await round()

		expect(events()[0]).toEqual({
			k: "progress",
			id: ID,
			size: 300,
			bytes: 200,
			files: { total: 3, done: 2, failed: 1, failedBytes: 0 }
		})
		expect(settled()).toMatchObject({ outcome: "completedWithErrors" })
	})

	it("a directory download whose scan total exceeds done plus failed settles completedWithErrors", async () => {
		const { client, state, registry, settled } = setup()

		registry.start([{ id: ID, t: "downloadDirectory", dir: DIR_REF, path: at("Projects") }])
		await flush()

		const download = client.last("downloadDirRecursively")
		const callback = download.args[1] as DirDownloadCallback

		expect(state.dirs.has(at("Projects"))).toBe(true)
		expect(download.args[0]).toBe(at("Projects"))
		expect(download.args[2]).toEqual(ubrnOf("AnyDirWithContext.Normal.Dir", wasmDir(DIR_UUID, "Projects")))
		callback.onScanComplete(0n, 3n, 30n)
		callback.onDownloadUpdate([], [{ path: "a" }, { path: "b" }], 20n)
		download.resolve()
		await round()

		expect(settled()).toEqual({ k: "settled", id: ID, outcome: "completedWithErrors", savedPath: at("Projects") })
	})

	it("an unauthenticated failure calls onAuthFailed once", async () => {
		const { client, registry, onAuthFailed, settled } = setup()

		registry.start([downloadFile(), downloadFile(ID2, path.resolve("other", "a.txt"))])
		await flush()

		for (const call of client.of("downloadFileToPath")) {
			call.reject(sdkError(fakeSdk.ErrorKind.Unauthenticated))
		}

		await round()

		expect(onAuthFailed).toHaveBeenCalledOnce()
		expect(settled()).toMatchObject({ outcome: "error", error: { code: "unauthenticated", kind: "Unauthenticated" } })
		expect(settled(ID2)).toMatchObject({ outcome: "error", error: { code: "unauthenticated" } })
	})

	it("a payload the converter refuses settles invalidItem", async () => {
		const { client, registry, settled } = setup()

		registry.start([{ ...downloadFile(), file: ref("AnyFile.File", { uuid: FILE_UUID }) }])
		await round()

		expect(client.calls).toEqual([])
		expect(settled()).toMatchObject({ outcome: "error", error: { code: "invalidItem" } })
	})

	it("a file download goes through <id>.filendl and settles with the committed path", async () => {
		const { client, state, registry, settled } = setup()

		state.files.add(at("a.txt"))
		registry.start([downloadFile()])
		await flush()

		const call = client.last("downloadFileToPath")

		expect(call.args[0]).toEqual(ubrnOf("AnyFile.File", wasmFile(FILE_UUID, 100_000n)))
		expect(call.args[1]).toBe(at(`${ID}.filendl`))
		state.files.add(at(`${ID}.filendl`))
		call.resolve()
		await round()

		expect(settled()).toEqual({ k: "settled", id: ID, outcome: "done", savedPath: at("a (1).txt") })
		expect(state.files).toEqual(new Set([at("a.txt"), at("a (1).txt")]))
	})

	it("a cancelled file download removes its staging file", async () => {
		const { client, state, registry } = setup()

		registry.start([downloadFile()])
		await flush()
		state.files.add(at(`${ID}.filendl`))
		registry.cancel([ID])
		client.last("downloadFileToPath").reject(sdkError(fakeSdk.ErrorKind.Cancelled))
		await round()

		expect(state.files.size).toBe(0)
	})

	it("a cancel landing after the download but before the commit settles cancelled and removes the staging file", async () => {
		const { client, state, registry, quarantine, settled } = setup()

		registry.start([downloadFile()])
		await flush()
		state.files.add(at(`${ID}.filendl`))
		client.last("downloadFileToPath").resolve()
		registry.cancel([ID])
		await round()

		expect(settled()).toEqual({ k: "settled", id: ID, outcome: "cancelled" })
		expect(state.files.size).toBe(0)
		expect(quarantine.mark).not.toHaveBeenCalled()
	})

	it("a cancel landing once the commit started settles done", async () => {
		const { client, state, registry, settled } = setup()

		registry.start([downloadFile()])
		await flush()
		state.files.add(at(`${ID}.filendl`))
		state.fail = op => {
			if (op === "link") {
				registry.cancel([ID])
			}

			return undefined
		}
		client.last("downloadFileToPath").resolve()
		await round()

		expect(settled()).toEqual({ k: "settled", id: ID, outcome: "done", savedPath: at("a.txt") })
		expect(state.files).toEqual(new Set([at("a.txt")]))
	})

	it("cancel while paused resumes before it aborts", async () => {
		const { client, registry } = setup()

		registry.start([downloadFile()])
		await flush()

		const future = futureOf(client.last("downloadFileToPath"))
		const pause = future.pauseSignal as FakePauseSignal

		registry.setPaused([ID], true)

		const resume = vi.spyOn(pause, "resume")
		const abort = vi.spyOn(future.abortSignal as FakeManagedAbortSignal, "markAborted")

		registry.cancel([ID])

		expect(pause.isPaused()).toBe(false)
		expect(resume.mock.invocationCallOrder[0]).toBeLessThan(abort.mock.invocationCallOrder[0] ?? 0)
	})

	it("abortAll resumes paused transfers before it aborts them", async () => {
		const { client, registry } = setup()

		registry.start([downloadFile()])
		await flush()

		const pause = futureOf(client.last("downloadFileToPath")).pauseSignal as FakePauseSignal

		registry.setPaused([ID], true)
		registry.abortAll()

		expect(pause.isPaused()).toBe(false)
	})

	it("a replace download renames over the target", async () => {
		const { client, state, registry, settled } = setup()

		state.files.add(at("a.txt"))
		registry.start([downloadFile(ID, at("a.txt"), "replace")])
		await flush()
		state.files.add(at(`${ID}.filendl`))
		client.last("downloadFileToPath").resolve()
		await round()

		expect(settled()).toEqual({ k: "settled", id: ID, outcome: "done", savedPath: at("a.txt") })
		expect(state.files).toEqual(new Set([at("a.txt")]))
	})

	it("a failed file download removes its staging file", async () => {
		const { client, state, registry, settled } = setup()

		registry.start([downloadFile()])
		await flush()
		state.files.add(at(`${ID}.filendl`))
		client.last("downloadFileToPath").reject(sdkError(fakeSdk.ErrorKind.Io, "Broken pipe (os error 32)"))
		await round()

		expect(settled()).toMatchObject({ outcome: "error", error: { code: "unknown", kind: "Io" } })
		expect(state.files.size).toBe(0)
	})

	it("a transfer cancelled before its SDK call starts settles cancelled without calling the SDK", async () => {
		const { client, registry, settled } = setup()

		registry.start([downloadFile()])
		registry.cancel([ID])
		await round()

		expect(client.of("downloadFileToPath")).toEqual([])
		expect(settled()).toEqual({ k: "settled", id: ID, outcome: "cancelled" })
	})

	it("a download cancelled while it waits behind the same file settles cancelled and never starts", async () => {
		const { client, state, registry, settled } = setup()

		registry.start([downloadFile(), downloadFile(ID2, at("a.txt"))])
		await flush()
		registry.cancel([ID2])
		state.files.add(at(`${ID}.filendl`))
		client.last("downloadFileToPath").resolve()
		await round()

		expect(client.of("downloadFileToPath")).toHaveLength(1)
		expect(settled()).toMatchObject({ outcome: "done" })
		expect(settled(ID2)).toEqual({ k: "settled", id: ID2, outcome: "cancelled" })
	})

	it("a failed or cancelled directory download leaves what it wrote", async () => {
		const { client, state, registry, settled } = setup()

		registry.start([
			{ id: ID, t: "downloadDirectory", dir: DIR_REF, path: at("Projects") },
			{ id: ID2, t: "downloadDirectory", dir: DIR_REF, path: at("Other") }
		])
		await flush()

		const [failing, cancelling] = client.of("downloadDirRecursively")

		failing?.reject(sdkError(fakeSdk.ErrorKind.Io, "Broken pipe (os error 32)"))
		registry.cancel([ID2])
		cancelling?.reject(sdkError(fakeSdk.ErrorKind.Cancelled))
		await round()

		expect(settled()).toMatchObject({ outcome: "error" })
		expect(settled(ID2)).toMatchObject({ outcome: "cancelled" })
		expect(state.dirs).toEqual(new Set([at("Projects"), at("Other")]))
	})

	it("two downloads of one file into one directory run one after the other", async () => {
		const { client, state, registry } = setup()

		registry.start([downloadFile(), downloadFile(ID2, at("a.txt"))])
		await flush()

		expect(client.of("downloadFileToPath")).toHaveLength(1)
		state.files.add(at(`${ID}.filendl`))
		client.last("downloadFileToPath").resolve()
		await flush()

		expect(client.of("downloadFileToPath")).toHaveLength(2)
		expect(client.last("downloadFileToPath").args[1]).toBe(at(`${ID2}.filendl`))
	})

	it("listTree returns tooMany past maxEntries and holds nothing", async () => {
		const { client, registry } = setup()
		const listed = registry.listTree({ listingId: LISTING, items: [{ ref: DIR_REF, name: "Projects" }], maxEntries: 2 })

		await flush()
		client.last("listDirRecursiveWithPaths").resolve({
			dirs: [],
			files: [
				{ path: "a.txt", file: ubrnFile() },
				{ path: "b.txt", file: ubrnFile() },
				{ path: "c.txt", file: ubrnFile() }
			]
		})

		await expect(listed).resolves.toEqual({ tooMany: 4 })
		expect(registry.active()).toBe(0)
		expect(vi.getTimerCount()).toBe(0)
	})

	it("a held listing is dropped after 30 minutes unused", async () => {
		const { client, registry } = setup()
		const listed = registry.listTree({ listingId: LISTING, items: [{ ref: DIR_REF, name: "Projects" }], maxEntries: 100 })

		await flush()
		client
			.last("listDirRecursiveWithPaths")
			.resolve({ dirs: [{ path: "a", dir: ubrnDir() }], files: [{ path: "a/b.txt", file: ubrnFile() }] })

		await expect(listed).resolves.toEqual({
			entries: [
				{ segments: ["Projects"], directory: true, size: 0, mtimeMs: null, listIndex: null, source: 0 },
				{ segments: ["Projects", "a"], directory: true, size: 0, mtimeMs: null, listIndex: null, source: 0 },
				{ segments: ["Projects", "a", "b.txt"], directory: false, size: 100_000, mtimeMs: 2, listIndex: 0, source: 0 }
			]
		})
		expect(registry.active()).toBe(1)
		await vi.advanceTimersByTimeAsync(LISTING_TTL_MS - 1)
		expect(registry.active()).toBe(1)
		await vi.advanceTimersByTimeAsync(1)

		expect(registry.active()).toBe(0)
		expect(vi.getTimerCount()).toBe(0)
	})

	it("a listing released while it runs is not held", async () => {
		const { client, registry } = setup()
		const listed = registry.listTree({ listingId: LISTING, items: [{ ref: DIR_REF, name: "Projects" }], maxEntries: 100 })

		await flush()
		registry.releaseTree(LISTING)
		client.last("listDirRecursiveWithPaths").resolve({ dirs: [], files: [{ path: "b.txt", file: ubrnFile() }] })
		await listed

		expect(registry.active()).toBe(0)
	})

	it("downloadListed reads the held listing and an unknown index settles invalidItem", async () => {
		const { client, state, registry, settled } = setup()
		const listed = registry.listTree({
			listingId: LISTING,
			items: [
				{ ref: DIR_REF, name: "Projects" },
				{ ref: FILE_REF, name: "a.txt" }
			],
			maxEntries: 100
		})

		await flush()
		client.last("listDirRecursiveWithPaths").resolve({ dirs: [], files: [{ path: "b.txt", file: ubrnFile() }] })
		const result = await listed

		expect("entries" in result ? result.entries.at(-1) : result).toEqual({
			segments: ["a.txt"],
			directory: false,
			size: 100_000,
			mtimeMs: 2,
			listIndex: null,
			source: 1
		})

		const temp = path.resolve("drag", "b.txt")

		registry.start([
			{ id: ID, t: "downloadListed", listingId: LISTING, index: 0, path: temp },
			{ id: ID2, t: "downloadListed", listingId: LISTING, index: 5, path: path.resolve("drag", "c.txt") }
		])
		await flush()

		const call = client.last("downloadFileToPath")

		expect(call.args[0]).toEqual({ tag: "File", inner: [ubrnFile()] })
		state.files.add(path.resolve("drag", `${ID}.filendl`))
		call.resolve()
		await round()

		expect(settled()).toEqual({ k: "settled", id: ID, outcome: "done", savedPath: temp })
		expect(settled(ID2)).toMatchObject({ outcome: "error", error: { code: "invalidItem" } })
	})

	it("abortAll aborts every running transfer and posts nothing", async () => {
		const { client, registry, posts } = setup()

		registry.start([downloadFile(), downloadFile(ID2, path.resolve("other", "a.txt"))])
		await flush()
		registry.abortAll()
		expect(client.of("downloadFileToPath")).toHaveLength(2)

		for (const call of client.of("downloadFileToPath")) {
			expect((futureOf(call).abortSignal as FakeManagedAbortSignal).aborted()).toBe(true)
			call.reject(sdkError(fakeSdk.ErrorKind.Cancelled))
		}

		await round()
		await round()

		expect(posts).toEqual([])
		expect(vi.getTimerCount()).toBe(0)
	})

	it("abortAll, then calls that resolve, posts nothing", async () => {
		const { client, state, registry, posts, quarantine } = setup()

		registry.start([
			downloadFile(),
			{ id: ID2, t: "uploadDirectory", path: path.resolve("Photos"), parent: PARENT_REF, name: "Photos" }
		])
		await flush()
		registry.abortAll()
		state.files.add(at(`${ID}.filendl`))
		client.last("downloadFileToPath").resolve()
		client.last("createDir").resolve(ubrnDir())
		await round()
		await round()

		expect(posts).toEqual([])
		expect(client.of("uploadDirRecursively")).toEqual([])
		expect(quarantine.mark).not.toHaveBeenCalled()
		expect(vi.getTimerCount()).toBe(0)
	})

	it("reports an unauthenticated failure again after the next start", async () => {
		const { client, registry, onAuthFailed } = setup()

		registry.start([downloadFile()])
		await flush()
		client.last("downloadFileToPath").reject(sdkError(fakeSdk.ErrorKind.Unauthenticated))
		await round()
		registry.start([downloadFile(ID2)])
		await flush()
		client.last("downloadFileToPath").reject(sdkError(fakeSdk.ErrorKind.Unauthenticated))
		await round()

		expect(onAuthFailed).toHaveBeenCalledTimes(2)
	})

	it("splits a round past TRANSFER_EVENTS_MAX events into several posts", async () => {
		const { registry, posts, events } = setup()
		const specs = Array.from({ length: TRANSFER_EVENTS_MAX + 1 }, (_, n) =>
			downloadFile(`${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`, at(String(n), "a.txt"))
		)

		registry.start(specs)
		registry.cancel(specs.map(spec => spec.id))
		await round()

		expect(posts.length).toBeGreaterThan(1)
		expect(posts.every(message => message.t === "transfers" && message.events.length <= TRANSFER_EVENTS_MAX)).toBe(true)
		expect(events().filter(event => event.k === "settled")).toHaveLength(TRANSFER_EVENTS_MAX + 1)
	})

	it("progress while a listing is held posts after one interval, not at the listing's expiry", async () => {
		const { client, registry, posts } = setup()
		const listed = registry.listTree({ listingId: LISTING, items: [{ ref: DIR_REF, name: "Projects" }], maxEntries: 100 })

		await flush()
		client.last("listDirRecursiveWithPaths").resolve({ dirs: [], files: [{ path: "b.txt", file: ubrnFile() }] })
		await listed
		registry.start([downloadFile()])
		await flush()
		;(client.last("downloadFileToPath").args[2] as { onUpdate(bytes: bigint): void }).onUpdate(10n)
		await round()

		expect(posts).toEqual([{ t: "transfers", events: [{ k: "progress", id: ID, size: 100_000, bytes: 10, files: null }] }])
		expect(registry.active()).toBe(2)
	})

	it("a committed file and each directory batch are marked by quarantine", async () => {
		const { client, state, registry, quarantine } = setup()

		registry.start([downloadFile(), { id: ID2, t: "downloadDirectory", dir: DIR_REF, path: at("Projects") }])
		await flush()
		state.files.add(at(`${ID}.filendl`))
		client.last("downloadFileToPath").resolve()

		const download = client.last("downloadDirRecursively")

		;(download.args[1] as DirDownloadCallback).onDownloadUpdate([{ path: "sub" }], [{ path: "sub/x.txt" }], 1n)
		download.resolve()
		await round()

		expect(quarantine.mark.mock.calls).toEqual([
			[[at("Projects", "sub", "x.txt")], [at("Projects", "sub")]],
			[[at("a.txt")], []]
		])
	})

	it("batches that arrive while a mark is in flight join one next mark, which the transfer waits for", async () => {
		const { client, registry, quarantine, settled } = setup()
		let release: () => void = () => undefined

		quarantine.mark.mockImplementationOnce(
			() =>
				new Promise<void>(resolve => {
					release = resolve
				})
		)
		registry.start([{ id: ID2, t: "downloadDirectory", dir: DIR_REF, path: at("Projects") }])
		await flush()

		const download = client.last("downloadDirRecursively")
		const update = (download.args[1] as DirDownloadCallback).onDownloadUpdate

		update([], [{ path: "a" }], 1n)
		update([{ path: "d" }], [{ path: "b" }], 1n)
		update([], [{ path: "c" }], 1n)
		download.resolve()
		await round()

		expect(quarantine.mark).toHaveBeenCalledTimes(1)
		expect(settled(ID2)).toBeUndefined()

		release()
		await round()

		expect(quarantine.mark.mock.calls).toEqual([
			[[at("Projects", "a")], []],
			[[at("Projects", "b"), at("Projects", "c")], [at("Projects", "d")]]
		])
		expect(settled(ID2)).toMatchObject({ outcome: "done" })
	})

	it("a quarantine failure is logged and the transfer still settles done", async () => {
		const { client, state, registry, quarantine, warn, settled } = setup()

		quarantine.mark.mockRejectedValue(new Error("EPERM"))
		registry.start([downloadFile()])
		await flush()
		state.files.add(at(`${ID}.filendl`))
		client.last("downloadFileToPath").resolve()
		await round()

		expect(settled()).toMatchObject({ outcome: "done" })
		expect(warn).toHaveBeenCalledWith(expect.stringContaining(at("a.txt")))
	})
})

describe("classifyTransfer", () => {
	it("names local failures from the SDK's io text and from node's codes", () => {
		const io = (message: string, platform: NodeJS.Platform) =>
			classifyTransfer(fakeTransferSdk, sdkError(fakeSdk.ErrorKind.Io, message), platform).code

		expect(io("No such file or directory (os error 2)", "darwin")).toBe("localMissing")
		expect(io("Permission denied (os error 13)", "linux")).toBe("localDenied")
		expect(io("No space left on device (os error 28)", "linux")).toBe("localFull")
		expect(io("Broken pipe (os error 32)", "linux")).toBe("unknown")
		expect(io("The system cannot find the path specified. (os error 3)", "win32")).toBe("localMissing")
		expect(io("Access is denied. (os error 5)", "win32")).toBe("localDenied")
		expect(io("The process cannot access the file because it is being used by another process. (os error 32)", "win32")).toBe(
			"localInUse"
		)
		expect(io("There is not enough space on the disk. (os error 112)", "win32")).toBe("localFull")
		expect(classifyTransfer(fakeTransferSdk, Object.assign(new Error("x"), { code: "ENOSPC" })).code).toBe("localFull")
		expect(classifyTransfer(fakeTransferSdk, new TransferCommitError("localInUse", "in use")).code).toBe("localInUse")
	})

	it("reads io codes as Win32 error codes on win32 only", () => {
		const io = (os: number, platform: NodeJS.Platform) =>
			classifyTransfer(fakeTransferSdk, sdkError(fakeSdk.ErrorKind.Io, `x (os error ${String(os)})`), platform).code

		expect([32, 33, 39, 112, 16].map(os => io(os, "win32"))).toEqual(["localInUse", "localInUse", "localFull", "localFull", "unknown"])
		expect([32, 33, 39, 112, 16].map(os => io(os, "linux"))).toEqual(["unknown", "unknown", "unknown", "unknown", "localInUse"])
		expect([32, 33, 39, 112, 16].map(os => io(os, "darwin"))).toEqual(["unknown", "unknown", "unknown", "unknown", "localInUse"])
		expect([2, 20, 1, 13, 30, 28].map(os => io(os, "darwin"))).toEqual([
			"localMissing",
			"localMissing",
			"localDenied",
			"localDenied",
			"localDenied",
			"localFull"
		])
		expect([2, 3, 5].map(os => io(os, "win32"))).toEqual(["localMissing", "localMissing", "localDenied"])
	})

	it("maps a full account to storageFull and keeps the kind name", () => {
		expect(classifyTransfer(fakeTransferSdk, sdkError(fakeSdk.ErrorKind.MaxStorageReached, "full"))).toEqual({
			code: "storageFull",
			kind: "MaxStorageReached",
			message: "full"
		})
	})
})

describe("native host", () => {
	it("transfer ops are answered before the sync engine opens", async () => {
		const client = new FakeTransferClient()
		const listeners: ((message: { data: unknown }) => void)[] = []
		const posts: FromNative[] = []

		hoisted.client = client
		Object.defineProperty(process, "parentPort", {
			configurable: true,
			value: {
				on: (_event: string, listener: (message: { data: unknown }) => void) => {
					listeners.push(listener)
				},
				postMessage: (message: FromNative) => {
					posts.push(message)
				}
			}
		})

		await import("../native/index.ts")

		const send = (data: unknown) => {
			for (const listener of listeners) {
				listener({ data })
			}
		}

		send({
			t: "init",
			addonPath: path.resolve("addon.node"),
			dir: path.resolve("user"),
			session: "s",
			logLevel: "Info",
			holdRemotes: [],
			macAddonPath: null
		})
		await flush()
		send({ t: "call", id: 1, op: "transfersStart", args: { specs: [downloadFile()] } })
		send({ t: "call", id: 2, op: "listPairs", args: {} })
		await flush()

		expect(posts).toContainEqual({ t: "reply", id: 1, ok: true, value: null })
		expect(posts).toContainEqual({ t: "reply", id: 2, ok: false, error: { code: "hostUnavailable" } })
		expect(client.of("downloadFileToPath")).toHaveLength(1)
	})
})
