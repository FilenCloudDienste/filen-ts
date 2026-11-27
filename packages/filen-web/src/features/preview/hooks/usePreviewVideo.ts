import { useEffect, useEffectEvent, useState, useSyncExternalStore } from "react"
import type { AnyFile } from "@filen/sdk-rs"
import { toast } from "sonner"
import { driveItemName, formatSecondsToMediaClock } from "@filen/shared"
import { narrowToAnyFile } from "@/features/drive/lib/download"
import { itemTypeExtension } from "@/features/drive/lib/preview.logic"
import type { DriveItem } from "@/features/drive/lib/item"
import { sdkApi } from "@/lib/sdk/client"
import { PROBE_RANK, recordSatisfies } from "@/features/videos/lib/probeService.logic"
import { probeService } from "@/features/videos/lib/probeService"
import { directSource, linkedRemuxSource, remuxSource } from "@/lib/media/playback/sources"
import { allowedMediaContentType } from "@/features/preview/lib/mediaType"
import {
	holdPreviewStream,
	isMediaStreamAvailable,
	onPreviewStreamGone,
	previewStreamIdOf,
	previewStreamUrl,
	releasePreviewStreamSoon
} from "@/features/preview/lib/previewStream"
import { getPreviewStreamId, previewCacheEpoch, setPreviewStreamId } from "@/features/preview/lib/previewCache"
import { usePreviewAccessMode, usePreviewCacheScope, type PreviewAccessMode } from "@/features/preview/lib/accessMode"
import { bindVideoResume, videoStartTime } from "@/features/preview/lib/videoContinuity"
import { seekMedia } from "@/lib/media/useMediaState"
import { i18n } from "@/lib/i18n"
import { takeLinkedTransportStreamProbe } from "@/features/preview/lib/transportStreamProbe"
import { initialVideoRoute } from "@/features/preview/lib/previewPlayback.logic"
import { recordProbeVerdict } from "@/features/drive/lib/contentVerdicts"
import { anyFileTypeFacts } from "@/features/drive/lib/item"
import {
	PreviewVideo,
	type PreviewProbeResult,
	type PreviewVideoDeps,
	type PreviewVideoSnapshot
} from "@/features/preview/lib/previewVideo"

// The probe the preview's ladder reads: the drive's goes through the probe service (cached per file, shared
// with Videos); a public link's is read once, nothing kept, unless its transport stream gate just read it.
// What it says about the file's kind is kept as a verdict (contentVerdicts.ts) where it changes the file's
// kind; a public link's in memory only.
async function probeFile(file: AnyFile, access: PreviewAccessMode, signal: AbortSignal): Promise<PreviewProbeResult> {
	const result = await readProbe(file, access, signal)
	const facts = result.status === "probed" ? anyFileTypeFacts(file) : null

	if (result.status === "probed" && facts !== null) {
		recordProbeVerdict({ uuid: file.uuid, ...facts }, result.probe, { memoryOnly: access !== "authed" })
	}

	return result
}

async function readProbe(file: AnyFile, access: PreviewAccessMode, signal: AbortSignal): Promise<PreviewProbeResult> {
	if (access === "authed") {
		const record = await probeService.request({ uuid: file.uuid, file }, "full", { rank: () => PROBE_RANK.explicit, signal })

		return record === null ? { status: "unavailable" } : { status: "probed", probe: record.probe }
	}

	const gated = takeLinkedTransportStreamProbe(file.uuid)

	if (gated !== null) {
		return { status: "probed", probe: gated }
	}

	const token = crypto.randomUUID()
	const stop = (): void => {
		void sdkApi.cancelPreviewDownload(token)
	}

	signal.addEventListener("abort", stop, { once: true })

	try {
		return { status: "probed", probe: await sdkApi.readLinkedVideoProbeAnon(file, "full", token) }
	} catch {
		return { status: "unavailable" }
	} finally {
		signal.removeEventListener("abort", stop)
	}
}

