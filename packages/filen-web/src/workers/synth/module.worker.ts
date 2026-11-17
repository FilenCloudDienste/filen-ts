/// <reference lib="webworker" />
import { synthCap } from "@filen/shared"
import createLibopenmpt, { type LibopenmptModule } from "@/vendor/libopenmpt/libopenmpt.js"
import { SYNTH_SOURCE_ERROR, SYNTH_UNSUPPORTED_PREFIX, type SynthRequest, type SynthResponse } from "@/workers/synth/protocol"

// Tracker modules rendered by libopenmpt (src/vendor/libopenmpt), started by the remux worker for module playback
// and analysis. libopenmpt is instantiated on first use from the wasm the remux worker compiled once and handed over
// (init). A file's bytes are held under its key; each renderer is its own openmpt_module over them. A call that traps
// or aborts leaves the instance unusable: the worker answers it as fatal and closes, and its users fail with a read
// error while the next open starts a fresh instance. An allocation the capped heap cannot make refuses the file.

const scope = self as unknown as DedicatedWorkerGlobalScope

interface Renderer {
	module: number
	sampleRate: number
	// A buffer in the wasm heap the renders write into, and its size in frames.
	buffer: number
	capacity: number
}

const MODULE_CAP = synthCap("module")

const files = new Map<string, Uint8Array>()
const renderers = new Map<number, Renderer>()
let nextHandle = 1
let wasm: WebAssembly.Module | null = null
let libopenmpt: Promise<LibopenmptModule> | null = null
let ready: LibopenmptModule | null = null

class Unsupported extends Error {}
class SourceLost extends Error {}

function instantiate(module: WebAssembly.Module): Promise<LibopenmptModule> {
	return new Promise((resolve, reject) => {
		createLibopenmpt({
			instantiateWasm: (imports, done) => {
				WebAssembly.instantiate(module, imports).then(instance => {
					done(instance, module)
				}, reject)

				return {}
			}
		}).then(resolve, reject)
	})
}

function lib(): Promise<LibopenmptModule> {
	if (wasm === null) {
		return Promise.reject(new SourceLost("libopenmpt was not handed over"))
	}

	libopenmpt ??= instantiate(wasm).then(module => {
		ready = module

		return module
	})

	return libopenmpt
}

// `size` bytes of the heap, or Unsupported when the capped heap has no room.
function allocate(lib: LibopenmptModule, size: number): number {
	const pointer = lib._malloc(size)

	if (pointer === 0) {
		throw new Unsupported("too large for the module player")
	}

	return pointer
}

// The bytes copied into the heap for `body`, freed after.
function withHeapCopy<T>(lib: LibopenmptModule, bytes: Uint8Array, body: (pointer: number) => T): T {
	const pointer = allocate(lib, Math.max(1, bytes.length))

	try {
		lib.HEAPU8.set(bytes, pointer)

		return body(pointer)
	} finally {
		lib._free(pointer)
	}
}

// An openmpt_module over `bytes`, played once; `skipSamples` leaves its samples undecoded (enough for its length).
function create(lib: LibopenmptModule, bytes: Uint8Array, skipSamples: boolean): number {
	return withHeapCopy(lib, bytes, data => {
		const error = allocate(lib, 4)

		try {
			const module = lib._filen_open(data, bytes.length, skipSamples ? 1 : 0, error)

			if (module === 0) {
				throw new Unsupported(`libopenmpt error ${String(new DataView(lib.HEAPU8.buffer).getInt32(error, true))}`)
			}

			return module
		} finally {
			lib._free(error)
		}
	})
}

async function load(key: string, data: ArrayBuffer): Promise<Omit<SynthResponse, "id">> {
	if (data.byteLength > MODULE_CAP) {
		throw new Unsupported("larger than the module player reads")
	}

	const bytes = new Uint8Array(data)
	const openmpt = await lib()
	const module = create(openmpt, bytes, true)
	let duration: number

	try {
		duration = openmpt._filen_duration(module)
	} finally {
		openmpt._filen_close(module)
	}

	if (!Number.isFinite(duration) || duration <= 0) {
		throw new Unsupported("the module has no length")
	}

	files.set(key, bytes)

	return { duration }
}

