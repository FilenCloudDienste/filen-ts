import { beforeEach, describe, expect, it, vi } from "vitest"
import { QUARANTINE_CONTEXT_TOKENS, ROUTER_CONTEXT_TOKENS } from "@filen/shared/assistant"
import type { DesktopAssistant, DesktopAssistantEvent } from "@filen/shared/desktop"
import type { GenerationUpdate } from "@/features/assistant/runtime/engineMessages"
import { QWEN35_4B } from "@/features/assistant/runtime/models"

// The desktop app's native engine behind the worker's API, against a scripted bridge: the names the client reads off
// its errors (and so the fallback to the page's own engine), the events routed to the call they belong to, the page's
// OPFS copy imported instead of downloaded again and freed once the native download verified, and which store the
// client's model checks read.

const { opfs, bridge, pageFiles } = vi.hoisted(() => ({
	// The page's OPFS copy: each shard's bytes and whether its record lists it as verified.
	pageFiles: new Map<string, { bytes: Uint8Array<ArrayBuffer>; sha256: string | null }>(),
	opfs: {
		deleteModels: vi.fn(() => Promise.resolve()),
		modelDirectory: vi.fn(() => Promise.resolve({})),
		readVerified: vi.fn(() => Promise.resolve(new Map<string, string>())),
		inspectModel: vi.fn(() => Promise.resolve({ presentBytes: 1, verifiedBytes: 0, complete: false })),
		otherModels: vi.fn(() => Promise.resolve({ present: false, bytes: 0 })),
		deleteModelDirectory: vi.fn(() => Promise.resolve())
	},
	bridge: { current: undefined as DesktopAssistant | undefined }
}))

vi.mock("@/features/assistant/runtime/modelStore", () => ({ MODEL_LOCK: "filen-assistant-model", ...opfs }))
vi.mock("@/lib/desktop", () => ({ desktopAssistant: () => bridge.current }))
vi.mock("@/workers/assistant.worker.ts?worker", () => ({
	default: class {
		addEventListener = vi.fn()
		terminate = vi.fn()
	}
}))

function fakeBridge() {
	const listeners = new Set<(event: DesktopAssistantEvent) => void>()
	const assistant = {
		available: vi.fn(() => Promise.resolve(true)),
		inspect: vi.fn(() => Promise.resolve({ presentBytes: 9, verifiedBytes: 9, complete: true })),
		otherModels: vi.fn(() => Promise.resolve({ present: true, bytes: 5 })),
		deleteModels: vi.fn(() => Promise.resolve()),
		download: vi.fn<DesktopAssistant["download"]>(() => Promise.resolve({ ok: true, value: null })),
		cancelDownload: vi.fn(),
		importChunk: vi.fn<DesktopAssistant["importChunk"]>(() => Promise.resolve({ ok: true, value: "more" })),
		load: vi.fn<DesktopAssistant["load"]>(() =>
			Promise.resolve({ ok: true, value: { specialTokens: ["<|im_end|>"], backend: "metal" } })
		),
		generate: vi.fn<DesktopAssistant["generate"]>(() => Promise.resolve({ ok: true, value: { content: "hi", toolCalls: [] } })),
		cancel: vi.fn(),
		unload: vi.fn(() => Promise.resolve()),
		release: vi.fn(),
		onEvent: vi.fn((callback: (event: DesktopAssistantEvent) => void) => {
			listeners.add(callback)

			return () => {
				listeners.delete(callback)
			}
		})
	} satisfies DesktopAssistant
	const emit = (event: DesktopAssistantEvent) => {
		for (const listener of listeners) {
			listener(event)
		}
	}

	return { assistant, emit, listeners }
}

async function engine(onLost = vi.fn()) {
	const { createNativeEngine } = await import("@/features/assistant/runtime/nativeEngine")
	const fake = fakeBridge()

	return { ...fake, onLost, handle: createNativeEngine(fake.assistant, onLost) }
}

const LOAD_OPTIONS = {
	backend: "webgpu" as const,
	threads: 4,
	contextTokens: 8192 + ROUTER_CONTEXT_TOKENS + QUARANTINE_CONTEXT_TOKENS,
	primeSystem: "route"
}

beforeEach(() => {
	vi.resetModules()
	bridge.current = undefined
})

