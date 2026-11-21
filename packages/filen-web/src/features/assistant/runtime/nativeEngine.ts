import { QUARANTINE_CONTEXT_TOKENS, ROUTER_CONTEXT_TOKENS, type AssistantGenerateResult } from "@filen/shared/assistant"
import type { DesktopAssistant, DesktopAssistantError, DesktopAssistantEvent, DesktopAssistantResult } from "@filen/shared/desktop"
import { desktopAssistant } from "@/lib/desktop"
import type { AssistantWorkerApi } from "@/workers/assistant.worker"
import { ENGINE_CRASHED, type GenerationUpdate } from "@/features/assistant/runtime/engineMessages"
import type { ModelDownloadProgress } from "@/features/assistant/runtime/download"
import type { AssistantModelManifest } from "@/features/assistant/runtime/manifest"
import {
	deleteModels as deleteOpfsModels,
	inspectModel as inspectOpfsModel,
	modelDirectory as opfsModelDirectory,
	readVerified as readOpfsVerified
} from "@/features/assistant/runtime/modelStore"
import { log } from "@/lib/log"

// The desktop app's native engine (llama.cpp in a utility process of its own, desktop/src/assistant) behind the
// worker's API, so the client runs it as it runs its worker. Its model is a plain file in the app's data directory,
// downloaded from the same pinned shards; only the model files and the AssistantModel requests cross the bridge.

// A load that found no backend of the native engine running here: the client falls back to its own engine.
export const NATIVE_UNAVAILABLE = "ModelLoadError:unavailable"

// The worker's calls, as the client awaits them.
export type EngineApi = {
	[K in keyof AssistantWorkerApi]: (...args: Parameters<AssistantWorkerApi[K]>) => Promise<Awaited<ReturnType<AssistantWorkerApi[K]>>>
}

export function nativeAssistant(): DesktopAssistant | undefined {
	return desktopAssistant()
}

function named(name: string, message: string): Error {
	const error = new Error(message)

	error.name = name

	return error
}

// The names the client reads from the worker's errors.
function downloadFailure(error: DesktopAssistantError, message: string): Error {
	switch (error) {
		case "aborted":
			return named("AbortError", message)
		case "integrity":
		case "storage-full":
			return named(`ModelDownloadError:${error}`, message)
		default:
			return named("ModelDownloadError:network", message)
	}
}

function loadFailure(error: DesktopAssistantError, message: string): Error {
	switch (error) {
		case "unavailable":
			return named(NATIVE_UNAVAILABLE, message)
		case "missing":
		case "out-of-memory":
			return named(`ModelLoadError:${error}`, message)
		default:
			return named("ModelLoadError:load-failed", message)
	}
}

function generateFailure(error: DesktopAssistantError, message: string): Error {
	switch (error) {
		case "aborted":
			return named("AbortError", message)
		case "crashed":
			return named(ENGINE_CRASHED, message)
		default:
			return new Error(message)
	}
}

function unwrap<T>(result: DesktopAssistantResult<T>, failure: (error: DesktopAssistantError, message: string) => Error): T {
	if (!result.ok) {
		throw failure(result.error, result.message)
	}

	return result.value
}

// One chunk in flight, so the page holds at most this much of the model while it imports its copy.
export const IMPORT_CHUNK_BYTES = 8 * 1024 * 1024

// The page's own copy (OPFS) of the model, the shards it verified, handed to the native engine's directory instead of
// downloaded again. Main keeps a shard only once its sha256 matches the pinned manifest; one that does not, or any
// failure, leaves it to the download that follows. Reads one chunk at a time.
async function importPageCopy({
	bridge,
	manifest,
	signal,
	onProgress
}: {
	bridge: DesktopAssistant
	manifest: AssistantModelManifest
	signal: AbortSignal
	onProgress: (progress: ModelDownloadProgress) => void
}): Promise<void> {
	if ((await inspectOpfsModel(manifest)).verifiedBytes === 0) {
		return
	}

	const directory = await opfsModelDirectory(manifest.id)
	const verified = await readOpfsVerified(directory)
	let received = (await bridge.inspect(manifest)).verifiedBytes

	for (const shard of manifest.shards) {
		const file =
			verified.get(shard.file) === shard.sha256
				? await directory
						.getFileHandle(shard.file)
						.then(handle => handle.getFile())
						.catch(() => null)
				: null

		if (file?.size !== shard.size) {
			continue
		}

		for (let at = 0; ;) {
			signal.throwIfAborted()

			const end = Math.min(at + IMPORT_CHUNK_BYTES, shard.size)
			const bytes = new Uint8Array(await file.slice(at, end).arrayBuffer())
			const result = await bridge.importChunk(manifest, shard.file, at, bytes, end === shard.size)

			if (!result.ok) {
				log.warn("assistant", `importing ${shard.file} from the browser's copy failed; it is downloaded instead`, result.message)
				received -= at

				break
			}

			if (result.value === "present") {
				break
			}

			received += end - at
			onProgress({ receivedBytes: received, waiting: false })

			if (result.value === "verified") {
				break
			}

			at = end
		}
	}
}

