import { createHash } from "node:crypto"
import { afterEach, describe, expect, it, vi } from "vitest"
import { probeDevice, recommendRuntime, type DeviceProbe } from "@/features/assistant/runtime/deviceCheck"
import { canRemoveModel } from "@/features/assistant/components/assistant.logic"
import { manifestBytes, modelFileUrl, parseManifest, type AssistantModelManifest } from "@/features/assistant/runtime/manifest"
import { QWEN35_4B } from "@/features/assistant/runtime/models"
import { readGgufSpecialTokens } from "@/features/assistant/runtime/gguf"
import { accumulateChunk, toEngineMessage, type GenerationState } from "@/features/assistant/runtime/engineMessages"
import type { ChatCompletionChunk } from "@wllama/wllama/esm/index.js"

const CHROME_MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36"
const FIREFOX_WIN = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:143.0) Gecko/20100101 Firefox/143.0"
const SAFARI_IPHONE =
	"Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1"
// iPadOS Safari's default: it asks for the desktop site.
const SAFARI_IPAD_DESKTOP =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15"
const GIB = 1024 ** 3

function probe(overrides: Partial<DeviceProbe> = {}): DeviceProbe {
	return {
		userAgent: CHROME_MAC,
		crossOriginIsolated: true,
		wasm: { simd: true, exceptions: true, memory64: true, jspi: true },
		opfs: true,
		hardwareConcurrency: 10,
		maxTouchPoints: 0,
		deviceMemoryGiB: 8,
		webgpu: { fallback: false, maxBufferSize: 4 * GIB, maxStorageBufferBindingSize: 2 * GIB },
		...overrides
	}
}

function chunk(delta: ChatCompletionChunk["choices"][number]["delta"]): ChatCompletionChunk {
	return {
		id: "c",
		object: "chat.completion.chunk",
		created: 0,
		model: "m",
		choices: [{ index: 0, delta, finish_reason: null, logprobs: null }]
	}
}

describe("recommendRuntime", () => {
	it("picks WebGPU on a capable Chromium", () => {
		expect(recommendRuntime(probe())).toEqual({ supported: true, backend: "webgpu", threads: 5, estimatedSpeed: "fast" })
	})

	it("falls back to threaded CPU without a usable GPU", () => {
		expect(recommendRuntime(probe({ webgpu: null, hardwareConcurrency: 16 }))).toEqual({
			supported: true,
			backend: "cpu",
			threads: 8,
			estimatedSpeed: "moderate"
		})
		expect(
			recommendRuntime(probe({ webgpu: { fallback: true, maxBufferSize: 4 * GIB, maxStorageBufferBindingSize: 4 * GIB } }))
		).toMatchObject({
			backend: "cpu"
		})
		expect(
			recommendRuntime(probe({ webgpu: { fallback: false, maxBufferSize: 4 * GIB, maxStorageBufferBindingSize: 128 * 1024 ** 2 } }))
		).toMatchObject({ backend: "cpu" })
		// No JSPI: the WebGPU path does not run.
		expect(recommendRuntime(probe({ wasm: { simd: true, exceptions: true, memory64: true, jspi: false } }))).toMatchObject({
			backend: "cpu"
		})
	})

	it("keeps Firefox on the CPU path even with WebGPU", () => {
		expect(recommendRuntime(probe({ userAgent: FIREFOX_WIN, deviceMemoryGiB: null }))).toEqual({
			supported: true,
			backend: "cpu",
			threads: 5,
			estimatedSpeed: "slow"
		})
	})

	it("refuses mobile tabs, small memory and missing engine features", () => {
		expect(recommendRuntime(probe({ userAgent: SAFARI_IPHONE }))).toMatchObject({ supported: false, reason: "insufficient-memory" })
		expect(recommendRuntime(probe({ deviceMemoryGiB: 4 }))).toMatchObject({ supported: false, reason: "insufficient-memory" })
		expect(recommendRuntime(probe({ wasm: { simd: true, exceptions: true, memory64: false, jspi: false } }))).toMatchObject({
			supported: false,
			reason: "unsupported-browser"
		})
		expect(recommendRuntime(probe({ opfs: false }))).toMatchObject({ supported: false, reason: "unsupported-browser" })
		// Neither a GPU nor threads: a 4B model would crawl.
		expect(recommendRuntime(probe({ webgpu: null, crossOriginIsolated: false }))).toMatchObject({
			supported: false,
			reason: "unsupported-browser",
			gpuCouldHelp: true
		})
	})

	it("expects no help from a GPU the engine would not use", () => {
		expect(recommendRuntime(probe({ userAgent: FIREFOX_WIN, webgpu: null, crossOriginIsolated: false }))).toMatchObject({
			supported: false,
			gpuCouldHelp: false
		})
		expect(
			recommendRuntime(
				probe({ webgpu: null, crossOriginIsolated: false, wasm: { simd: true, exceptions: true, memory64: true, jspi: false } })
			)
		).toMatchObject({ supported: false, gpuCouldHelp: false })
	})
})