describe("native engine", () => {
	it("downloads through the bridge, reports progress, and frees the page's own copy once verified", async () => {
		const { assistant, emit, handle } = await engine()
		const progress = vi.fn()

		assistant.download.mockImplementation(() => {
			emit({ kind: "download", receivedBytes: 10, waiting: false })

			return Promise.resolve({ ok: true, value: null })
		})
		await handle.remote.download(QWEN35_4B, "https://cdn.filen.io/gguf/", progress)

		expect(assistant.download).toHaveBeenCalledWith(QWEN35_4B, "https://cdn.filen.io/gguf/")
		expect(progress).toHaveBeenCalledWith({ receivedBytes: 10, waiting: false })
		expect(opfs.deleteModels).toHaveBeenCalledWith()
	})

	it("keeps the page's copy when the native download failed, named as the worker names it", async () => {
		const { assistant, handle } = await engine()

		opfs.deleteModels.mockClear()
		assistant.download.mockResolvedValueOnce({ ok: false, error: "storage-full", message: "full" })
		await expect(handle.remote.download(QWEN35_4B, "https://cdn.filen.io/gguf/", vi.fn())).rejects.toMatchObject({
			name: "ModelDownloadError:storage-full"
		})
		assistant.download.mockResolvedValueOnce({ ok: false, error: "aborted", message: "stopped" })
		await expect(handle.remote.download(QWEN35_4B, "https://cdn.filen.io/gguf/", vi.fn())).rejects.toMatchObject({ name: "AbortError" })
		assistant.download.mockResolvedValueOnce({ ok: false, error: "crashed", message: "gone" })
		await expect(handle.remote.download(QWEN35_4B, "https://cdn.filen.io/gguf/", vi.fn())).rejects.toMatchObject({
			name: "ModelDownloadError:network"
		})
		expect(opfs.deleteModels).not.toHaveBeenCalled()
	})

	it("loads one sequence a slot as large as the main loop's context, and names a backend-less machine for the fallback", async () => {
		const { assistant, emit, handle } = await engine()
		const verifying = vi.fn()

		assistant.load.mockImplementationOnce(() => {
			emit({ kind: "verifying" })

			return Promise.resolve({ ok: true, value: { specialTokens: ["<|im_end|>"], backend: "cuda", promptBatchMs: 120 } })
		})
		expect(await handle.remote.load(QWEN35_4B, LOAD_OPTIONS, verifying)).toEqual({ specialTokens: ["<|im_end|>"], promptBatchMs: 120 })
		expect(assistant.load).toHaveBeenCalledWith(QWEN35_4B, { sequenceTokens: 8192, primeSystem: "route" })
		expect(verifying).toHaveBeenCalledOnce()

		const { NATIVE_UNAVAILABLE } = await import("@/features/assistant/runtime/nativeEngine")

		assistant.load.mockResolvedValueOnce({ ok: false, error: "unavailable", message: "no backend" })
		await expect(handle.remote.load(QWEN35_4B, LOAD_OPTIONS)).rejects.toMatchObject({ name: NATIVE_UNAVAILABLE })
		assistant.load.mockResolvedValueOnce({ ok: false, error: "out-of-memory", message: "oom" })
		await expect(handle.remote.load(QWEN35_4B, LOAD_OPTIONS)).rejects.toMatchObject({ name: "ModelLoadError:out-of-memory" })
		assistant.load.mockResolvedValueOnce({ ok: false, error: "missing", message: "gone" })
		await expect(handle.remote.load(QWEN35_4B, LOAD_OPTIONS)).rejects.toMatchObject({ name: "ModelLoadError:missing" })
	})

	it("routes each generation's updates to it alone, and names a crash as the worker's engine crash", async () => {
		const { assistant, emit, handle } = await engine()
		const updates: GenerationUpdate[] = []

		assistant.generate.mockImplementationOnce(id => {
			emit({ kind: "update", id: 99, update: { type: "text", text: "not mine" } })
			emit({ kind: "update", id, update: { type: "text", text: "Hel" } })
			emit({ kind: "update", id, update: { type: "call", index: 0, name: "list_directory" } })

			return Promise.resolve({ ok: true, value: { content: "Hello", toolCalls: [] } })
		})
		expect(
			await handle.remote.generate(4, { slot: "main", maxTokens: 8, messages: [{ role: "user", content: "hi" }] }, update => {
				updates.push(update)
			})
		).toEqual({ content: "Hello", toolCalls: [] })
		expect(assistant.generate).toHaveBeenCalledWith(4, expect.anything(), true)
		expect(updates).toEqual([
			{ type: "text", text: "Hel" },
			{ type: "call", index: 0, name: "list_directory" }
		])

		const { ENGINE_CRASHED } = await import("@/features/assistant/runtime/engineMessages")

		assistant.generate.mockResolvedValueOnce({ ok: false, error: "crashed", message: "gone" })
		await expect(handle.remote.generate(5, { slot: "main", maxTokens: 8, messages: [] })).rejects.toMatchObject({
			name: ENGINE_CRASHED
		})
		expect(assistant.generate).toHaveBeenLastCalledWith(5, expect.anything(), false)
		assistant.generate.mockResolvedValueOnce({ ok: false, error: "aborted", message: "stopped" })
		await expect(handle.remote.generate(6, { slot: "main", maxTokens: 8, messages: [] })).rejects.toMatchObject({ name: "AbortError" })
	})

	it("reports its process ending on its own, and ends it on stop", async () => {
		const { emit, onLost, handle, assistant, listeners } = await engine()

		emit({ kind: "exited" })
		expect(onLost).toHaveBeenCalledOnce()

		handle.stop()
		expect(assistant.release).toHaveBeenCalledOnce()
		expect(listeners.size).toBe(0)
	})
})

