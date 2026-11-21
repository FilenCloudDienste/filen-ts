import { parseUserAgent } from "@filen/shared"

// What the browser and the device can do, as far as running the model needs. Gathered by probeDevice
// (main thread or worker); judged by recommendRuntime, which is pure.
export interface DeviceProbe {
	userAgent: string
	crossOriginIsolated: boolean
	wasm: {
		simd: boolean
		exceptions: boolean
		// wllama's build addresses 64-bit memory; its 32-bit fallback would be fetched from a third-party CDN.
		memory64: boolean
		// JS Promise Integration: lets the engine stream the model from disk instead of copying it into memory,
		// and is what its WebGPU path runs on.
		jspi: boolean
	}
	// OPFS. Every engine that has it also has the synchronous access handles the worker writes through,
	// which only a worker can see.
	opfs: boolean
	hardwareConcurrency: number
	// navigator.maxTouchPoints, 0 where not exposed (workers).
	maxTouchPoints: number
	// navigator.deviceMemory: GiB rounded down to a power of two, capped at 8; null where not exposed.
	deviceMemoryGiB: number | null
	webgpu: {
		fallback: boolean
		maxBufferSize: number
		maxStorageBufferBindingSize: number
	} | null
}

export type AssistantBackend = "webgpu" | "cpu"

export type RuntimeRecommendation =
	| {
			supported: true
			backend: AssistantBackend
			threads: number
			// Rough decode speed class for the 4B model: fast ≈ 15+ tokens/s, moderate ≈ 6-15, slow below.
			estimatedSpeed: "fast" | "moderate" | "slow"
	  }
	| {
			supported: false
			reason: "unsupported-browser" | "insufficient-memory"
			detail: string
			// A usable GPU would change the verdict: only the missing threads stood in the way.
			gpuCouldHelp: boolean
	  }

const GIB = 1024 * 1024 * 1024

// The largest single weight tensor of the 4B model's GGUF is about half a gigabyte; a GPU that cannot bind
// a buffer of 1 GiB is too small to hold the model with room to spare.
const MIN_GPU_BINDING_BYTES = GIB

// A 4B model at Q4_K_M needs ~3.5-4 GB of memory while running; Chrome reports at most 8.
const MIN_DEVICE_MEMORY_GIB = 8

const MAX_THREADS = 8

// Firefox's WebGPU runs this engine far slower than its CPU path, so its adapter is never asked for.
function gpuConsidered(userAgent: string): boolean {
	return parseUserAgent(userAgent).browser !== "Firefox"
}

export function recommendRuntime(probe: DeviceProbe): RuntimeRecommendation {
	const { wasm } = probe
	const agent = parseUserAgent(probe.userAgent)

	if (!wasm.simd || !wasm.exceptions || !wasm.memory64 || !probe.opfs) {
		return {
			supported: false,
			reason: "unsupported-browser",
			detail: "missing WebAssembly SIMD, exceptions, Memory64 or OPFS",
			gpuCouldHelp: false
		}
	}

	// iPadOS browsers send a Mac's user agent by default; no Mac reports touch points.
	const os = agent.os === "macOS" && probe.maxTouchPoints > 1 ? "iPadOS" : agent.os

	// Mobile tabs are killed far below what the model needs (iOS caps a tab well under 2 GB).
	if (os === "iOS" || os === "iPadOS" || os === "Android") {
		return { supported: false, reason: "insufficient-memory", detail: `${os} tab memory limits`, gpuCouldHelp: false }
	}

	if (probe.deviceMemoryGiB !== null && probe.deviceMemoryGiB < MIN_DEVICE_MEMORY_GIB) {
		return {
			supported: false,
			reason: "insufficient-memory",
			detail: `${String(probe.deviceMemoryGiB)} GiB device memory`,
			gpuCouldHelp: false
		}
	}

	const threads = probe.crossOriginIsolated ? Math.max(1, Math.min(MAX_THREADS, Math.floor(probe.hardwareConcurrency / 2))) : 1
	const gpu = probe.webgpu
	const gpuUsable =
		wasm.jspi &&
		gpuConsidered(probe.userAgent) &&
		gpu !== null &&
		!gpu.fallback &&
		gpu.maxBufferSize >= MIN_GPU_BINDING_BYTES &&
		gpu.maxStorageBufferBindingSize >= MIN_GPU_BINDING_BYTES

	if (gpuUsable) {
		return { supported: true, backend: "webgpu", threads, estimatedSpeed: "fast" }
	}

	// One thread decodes a 4B model at around a token per second: not usable.
	if (threads < 2) {
		return {
			supported: false,
			reason: "unsupported-browser",
			detail: "no WebGPU and no WebAssembly threads",
			gpuCouldHelp: wasm.jspi && gpuConsidered(probe.userAgent)
		}
	}

	return { supported: true, backend: "cpu", threads, estimatedSpeed: threads >= 6 ? "moderate" : "slow" }
}

// Feature probes from wasm-feature-detect (Apache-2.0), as wllama itself runs them.
const SIMD_MODULE = new Uint8Array([
	0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11
])
const EXCEPTIONS_MODULE = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 10, 8, 1, 6, 0, 6, 64, 25, 11, 11])

function supportsMemory64(): boolean {
	try {
		// The descriptor's `address` and bigint sizes are newer than the DOM typings.
		new WebAssembly.Memory({ address: "i64", initial: 1n } as unknown as WebAssembly.MemoryDescriptor)

		return true
	} catch {
		return false
	}
}

async function probeWebGpu(): Promise<DeviceProbe["webgpu"]> {
	// Typed as always present; absent in browsers without WebGPU.
	if (!("gpu" in navigator)) {
		return null
	}

	try {
		// The default adapter: asking for the high-performance one can wake a discrete GPU just to read limits.
		const adapter = await navigator.gpu.requestAdapter()

		if (adapter === null) {
			return null
		}

		return {
			// GPUAdapterInfo.isFallbackAdapter is newer than some WebGPU releases.
			fallback: (adapter.info as Partial<GPUAdapterInfo> | undefined)?.isFallbackAdapter ?? false,
			maxBufferSize: adapter.limits.maxBufferSize,
			maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize
		}
	} catch {
		return null
	}
}

// Cheap: a few validations and, with `gpu`, one adapter request (no device is created).
export async function probeDevice({ gpu }: { gpu: boolean }): Promise<DeviceProbe> {
	const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory

	return {
		userAgent: navigator.userAgent,
		crossOriginIsolated: globalThis.crossOriginIsolated,
		wasm: {
			simd: WebAssembly.validate(SIMD_MODULE),
			exceptions: WebAssembly.validate(EXCEPTIONS_MODULE),
			memory64: supportsMemory64(),
			jspi: "Suspending" in WebAssembly
		},
		opfs: typeof navigator.storage.getDirectory === "function",
		hardwareConcurrency: navigator.hardwareConcurrency,
		maxTouchPoints: (navigator as Partial<Navigator>).maxTouchPoints ?? 0,
		deviceMemoryGiB: typeof memory === "number" ? memory : null,
		webgpu: gpu && gpuConsidered(navigator.userAgent) ? await probeWebGpu() : null
	}
}
