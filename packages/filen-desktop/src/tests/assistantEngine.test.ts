import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createSHA256 } from "hash-wasm"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { AssistantModelFiles } from "@filen/shared/dom/assistantModel/manifest"
import { backendOrder, createEngine, type EngineDeps, type LlamaModule } from "../assistant/engine.ts"
import { inspectModel } from "../assistant/modelDir.ts"
import type { EngineCall, FromEngine } from "../shared/assistantProtocol.ts"

// The engine's process against fake fetches and a fake node-llama-cpp: the shared download onto plain files (resumed,
// verified, a damaged one refused), and a load that tries the backends in order, falls back on errors, stops on
// memory and checks the shards first. The real engine runs the model in the packaged app's utility process.

const BASE = "https://cdn.example/gguf/"

function bytes(seed: number, size: number): Uint8Array {
	return Uint8Array.from({ length: size }, (_, index) => (index * 31 + seed) % 251)
}

function sha256(data: Uint8Array): string {
	return createHash("sha256").update(data).digest("hex")
}

const FIRST = bytes(1, 70_000)
const SECOND = bytes(2, 30_000)
const MODEL: AssistantModelFiles = {
	id: "test-model",
	shards: [
		{ file: "m-00001-of-00002.gguf", size: FIRST.length, sha256: sha256(FIRST) },
		{ file: "m-00002-of-00002.gguf", size: SECOND.length, sha256: sha256(SECOND) }
	]
}

let root: string
let dir: string

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), "filen-assistant-engine-"))
	dir = path.join(root, MODEL.id)
	await mkdir(dir)
})

afterEach(async () => {
	await rm(root, { recursive: true, force: true })
})

// Serves `files` by name, honouring a Range request the way the model host does (206 and the rest's length).
function host(files: Record<string, Uint8Array>) {
	const requests: { file: string; range: string | null }[] = []
	const fetchShard = vi.fn((url: string, init: RequestInit) => {
		const file = decodeURIComponent(new URL(url).pathname.split("/").at(-1) ?? "")
		const data = files[file]
		const range = new Headers(init.headers).get("Range")

		requests.push({ file, range })

		if (data === undefined) {
			return Promise.resolve(new Response(null, { status: 404 }))
		}

		const from = range === null ? 0 : Number(/bytes=(\d+)-/.exec(range)?.[1] ?? 0)
		const body = data.slice(from)

		return Promise.resolve(
			new Response(body, { status: range === null ? 200 : 206, headers: { "Content-Length": String(body.length) } })
		)
	})

	return { fetchShard, requests }
}

function engineWith(overrides: Partial<EngineDeps>) {
	const sent: FromEngine[] = []
	const replies = new Map<number, (result: Extract<FromEngine, { t: "reply" }>["result"]) => void>()
	const engine = createEngine({
		send: message => {
			sent.push(message)

			if (message.t === "reply") {
				replies.get(message.id)?.(message.result)
			}
		},
		fetchShard: () => Promise.reject(new Error("no network")),
		createHasher: createSHA256,
		connectivity: { isOnline: () => true, waitOnline: () => Promise.resolve() },
		llama: () => Promise.reject(new Error("no engine")),
		...overrides
	})
	let next = 1
	const call = (body: EngineCall) =>
		new Promise<Extract<FromEngine, { t: "reply" }>["result"]>(resolve => {
			const id = next++

			replies.set(id, resolve)
			engine.handle({ t: "call", id, ...body })
		})

	return { sent, call, engine }
}

function loadCall(exclude: ("metal" | "vulkan" | "cpu")[] = []) {
	return { op: "load" as const, model: MODEL, dir, exclude, sequenceTokens: 8192, primeSystem: "route" }
}

async function placeModel(verified: boolean): Promise<void> {
	await writeFile(path.join(dir, MODEL.shards[0]?.file ?? ""), FIRST)
	await writeFile(path.join(dir, MODEL.shards[1]?.file ?? ""), SECOND)

	if (verified) {
		await writeFile(path.join(dir, "verified.json"), JSON.stringify(Object.fromEntries(MODEL.shards.map(s => [s.file, s.sha256]))))
	}
}