describe("engine host", () => {
	it("keeps the model in OPFS and runs the worker outside the desktop app", async () => {
		const host = await import("@/features/assistant/runtime/engineHost")

		await host.selectEngine()
		expect(host.nativeEngineActive()).toBe(false)
		await host.inspectModel(QWEN35_4B)
		expect(opfs.inspectModel).toHaveBeenCalled()
	})

	it("reads and removes the native model while the desktop engine runs here, until it falls back", async () => {
		const fake = fakeBridge()

		bridge.current = fake.assistant
		opfs.inspectModel.mockClear()

		const host = await import("@/features/assistant/runtime/engineHost")

		await host.selectEngine()
		expect(host.nativeEngineActive()).toBe(true)
		expect(await host.inspectModel(QWEN35_4B)).toEqual({ presentBytes: 9, verifiedBytes: 9, complete: true })
		expect(await host.otherModels(QWEN35_4B.id)).toEqual({ present: true, bytes: 5 })
		await host.deleteModels(QWEN35_4B.id)
		expect(fake.assistant.deleteModels).toHaveBeenCalledWith(QWEN35_4B.id)
		expect(opfs.inspectModel).not.toHaveBeenCalled()

		host.spawnEngine(vi.fn()).stop()
		expect(fake.assistant.release).toHaveBeenCalledOnce()

		expect(host.fallBackToWorker()).toBe(true)
		expect(host.fallBackToWorker()).toBe(false)
		await host.inspectModel(QWEN35_4B)
		expect(opfs.inspectModel).toHaveBeenCalled()
	})

	it("uses the worker when the desktop engine says it cannot run here", async () => {
		const fake = fakeBridge()

		fake.assistant.available.mockResolvedValue(false)
		bridge.current = fake.assistant

		const host = await import("@/features/assistant/runtime/engineHost")

		await host.selectEngine()
		expect(host.nativeEngineActive()).toBe(false)
	})
})