function previewVideoDeps(params: {
	file: AnyFile
	name: string
	contentType: string | null
	access: PreviewAccessMode
	cacheScope: string | null
}): PreviewVideoDeps {
	const { file, name, contentType, access, cacheScope } = params

	return {
		// A revisit reuses the id this item was registered under (previewCache.ts), so the element gets the
		// same URL and the browser can answer it from what it already holds. The controller holds the id until
		// it hands the URL back (PreviewVideoDeps.release); a registration that fails lets go here.
		registerDirect: async () => {
			if (contentType === null) {
				throw new Error("no inline content type")
			}

			const epoch = previewCacheEpoch()
			const id = getPreviewStreamId(cacheScope, file.uuid, contentType) ?? crypto.randomUUID()

			holdPreviewStream(id)

			const url = await previewStreamUrl(file, name, contentType, id, { access }).catch((error: unknown) => {
				releasePreviewStreamSoon(id)

				throw error
			})

			setPreviewStreamId(cacheScope, file.uuid, contentType, id, epoch)

			return url
		},
		probe: signal => probeFile(file, access, signal),
		// A full probe the drive already holds names the audio tracks and chapters at once, with no read.
		peek: () => {
			const record = access === "authed" ? probeService.peek(file.uuid) : undefined

			return record != null && recordSatisfies(record, "full", () => name) ? record.probe : null
		},
		onStreamGone: (url, listener) => onPreviewStreamGone(previewStreamIdOf(url), listener),
		// The service worker serves a public link's file too, through an unauthenticated range port.
		playbackDeps: allowDirect => ({
			directAvailable: () => allowDirect && isMediaStreamAvailable(),
			directSource: params => directSource({ ...params, access }),
			remuxSource: access === "anon" ? linkedRemuxSource : remuxSource
		})
	}
}

export interface PreviewVideoState {
	controller: PreviewVideo | null
	snapshot: PreviewVideoSnapshot | null
}

const IDLE: PreviewVideoState = { controller: null, snapshot: null }

// The controller an effect run made, as a store: each run makes its own (a remount, a strict-mode
// re-run), so a disposed one is never opened again.
class PreviewVideoSlot {
	private state: PreviewVideoState = IDLE
	private unsubscribe: (() => void) | null = null
	private readonly listeners = new Set<() => void>()

	public readonly subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener)

		return () => {
			this.listeners.delete(listener)
		}
	}

	public readonly getSnapshot = (): PreviewVideoState => this.state

	public set(controller: PreviewVideo | null): void {
		this.unsubscribe?.()
		this.unsubscribe = null

		if (controller !== null) {
			this.unsubscribe = controller.subscribe(() => {
				this.publish({ controller, snapshot: controller.getSnapshot() })
			})
		}

		this.publish(controller === null ? IDLE : { controller, snapshot: controller.getSnapshot() })
	}

	public clear(controller: PreviewVideo): void {
		if (this.state.controller === controller) {
			this.set(null)
		}
	}

	private publish(state: PreviewVideoState): void {
		this.state = state

		for (const listener of this.listeners) {
			listener()
		}
	}
}

// Plays `item` on `video` for as long as both stay: a new file (or element) gets a new controller.
export function usePreviewVideo(item: DriveItem, video: HTMLVideoElement | null, positionKey: string): PreviewVideoState {
	const access = usePreviewAccessMode()
	const cacheScope = usePreviewCacheScope()
	const [slot] = useState(() => new PreviewVideoSlot())
	const uuid = item.data.uuid
	// Read when playback starts rather than keyed on: a metadata-only update (favorite, reconcile) hands
	// over a new item for the same file, which must not restart playback.
	const itemOf = useEffectEvent(() => item)

	useEffect(() => {
		if (video === null) {
			return
		}

		const current = itemOf()
		const file = narrowToAnyFile(current)
		const name = driveItemName(current)
		const contentType = allowedMediaContentType(current)
		const stableUuid = "stableUUID" in file ? file.stableUUID : undefined

		// Only the preview's own player (keyed by the file) remembers a video of the user's own across sessions.
		if (access === "authed" && positionKey === uuid && stableUuid !== undefined) {
			bindVideoResume(positionKey, { stableUuid, uuid: file.uuid, size: Number(file.size) })
		}

		const start = videoStartTime(positionKey)
		const controller = new PreviewVideo({
			file,
			name,
			route: initialVideoRoute({
				extension: itemTypeExtension(current),
				contentType,
				streamAvailable: isMediaStreamAvailable()
			}),
			startTime: start.seconds,
			deps: previewVideoDeps({ file, name, contentType, access, cacheScope })
		})

		slot.set(controller)
		controller.open(video)

		const element = video
		// Resumed where an earlier session left it: say so, with the way back to the start.
		const resumedToast = start.resumed
			? toast(i18n.t("preview:videoResumedAt", { time: formatSecondsToMediaClock(start.seconds) }), {
					action: {
						label: i18n.t("preview:videoStartOver"),
						onClick: () => {
							seekMedia(element, 0)
						}
					}
				})
			: null

		return () => {
			if (resumedToast !== null) {
				toast.dismiss(resumedToast)
			}

			controller.dispose()
			slot.clear(controller)
		}
	}, [slot, video, uuid, access, cacheScope, positionKey])

	return useSyncExternalStore(slot.subscribe, slot.getSnapshot)
}
