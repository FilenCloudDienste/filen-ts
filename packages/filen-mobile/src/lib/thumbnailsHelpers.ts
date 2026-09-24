import * as FileSystem from "expo-file-system"
import { AnyFile } from "@filen/sdk-rs"
import { type DriveItem } from "@/types"
import useHttpStore from "@/stores/useHttp.store"
import { THUMBNAILS_DIRECTORY as DIRECTORY } from "@/lib/storageRoots"
import { getPreviewType } from "@/lib/previewType"

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

export { driveItemToAnyFile } from "@/lib/sdkSources"

export type ThumbnailKind = "image" | "video"

// Two gates, both required for an image: DISPLAYABILITY — the gallery can open it on this
// platform, decided by the one classifier the gallery uses — and the SDK's own per-file verdict
// `canMakeThumbnail` (computed in Rust from decrypted name + mime, carried on every File /
// SharedFile / LinkedFile since 0.4.42 and copied onto the hand-built records). The flag is the
// contract: `false` means the SDK will not thumbnail this file, so it is never asked, and formats
// the SDK learns later light up on their own — no format list for SDK support lives here.
// image | rawImage → the SDK, from a local copy's path or over the network; video → the JS frame
// extractor (the SDK flag is about images and does not apply). svg is excluded on purpose: resvg renders
// <text> and raster <image> as nothing, and a transparent tile on the OLED-black theme is worse
// than the icon.
export function getThumbnailKindForName(name: string, canMakeThumbnail: boolean): ThumbnailKind | null {
	switch (getPreviewType(name)) {
		case "image":
		case "rawImage": {
			return canMakeThumbnail ? "image" : null
		}

		case "video": {
			return "video"
		}

		default: {
			return null
		}
	}
}

// The upload path knows a name and a flag but has no DriveItem yet, so it calls
// getThumbnailKindForName directly. Both entry points must answer identically: a format that
// thumbnails only on the device that uploaded it is worse than one that never does.
export function getThumbnailKind(item: DriveItem): ThumbnailKind | null {
	if (item.type !== "file" && item.type !== "sharedFile" && item.type !== "sharedRootFile") {
		return null
	}

	const name = item.data.decryptedMeta?.name

	if (!name) {
		return null
	}

	return getThumbnailKindForName(name, item.data.canMakeThumbnail === true)
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