describe("recommendRuntime on an iPad", () => {
	it("refuses an iPad that sends a Mac's user agent, by its touch points, and still runs on a Mac", () => {
		expect(recommendRuntime(probe({ userAgent: SAFARI_IPAD_DESKTOP, maxTouchPoints: 5, deviceMemoryGiB: null }))).toEqual({
			supported: false,
			reason: "insufficient-memory",
			detail: "iPadOS tab memory limits",
			gpuCouldHelp: false
		})
		expect(recommendRuntime(probe({ userAgent: SAFARI_IPAD_DESKTOP, maxTouchPoints: 0, deviceMemoryGiB: null }))).toMatchObject({
			supported: true
		})
	})
})

describe("canRemoveModel", () => {
	it("offers removal of an earlier model version's files while this one is not downloaded", () => {
		const model = { id: "m", name: "M", sizeBytes: 10 }

		expect(canRemoveModel({ kind: "not-downloaded", model, staleBytes: 2_700_000_000 })).toBe(true)
		expect(canRemoveModel({ kind: "not-downloaded", model })).toBe(false)
	})
})

describe("probeDevice", () => {
	afterEach(() => {
		vi.unstubAllGlobals()
	})

	function stubBrowser(userAgent: string) {
		const requestAdapter = vi.fn(() =>
			Promise.resolve({
				info: { isFallbackAdapter: false },
				limits: { maxBufferSize: 4 * GIB, maxStorageBufferBindingSize: 2 * GIB }
			})
		)

		vi.stubGlobal("navigator", {
			userAgent,
			hardwareConcurrency: 10,
			storage: { getDirectory: () => Promise.resolve(null) },
			gpu: { requestAdapter }
		})

		return requestAdapter
	}

	it("reads the adapter's limits when asked", async () => {
		const requestAdapter = stubBrowser(CHROME_MAC)

		expect((await probeDevice({ gpu: true })).webgpu).toEqual({
			fallback: false,
			maxBufferSize: 4 * GIB,
			maxStorageBufferBindingSize: 2 * GIB
		})
		expect(requestAdapter).toHaveBeenCalledOnce()
	})

	it("reads the touch points, as 0 where the browser does not expose them", async () => {
		stubBrowser(CHROME_MAC)
		expect((await probeDevice({ gpu: false })).maxTouchPoints).toBe(0)

		Object.assign(navigator, { maxTouchPoints: 5 })
		expect((await probeDevice({ gpu: false })).maxTouchPoints).toBe(5)
	})

	// Firefox runs on the CPU path either way; asking would only start its GPU process (and log a blocklist warning).
	it("never asks Firefox for an adapter", async () => {
		const requestAdapter = stubBrowser(FIREFOX_WIN)

		expect((await probeDevice({ gpu: true })).webgpu).toBeNull()
		expect(requestAdapter).not.toHaveBeenCalled()
	})
})

function shard(file: string, size = 10): AssistantModelManifest["shards"][number] {
	return { file, size, sha256: createHash("sha256").update(file).digest("hex") }
}

function manifest(shards: AssistantModelManifest["shards"]): unknown {
	return { id: "m", label: "M", license: { name: "MIT", url: "" }, source: { repo: "r", revision: "x" }, shards }
}

describe("model manifest", () => {
	it("pins the shipped model's seven split pieces", () => {
		expect(QWEN35_4B.shards).toHaveLength(7)
		expect(manifestBytes(QWEN35_4B)).toBe(2740938752)
		expect(QWEN35_4B.whole?.sha256).toBe("00fe7986ff5f6b463e62455821146049db6f9313603938a70800d1fb69ef11a4")
	})

	it("rejects pieces out of llama-gguf-split order and duplicates", () => {
		expect(() => parseManifest(manifest([shard("m-00002-of-00002.gguf"), shard("m-00001-of-00002.gguf")]))).toThrow(/order/)
		expect(() => parseManifest(manifest([shard("m-00001-of-00003.gguf"), shard("m-00002-of-00003.gguf")]))).toThrow(/order/)
		expect(() => parseManifest(manifest([shard("a.gguf"), shard("a.gguf")]))).toThrow(/duplicate/)
		expect(() => parseManifest(manifest([shard("a.gguf", 3 * GIB)]))).toThrow(/2 GB/)
		expect(parseManifest(manifest([shard("single.gguf")])).shards).toHaveLength(1)
	})

	it("builds shard URLs under an https base only", () => {
		const [first] = QWEN35_4B.shards

		if (first === undefined) {
			throw new Error("no shard")
		}

		expect(modelFileUrl({ baseUrl: "https://cdn.filen.io/gguf", file: first })).toBe(
			"https://cdn.filen.io/gguf/qwen3.5-4b-instruct-q4_k_m-00001-of-00007.gguf"
		)
		expect(modelFileUrl({ baseUrl: "http://localhost:5173/__assistant-model/", file: first })).toMatch(/^http:\/\/localhost/)
		expect(() => modelFileUrl({ baseUrl: "http://cdn.example/gguf/", file: first })).toThrow(/https/)
	})
})

