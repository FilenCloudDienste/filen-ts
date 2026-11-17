/// <reference lib="webworker" />
import createLibopenmpt, { type LibopenmptModule } from "@/vendor/libopenmpt/libopenmpt.js"
import { SYNTH_SOURCE_ERROR, SYNTH_UNSUPPORTED_PREFIX, type SynthRequest, type SynthResponse } from "@/workers/synth/protocol"

// Tracker modules rendered by libopenmpt (src/vendor/libopenmpt), started by the remux worker for module playback
// and analysis. Each renderer is its own openmpt_module over the bytes loaded under its key. A call that traps or
// aborts (a hostile module, the heap's 256 MiB cap) leaves the instance unusable: the worker answers it as fatal and
// closes, and its users fail with a read error while the next open starts a fresh instance.

const scope = self as unknown as DedicatedWorkerGlobalScope

interface Renderer {
	module: number
	sampleRate: number
	// A buffer in the wasm heap the renders write into, and its size in frames.
	buffer: number
	capacity: number
}

const files = new Map<string, Uint8Array>()
const renderers = new Map<number, Renderer>()
let nextHandle = 1
let libopenmpt: Promise<LibopenmptModule> | null = null

class Unsupported extends Error {}

function open(lib: LibopenmptModule, bytes: Uint8Array, sampleRate: number): { handle: number; duration: number } {
	const data = lib._malloc(bytes.length)
	// int error, const char *error_message: written by create_from_memory2.
	const out = lib._malloc(8)

	try {
		lib.HEAPU8.set(bytes, data)
		lib.HEAPU8.fill(0, out, out + 8)

		const module = lib._openmpt_module_create_from_memory2(data, bytes.length, 0, 0, 0, 0, out, out + 4, 0)

		if (module === 0) {
			const view = new DataView(lib.HEAPU8.buffer)
			const message = view.getUint32(out + 4, true)
			const reason = message === 0 ? `error ${String(view.getInt32(out, true))}` : lib.UTF8ToString(message)

			if (message !== 0) {
				lib._openmpt_free_string(message)
			}

			throw new Unsupported(reason)
		}

		// Played once: a module that loops ends where its song does.
		lib._openmpt_module_set_repeat_count(module, 0)

		const handle = nextHandle++

		renderers.set(handle, { module, sampleRate, buffer: 0, capacity: 0 })

		return { handle, duration: lib._openmpt_module_get_duration_seconds(module) }
	} finally {
		lib._free(out)
		lib._free(data)
	}
}

function render(lib: LibopenmptModule, renderer: Renderer, frames: number): { data: ArrayBuffer; frames: number } {
	if (renderer.capacity < frames) {
		lib._free(renderer.buffer)
		renderer.buffer = lib._malloc(frames * 8)
		renderer.capacity = frames
	}

	const rendered = lib._openmpt_module_read_interleaved_float_stereo(renderer.module, renderer.sampleRate, frames, renderer.buffer)
	const data = new Float32Array(rendered * 2)

	data.set(lib.HEAPF32.subarray(renderer.buffer / 4, renderer.buffer / 4 + rendered * 2))

	return { data: data.buffer, frames: rendered }
}

function close(lib: LibopenmptModule, handle: number): void {
	const renderer = renderers.get(handle)

	if (renderer !== undefined) {
		renderers.delete(handle)
		lib._openmpt_module_destroy(renderer.module)
		lib._free(renderer.buffer)
	}
}

async function answer(request: SynthRequest): Promise<Omit<SynthResponse, "id">> {
	switch (request.type) {
		case "load":
			files.set(request.key, new Uint8Array(request.data))

			return {}
		case "unload":
			files.delete(request.key)

			return {}
		case "close":
			close(await (libopenmpt ??= createLibopenmpt()), request.handle)

			return {}
		default:
			break
	}

	const lib = await (libopenmpt ??= createLibopenmpt())

	if (request.type === "open") {
		const bytes = files.get(request.key)

		if (bytes === undefined) {
			return { error: SYNTH_SOURCE_ERROR }
		}

		return open(lib, bytes, request.sampleRate)
	}

	const renderer = renderers.get(request.handle)

	if (renderer === undefined) {
		return { error: SYNTH_SOURCE_ERROR }
	}

	if (request.type === "seek") {
		// It lands on a row boundary: the time it reports is where the next render starts.
		return { position: lib._openmpt_module_set_position_seconds(renderer.module, Math.max(0, request.seconds)) }
	}

	return render(lib, renderer, request.frames)
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

			// A trap or an abort in the module: nothing in this instance can be trusted any more.
			scope.postMessage({ id, fatal: error instanceof Error ? error.message : String(error) })
			scope.close()
		}
	)
})