// A node-llama-cpp whose backends fail to start as `failures` says.
function failingLlama(supported: (false | "metal" | "cuda" | "vulkan")[], failure: (gpu: unknown) => Error): LlamaModule {
	return {
		getLlamaGpuTypes: vi.fn(() => Promise.resolve(supported)),
		getLlama: vi.fn((options?: { gpu?: unknown }) => Promise.reject(failure(options?.gpu))),
		LlamaLogLevel: { info: "info", warn: "warn" }
	} as unknown as LlamaModule
}

describe("assistant engine: backends", () => {
	it("tries the fastest backends first and the CPU last, leaving out the excluded ones", () => {
		expect(backendOrder(["cpu", "vulkan"], [])).toEqual(["vulkan", "cpu"])
		expect(backendOrder(["metal", "cpu"], [])).toEqual(["metal", "cpu"])
		expect(backendOrder(["vulkan", "cpu"], ["vulkan"])).toEqual(["cpu"])
		expect(backendOrder(["vulkan"], ["vulkan"])).toEqual([])
	})
})

describe("assistant engine: download", () => {
	it("downloads every shard onto disk, verified, and reports the bytes", async () => {
		const { fetchShard } = host({ [MODEL.shards[0]?.file ?? ""]: FIRST, [MODEL.shards[1]?.file ?? ""]: SECOND })
		const { sent, call } = engineWith({ fetchShard })

		expect(await call({ op: "download", model: MODEL, baseUrl: BASE, dir })).toEqual({ ok: true, value: null })
		expect(new Uint8Array(await readFile(path.join(dir, MODEL.shards[0]?.file ?? "")))).toEqual(FIRST)
		expect(new Uint8Array(await readFile(path.join(dir, MODEL.shards[1]?.file ?? "")))).toEqual(SECOND)
		expect(await inspectModel(root, MODEL)).toEqual({ presentBytes: 100_000, verifiedBytes: 100_000, complete: true })

		const progress = sent.filter(message => message.t === "progress")

		expect(progress.at(-1)).toEqual({ t: "progress", receivedBytes: 100_000, waiting: false })
		// The hasher checkpoints go once their shard is verified.
		await expect(stat(path.join(dir, `${MODEL.shards[0]?.file ?? ""}.sha256-state`))).rejects.toThrow()
	})

	it("continues a partial shard with a Range request and skips a verified one", async () => {
		const first = MODEL.shards[0]?.file ?? ""
		const second = MODEL.shards[1]?.file ?? ""
		const { fetchShard, requests } = host({ [first]: FIRST, [second]: SECOND })

		await writeFile(path.join(dir, first), FIRST.subarray(0, 50_000))
		await writeFile(path.join(dir, second), SECOND)
		await writeFile(path.join(dir, "verified.json"), JSON.stringify({ [second]: MODEL.shards[1]?.sha256 }))

		const { call } = engineWith({ fetchShard })

		expect(await call({ op: "download", model: MODEL, baseUrl: BASE, dir })).toEqual({ ok: true, value: null })
		expect(requests).toEqual([{ file: first, range: "bytes=50000-" }])
		expect(await inspectModel(root, MODEL)).toMatchObject({ complete: true })
	})

	it("refuses a shard that does not match its published hash, and keeps nothing of it", async () => {
		const first = MODEL.shards[0]?.file ?? ""
		const { fetchShard } = host({ [first]: bytes(9, FIRST.length), [MODEL.shards[1]?.file ?? ""]: SECOND })
		const { call } = engineWith({ fetchShard })
		const result = await call({ op: "download", model: MODEL, baseUrl: BASE, dir })

		expect(result).toMatchObject({ ok: false, error: "integrity" })
		expect((await stat(path.join(dir, first))).size).toBe(0)
		expect(await inspectModel(root, MODEL)).toMatchObject({ complete: false })
	})

	it("reports a stopped download as aborted", async () => {
		const { call, engine } = engineWith({
			fetchShard: (_url, init) =>
				new Promise((_resolve, reject) => {
					init.signal?.addEventListener("abort", () => {
						reject(new DOMException("stopped", "AbortError"))
					})
				})
		})
		const result = call({ op: "download", model: MODEL, baseUrl: BASE, dir })

		await new Promise(resolve => setTimeout(resolve, 20))
		engine.handle({ t: "cancelDownload" })
		expect(await result).toMatchObject({ ok: false, error: "aborted" })
	})
})