// A minimal GGUF v3 header: a few unrelated keys, then the tokenizer's token and type arrays.
function gguf(tokens: { text: string; type: number }[]): Uint8Array {
	const parts: number[] = []
	const u32 = (value: number) => {
		parts.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff)
	}
	const u64 = (value: number) => {
		u32(value)
		u32(0)
	}
	const string = (value: string) => {
		const bytes = new TextEncoder().encode(value)

		u64(bytes.length)
		parts.push(...bytes)
	}

	u32(0x46554747)
	u32(3)
	u64(0)
	u64(5)
	string("general.name")
	u32(8)
	string("Test")
	string("general.alignment")
	u32(4)
	u32(32)
	string("tokenizer.ggml.merges")
	u32(9)
	u32(8)
	u64(2)
	string("a b")
	string("c d")
	string("tokenizer.ggml.tokens")
	u32(9)
	u32(8)
	u64(tokens.length)

	for (const token of tokens) {
		string(token.text)
	}

	string("tokenizer.ggml.token_type")
	u32(9)
	u32(5)
	u64(tokens.length)

	for (const token of tokens) {
		u32(token.type)
	}

	return new Uint8Array(parts)
}

describe("readGgufSpecialTokens", () => {
	it("returns the control and user-defined tokens", async () => {
		const bytes = gguf([
			{ text: "hello", type: 1 },
			{ text: "<|im_start|>", type: 3 },
			{ text: "<tool_call>", type: 4 },
			{ text: "x", type: 3 },
			{ text: "<0x0A>", type: 6 }
		])
		const tokens = await readGgufSpecialTokens({
			read: (offset, length) => Promise.resolve(bytes.subarray(offset, offset + length)),
			size: bytes.length
		})

		expect(tokens).toEqual(["<|im_start|>", "<tool_call>"])
	})

	it("rejects what is not a GGUF", async () => {
		const bytes = new Uint8Array(64)

		await expect(readGgufSpecialTokens({ read: () => Promise.resolve(bytes), size: bytes.length })).rejects.toThrow(/GGUF/)
	})
})

describe("engine messages", () => {
	it("maps tool calls and results to the OpenAI shape", () => {
		expect(
			toEngineMessage({
				role: "assistant",
				content: "",
				toolCalls: [{ id: "call_1_0", name: "search_items", arguments: '{"query":"x"}' }]
			})
		).toEqual({
			role: "assistant",
			content: "",
			tool_calls: [{ id: "call_1_0", type: "function", function: { name: "search_items", arguments: '{"query":"x"}' } }]
		})
		expect(toEngineMessage({ role: "tool", content: "{}", toolCallId: "call_1_0" })).toEqual({
			role: "tool",
			content: "{}",
			tool_call_id: "call_1_0"
		})
	})

	it("folds streamed text and tool-call deltas", () => {
		const state: GenerationState = { content: "", calls: [] }

		expect(accumulateChunk({ state, chunk: chunk({ content: "Let me " }) })).toEqual({ text: true, progress: null, named: [] })
		expect(accumulateChunk({ state, chunk: chunk({ content: "look." }) }).text).toBe(true)
		expect(
			accumulateChunk({
				state,
				chunk: chunk({ tool_calls: [{ index: 0, id: "a", function: { name: "search_items", arguments: '{"qu' } }] })
			})
		).toEqual({ text: false, progress: null, named: [{ index: 0, name: "search_items" }] })
		expect(
			accumulateChunk({ state, chunk: chunk({ tool_calls: [{ index: 0, function: { arguments: 'ery":"x"}' } }] }) }).named
		).toEqual([])

		expect(state).toEqual({ content: "Let me look.", calls: [{ id: "a", name: "search_items", arguments: '{"query":"x"}' }] })
	})

	it("reports prompt progress without the cached prefix", () => {
		const state: GenerationState = { content: "", calls: [] }

		expect(
			accumulateChunk({
				state,
				chunk: {
					...chunk({ role: "assistant", content: null }),
					prompt_progress: { total: 3000, cache: 1000, processed: 1512, time_ms: 9 }
				}
			})
		).toEqual({ text: false, progress: { processed: 512, total: 2000 }, named: [] })
		expect(state.content).toBe("")
	})

	it("numbers named calls by their position in the result, skipping an engine index never named", () => {
		const state: GenerationState = { content: "", calls: [] }

		accumulateChunk({ state, chunk: chunk({ tool_calls: [{ index: 1, id: "b", function: { arguments: "{" } }] }) })

		expect(
			accumulateChunk({ state, chunk: chunk({ tool_calls: [{ index: 2, id: "c", function: { name: "list_notes" } }] }) }).named
		).toEqual([{ index: 0, name: "list_notes" }])
		expect(
			accumulateChunk({ state, chunk: chunk({ tool_calls: [{ index: 3, id: "d", function: { name: "read_note" } }] }) }).named
		).toEqual([{ index: 1, name: "read_note" }])
	})
})