describe("native engine: importing the page's copy", () => {
	const BIG = 8 * 1024 * 1024 + 5
	const shardA = new Uint8Array(BIG).fill(7)
	const shardB = new Uint8Array(10).fill(3)
	const shardC = new Uint8Array(4).fill(1)

	async function manifest() {
		const { parseManifest } = await import("@/features/assistant/runtime/manifest")

		return parseManifest({
			id: "test-model",
			label: "Test",
			license: { name: "MIT", url: "https://example.com" },
			source: { repo: "r", revision: "v" },
			shards: [
				{ file: "t-00001-of-00003.gguf", size: shardA.length, sha256: "a".repeat(64) },
				{ file: "t-00002-of-00003.gguf", size: shardB.length, sha256: "b".repeat(64) },
				{ file: "t-00003-of-00003.gguf", size: shardC.length, sha256: "c".repeat(64) }
			]
		})
	}

	beforeEach(() => {
		pageFiles.clear()
		pageFiles.set("t-00001-of-00003.gguf", { bytes: shardA, sha256: "a".repeat(64) })
		pageFiles.set("t-00002-of-00003.gguf", { bytes: shardB, sha256: "b".repeat(64) })
		// On disk, but never verified by the page: the download fetches it.
		pageFiles.set("t-00003-of-00003.gguf", { bytes: shardC, sha256: null })
		opfs.inspectModel.mockResolvedValue({ presentBytes: BIG + 14, verifiedBytes: BIG + 10, complete: false })
		opfs.readVerified.mockImplementation(() =>
			Promise.resolve(
				new Map(
					[...pageFiles].flatMap(([file, entry]) => (entry.sha256 === null ? [] : [[file, entry.sha256] as [string, string]]))
				)
			)
		)
		opfs.modelDirectory.mockImplementation(() =>
			Promise.resolve({
				getFileHandle: (name: string) => {
					const entry = pageFiles.get(name)

					return entry === undefined
						? Promise.reject(new DOMException("missing", "NotFoundError"))
						: Promise.resolve({ getFile: () => Promise.resolve(new File([entry.bytes], name)) })
				}
			})
		)
		opfs.deleteModels.mockClear()
	})

	it("hands every shard the page verified to the engine in chunks before downloading the rest, then frees the copy", async () => {
		const { assistant, handle } = await engine()
		const { IMPORT_CHUNK_BYTES } = await import("@/features/assistant/runtime/nativeEngine")
		const order: string[] = []

		assistant.inspect.mockResolvedValue({ presentBytes: 0, verifiedBytes: 0, complete: false })
		assistant.importChunk.mockImplementation((_model, file, offset, bytes, last) => {
			order.push(`${file}@${String(offset)}+${String(bytes.byteLength)}${last ? " last" : ""}`)

			return Promise.resolve({ ok: true, value: last ? "verified" : "more" })
		})
		assistant.download.mockImplementation(() => {
			order.push("download")

			return Promise.resolve({ ok: true, value: null })
		})

		const progress = vi.fn()

		await handle.remote.download(await manifest(), "https://cdn.filen.io/gguf/", progress)

		expect(order).toEqual([
			`t-00001-of-00003.gguf@0+${String(IMPORT_CHUNK_BYTES)}`,
			`t-00001-of-00003.gguf@${String(IMPORT_CHUNK_BYTES)}+5 last`,
			"t-00002-of-00003.gguf@0+10 last",
			"download"
		])
		expect(progress).toHaveBeenLastCalledWith({ receivedBytes: BIG + 10, waiting: false })
		expect(opfs.deleteModels).toHaveBeenCalledOnce()
	})

	it("leaves a shard the engine refused to the download, and skips one it has", async () => {
		const { assistant, handle } = await engine()
		const progress = vi.fn()

		assistant.inspect.mockResolvedValue({ presentBytes: 10, verifiedBytes: 10, complete: false })
		assistant.importChunk.mockImplementation((_model, file, offset) =>
			Promise.resolve(
				file === "t-00002-of-00003.gguf"
					? { ok: true, value: "present" }
					: offset === 0
						? { ok: true, value: "more" }
						: { ok: false, error: "integrity", message: "does not match its published hash" }
			)
		)

		await handle.remote.download(await manifest(), "https://cdn.filen.io/gguf/", progress)

		expect(assistant.importChunk).toHaveBeenCalledTimes(3)
		// The refused shard's bytes are no longer counted; the download reports from there.
		expect(progress).toHaveBeenLastCalledWith({ receivedBytes: 10 + 8 * 1024 * 1024, waiting: false })
		expect(assistant.download).toHaveBeenCalledOnce()
		expect(opfs.deleteModels).toHaveBeenCalledOnce()
	})

	it("keeps the page's copy when the download after the import failed", async () => {
		const { assistant, handle } = await engine()

		assistant.inspect.mockResolvedValue({ presentBytes: 0, verifiedBytes: 0, complete: false })
		assistant.importChunk.mockRejectedValue(new Error("invalid assistant payload"))
		assistant.download.mockResolvedValueOnce({ ok: false, error: "network", message: "offline" })

		await expect(handle.remote.download(await manifest(), "https://cdn.filen.io/gguf/", vi.fn())).rejects.toMatchObject({
			name: "ModelDownloadError:network"
		})
		expect(opfs.deleteModels).not.toHaveBeenCalled()
	})

	it("stops an import when the download is cancelled, and downloads nothing", async () => {
		const { assistant, handle } = await engine()
		let cancel: () => void = () => undefined

		assistant.inspect.mockResolvedValue({ presentBytes: 0, verifiedBytes: 0, complete: false })
		assistant.importChunk.mockImplementation(() => {
			cancel()

			return Promise.resolve({ ok: true, value: "more" })
		})
		cancel = () => {
			void handle.remote.cancelDownload()
		}

		await expect(handle.remote.download(await manifest(), "https://cdn.filen.io/gguf/", vi.fn())).rejects.toMatchObject({
			name: "AbortError"
		})
		expect(assistant.importChunk).toHaveBeenCalledOnce()
		expect(assistant.download).not.toHaveBeenCalled()
		expect(opfs.deleteModels).not.toHaveBeenCalled()
	})

	it("imports nothing when the page has no verified shard", async () => {
		const { assistant, handle } = await engine()

		opfs.inspectModel.mockResolvedValue({ presentBytes: 0, verifiedBytes: 0, complete: false })
		await handle.remote.download(await manifest(), "https://cdn.filen.io/gguf/", vi.fn())
		expect(assistant.importChunk).not.toHaveBeenCalled()
		expect(assistant.download).toHaveBeenCalledOnce()
	})
})
