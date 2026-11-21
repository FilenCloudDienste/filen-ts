import * as Comlink from "comlink"
import AssistantWorker from "@/workers/assistant.worker.ts?worker"
import type { AssistantWorkerApi } from "@/workers/assistant.worker"
import type { DesktopAssistant } from "@filen/shared/desktop"
import type { AssistantModelManifest } from "@/features/assistant/runtime/manifest"
import * as opfs from "@/features/assistant/runtime/modelStore"
import { createNativeEngine, nativeAssistant, type EngineApi } from "@/features/assistant/runtime/nativeEngine"

// Where the client's model lives and runs: in this page's worker (wllama, the files in OPFS), or, in the desktop app,
// in its native engine (llama.cpp, the files in the app's data directory). Chosen once at the startup check; a native
// engine that turns out not to run here falls back to the worker for the rest of the page's life.

export interface EngineHandle {
	remote: EngineApi
	// Aborted when the engine is stopped or fails: a call to it can never be answered after that.
	closed: AbortController
	// Everything the engine held goes: the worker is terminated, the native engine's process ended.
	stop(): void
}

let native: DesktopAssistant | null = null
let selecting: Promise<void> | null = null

export function selectEngine(): Promise<void> {
	selecting ??= (async () => {
		const bridge = nativeAssistant()

		native = bridge !== undefined && (await bridge.available().catch(() => false)) ? bridge : null
	})()

	return selecting
}

export function nativeEngineActive(): boolean {
	return native !== null
}

// The native engine could not run the model: the worker takes over. False when it already had.
export function fallBackToWorker(): boolean {
	if (native === null) {
		return false
	}

	native = null

	return true
}

export function inspectModel(manifest: AssistantModelManifest): Promise<opfs.ModelInspection> {
	return native === null ? opfs.inspectModel(manifest) : native.inspect(manifest)
}

export function otherModels(id: string): Promise<{ present: boolean; bytes: number }> {
	return native === null ? opfs.otherModels(id) : native.otherModels(id)
}

// The desktop app runs the one build of the page it ships, so its other models are earlier versions: they go too.
export function deleteModelDirectory(id: string): Promise<void> {
	return native === null ? opfs.deleteModelDirectory(id) : native.deleteModels(null)
}

export function deleteModels(keep: string | null = null): Promise<void> {
	return native === null ? opfs.deleteModels(keep) : native.deleteModels(keep)
}

// `onFailed`: the engine died or never started; it answers nothing more.
export function spawnEngine(onFailed: () => void): EngineHandle {
	const closed = new AbortController()

	if (native !== null) {
		const engine = createNativeEngine(native, onFailed)

		return {
			remote: engine.remote,
			closed,
			stop: () => {
				closed.abort()
				engine.stop()
			}
		}
	}

	const worker = new AssistantWorker()
	const remote = Comlink.wrap<AssistantWorkerApi>(worker)

	worker.addEventListener("error", onFailed)
	worker.addEventListener("messageerror", onFailed)

	return {
		remote,
		closed,
		stop: () => {
			closed.abort()
			remote[Comlink.releaseProxy]()
			worker.terminate()
		}
	}
}
