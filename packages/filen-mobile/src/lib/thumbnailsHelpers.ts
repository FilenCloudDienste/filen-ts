import * as FileSystem from "expo-file-system"
import { AnyFile } from "@filen/sdk-rs"
import type { DriveItem } from "@/types"
import useHttpStore from "@/stores/useHttp.store"
import { THUMBNAILS_DIRECTORY as DIRECTORY } from "@/lib/storageRoots"

export function abortError(signal?: AbortSignal): Error {
	const reason = signal?.reason

	if (reason instanceof Error) {
		return reason
	}

	if (typeof reason !== "undefined" && reason !== null) {
		return new Error(String(reason))
	}

	return new Error("Aborted")
}

export class OfflineAbortError extends Error {
	public constructor() {
		super("Offline")

		this.name = "OfflineAbortError"
	}
}

// Distinguishes a "the local HTTP provider never became ready" timeout from a genuine
// thumbnail-generation failure. The provider is infrastructure that boots asynchronously on
// foreground; treating its absence as a content failure would permanently blacklist the uuid
// in the failures map (see thumbnails.ts). Callers exempt this error from the failure counter,
// mirroring OfflineAbortError.
export class ProviderUnavailableError extends Error {
	public constructor() {
		super("HTTP provider unavailable after 30s")

		this.name = "ProviderUnavailableError"
	}
}

export function getPath(item: DriveItem): string {
	return FileSystem.Paths.join(DIRECTORY.uri, `${item.data.uuid}.webp`)
}

export function ensureDirectory(): void {
	if (!DIRECTORY.exists) {
		DIRECTORY.create({
			idempotent: true,
			intermediates: true
		})
	}
}

export function driveItemToAnyFile(item: DriveItem): AnyFile | null {
	switch (item.type) {
		case "file": {
			return new AnyFile.File(item.data)
		}

		case "sharedFile":
		case "sharedRootFile": {
			return new AnyFile.Shared(item.data)
		}

		default: {
			return null
		}
	}
}

export function getExtension(item: DriveItem): string | null {
	switch (item.type) {
		case "file":
		case "sharedFile":
		case "sharedRootFile": {
			const name = item.data.decryptedMeta?.name

			if (!name) {
				return null
			}

			return FileSystem.Paths.extname(name).toLowerCase().trim()
		}

		default: {
			return null
		}
	}
}

export function waitForHttpProvider(signal?: AbortSignal): Promise<(file: AnyFile) => string> {
	const state = useHttpStore.getState()

	if (state.port !== null && state.getFileUrl) {
		return Promise.resolve(state.getFileUrl)
	}

	return new Promise<(file: AnyFile) => string>((resolve, reject) => {
		if (signal?.aborted) {
			reject(abortError(signal))

			return
		}

		let timeoutId: ReturnType<typeof setTimeout> | null = null

		const cleanup = () => {
			unsubscribe()

			signal?.removeEventListener("abort", onAbort)

			if (timeoutId !== null) {
				clearTimeout(timeoutId)

				timeoutId = null
			}
		}

		const unsubscribe = useHttpStore.subscribe(
			s => ({
				port: s.port,
				getFileUrl: s.getFileUrl
			}),
			({ port, getFileUrl }) => {
				if (port !== null && getFileUrl) {
					cleanup()

					resolve(getFileUrl)
				}
			}
		)

		const onAbort = () => {
			cleanup()

			reject(abortError(signal))
		}

		signal?.addEventListener("abort", onAbort, {
			once: true
		})

		timeoutId = setTimeout(() => {
			cleanup()

			reject(new ProviderUnavailableError())
		}, 30_000)
	})
}