describe("assistant engine: load", () => {
	it("refuses a model not on disk without starting any backend", async () => {
		const llama = failingLlama(["cuda"], () => new Error("never"))
		const { sent, call } = engineWith({ llama: () => Promise.resolve(llama) })

		expect(await call(loadCall())).toMatchObject({ ok: false, error: "missing" })
		expect(sent.some(message => message.t === "trying")).toBe(false)
	})

	it("hashes a shard missing from the record once, and drops one that does not match", async () => {
		await writeFile(path.join(dir, MODEL.shards[0]?.file ?? ""), bytes(5, FIRST.length))
		await writeFile(path.join(dir, MODEL.shards[1]?.file ?? ""), SECOND)

		const { sent, call } = engineWith({ llama: () => Promise.resolve(failingLlama(["cuda"], () => new Error("never"))) })

		expect(await call(loadCall())).toMatchObject({ ok: false, error: "missing" })
		expect(sent).toContainEqual({ t: "verifying" })
		await expect(stat(path.join(dir, MODEL.shards[0]?.file ?? ""))).rejects.toThrow()
	})

	it("tries each backend in order, says which one before it, and is unavailable once none starts", async () => {
		await placeModel(true)

		const llama = failingLlama(["cuda", "vulkan", false], gpu => new Error(`no ${String(gpu)} binary`))
		const { sent, call } = engineWith({ llama: () => Promise.resolve(llama) })
		const result = await call(loadCall())

		// CUDA, which this machine supports, is not shipped: never tried.
		expect(sent.filter(message => message.t === "trying")).toEqual([
			{ t: "trying", backend: "vulkan" },
			{ t: "trying", backend: "cpu" }
		])
		expect(llama.getLlama).toHaveBeenNthCalledWith(1, expect.objectContaining({ gpu: "vulkan", build: "never" }))
		expect(llama.getLlama).toHaveBeenNthCalledWith(2, expect.objectContaining({ gpu: false }))
		expect(result).toMatchObject({ ok: false, error: "unavailable" })
		// Every shard was read again for damage before giving up: none was.
		expect(await inspectModel(root, MODEL)).toMatchObject({ complete: true })
	})

	it("leaves out the backends main excludes", async () => {
		await placeModel(true)

		const { sent, call } = engineWith({
			llama: () => Promise.resolve(failingLlama(["cuda", "vulkan", false], () => new Error("no binary")))
		})

		await call(loadCall(["vulkan"]))
		expect(sent.filter(message => message.t === "trying")).toEqual([{ t: "trying", backend: "cpu" }])
	})

	it("stops at a backend that ran out of memory: another has no more of it", async () => {
		await placeModel(true)

		const { sent, call } = engineWith({
			llama: () => Promise.resolve(failingLlama(["cuda", "vulkan", false], () => new Error("ggml: failed to allocate buffer")))
		})

		expect(await call(loadCall())).toMatchObject({ ok: false, error: "out-of-memory" })
		expect(sent.filter(message => message.t === "trying")).toHaveLength(1)
	})

	it("refuses a generation with no model loaded", async () => {
		const { call } = engineWith({})

		expect(
			await call({
				op: "generate",
				gen: 1,
				updates: false,
				request: { slot: "main", maxTokens: 8, messages: [{ role: "user", content: "hi" }] }
			})
		).toMatchObject({ ok: false, error: "missing" })
	})
})