async function probe(head: ArrayBuffer, size: number): Promise<Omit<SynthResponse, "id">> {
	const openmpt = await lib()
	const bytes = new Uint8Array(head)

	return { found: withHeapCopy(openmpt, bytes, pointer => openmpt._filen_probe(pointer, bytes.length, size)) === 1 }
}

function open(lib: LibopenmptModule, bytes: Uint8Array, sampleRate: number): { handle: number } {
	const module = create(lib, bytes, false)
	const handle = nextHandle++

	renderers.set(handle, { module, sampleRate, buffer: 0, capacity: 0 })

	return { handle }
}

function render(lib: LibopenmptModule, renderer: Renderer, frames: number): { data: ArrayBuffer; frames: number } {
	if (renderer.capacity < frames) {
		lib._free(renderer.buffer)
		renderer.buffer = 0
		renderer.capacity = 0
		// Set only once allocated: a failed allocation leaves no buffer the next render would write through.
		renderer.buffer = allocate(lib, frames * 8)
		renderer.capacity = frames
	}

	const rendered = lib._filen_render(renderer.module, renderer.sampleRate, frames, renderer.buffer)
	const data = new Float32Array(rendered * 2)

	data.set(lib.HEAPF32.subarray(renderer.buffer / 4, renderer.buffer / 4 + rendered * 2))

	return { data: data.buffer, frames: rendered }
}

// What the heap has grown to, once nothing renders: the remux worker replaces an instance that grew far (the heap
// never shrinks).
function idleHeap(): Omit<SynthResponse, "id"> {
	return ready === null || renderers.size > 0 ? {} : { heap: ready._filen_heap_bytes() }
}

async function answer(request: SynthRequest): Promise<Omit<SynthResponse, "id">> {
	switch (request.type) {
		case "init":
			wasm = request.wasm

			return {}
		case "bank":
			// Modules carry their own samples.
			return {}
		case "probe":
			return probe(request.head, request.size)
		case "load":
			return load(request.key, request.data)
		case "unload":
			files.delete(request.key)

			return idleHeap()
		case "close": {
			const renderer = renderers.get(request.handle)

			// A renderer exists only once libopenmpt runs: a close never starts it.
			if (renderer !== undefined && ready !== null) {
				renderers.delete(request.handle)
				ready._filen_close(renderer.module)
				ready._free(renderer.buffer)
			}

			return idleHeap()
		}
		case "open": {
			const bytes = files.get(request.key)

			if (bytes === undefined) {
				return { error: SYNTH_SOURCE_ERROR }
			}

			return open(await lib(), bytes, request.sampleRate)
		}
		default:
			break
	}

	const renderer = renderers.get(request.handle)

	const openmpt = ready

	if (renderer === undefined || openmpt === null) {
		return { error: SYNTH_SOURCE_ERROR }
	}

	if (request.type === "seek") {
		// It lands on a row boundary: the time it reports is where the next render starts.
		return { position: openmpt._filen_seek(renderer.module, Math.max(0, request.seconds)) }
	}

	return render(openmpt, renderer, request.frames)
}

scope.addEventListener("message", (event: MessageEvent<SynthRequest & { id: number }>) => {
	const { id } = event.data

	answer(event.data).then(
		response => {
			const transfer = response.data === undefined ? [] : [response.data]

			scope.postMessage({ id, ...response }, transfer)
		},
		(error: unknown) => {
			if (error instanceof Unsupported) {
				scope.postMessage({ id, error: `${SYNTH_UNSUPPORTED_PREFIX}${error.message}` })

				return
			}

			if (error instanceof SourceLost) {
				scope.postMessage({ id, error: SYNTH_SOURCE_ERROR })

				return
			}

			// A trap or an abort in the module: nothing in this instance can be trusted any more.
			scope.postMessage({ id, fatal: error instanceof Error ? error.message : String(error) })
			scope.close()
		}
	)
})