// The engine's calls over the bridge, alive until `stop`; `onLost` runs when its process ends on its own.
export function createNativeEngine(bridge: DesktopAssistant, onLost: () => void): { remote: EngineApi; stop(): void } {
	let onDownload: ((progress: ModelDownloadProgress) => void) | null = null
	let importing: AbortController | null = null
	let onVerifying: (() => void) | null = null
	const updates = new Map<number, (update: GenerationUpdate) => void>()
	const unsubscribe = bridge.onEvent((event: DesktopAssistantEvent) => {
		switch (event.kind) {
			case "download":
				onDownload?.({ receivedBytes: event.receivedBytes, waiting: event.waiting })
				break
			case "verifying":
				onVerifying?.()
				break
			case "update":
				updates.get(event.id)?.(event.update)
				break
			case "exited":
				onLost()
				break
		}
	})

	const remote: EngineApi = {
		download: async (manifest, baseUrl, onProgress) => {
			const controller = new AbortController()

			importing = controller

			try {
				await importPageCopy({ bridge, manifest, signal: controller.signal, onProgress }).catch((e: unknown) => {
					if (controller.signal.aborted) {
						throw named("AbortError", "The download was stopped")
					}

					log.warn("assistant", "importing the browser's model copy failed; it is downloaded instead", e)
				})
			} finally {
				importing = null
			}

			onDownload = onProgress

			try {
				// Whatever the import left (nothing, when it brought every shard) comes from the model host.
				unwrap(await bridge.download(manifest, baseUrl), downloadFailure)
			} finally {
				onDownload = null
			}

			// The page's own copy is dead weight once the native one is verified. The client holds the model's lock.
			await deleteOpfsModels().catch((e: unknown) => {
				log.warn("assistant", "removing the browser's model copy failed", e)
			})
		},
		cancelDownload: () => {
			importing?.abort()
			bridge.cancelDownload()

			return Promise.resolve()
		},
		load: async (manifest, options, verifying) => {
			onVerifying = verifying ?? null

			try {
				const loaded = unwrap(
					await bridge.load(manifest, {
						// One sequence a slot, each as large as the main loop's context: the worker's engine shares the cache
						// the client sizes to all three (the main loop's, the router's and the extraction's).
						sequenceTokens: options.contextTokens - ROUTER_CONTEXT_TOKENS - QUARANTINE_CONTEXT_TOKENS,
						primeSystem: options.primeSystem ?? ""
					}),
					loadFailure
				)

				return {
					specialTokens: loaded.specialTokens,
					...(loaded.promptBatchMs === undefined ? {} : { promptBatchMs: loaded.promptBatchMs })
				}
			} finally {
				onVerifying = null
			}
		},
		generate: async (id, request, onUpdate): Promise<AssistantGenerateResult> => {
			if (onUpdate !== undefined) {
				updates.set(id, onUpdate)
			}

			try {
				return unwrap(await bridge.generate(id, request, onUpdate !== undefined), generateFailure)
			} finally {
				updates.delete(id)
			}
		},
		cancel: id => {
			bridge.cancel(id)

			return Promise.resolve()
		},
		// Each slot keeps its own sequence: nothing pushes the router's cached prompt out.
		reprime: () => Promise.resolve(),
		unload: () => bridge.unload()
	}

	return {
		remote,
		stop: () => {
			unsubscribe()
			updates.clear()
			bridge.release()
		}
	}
}
