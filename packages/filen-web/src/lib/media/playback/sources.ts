import * as Comlink from "comlink"
import type { AnyFile } from "@filen/sdk-rs"
import { sdkApi } from "@/lib/sdk/client"
import {
	holdPreviewStreamAlive,
	onPreviewStreamGone,
	previewStreamStatus,
	previewStreamUrl,
	releasePreviewStream
} from "@/features/preview/lib/previewStream"
import type { DirectSource } from "@/lib/media/playback/directSession"
import type { RemuxSource } from "@/lib/media/playback/remuxSession"
import { warmRemuxFile, type RemuxWarmth } from "@/lib/media/mseController"
import type { VideoProbe } from "@filen/shared/videos"

// The app's byte sources for playback sessions: the service worker's range route and the SDK worker's
// range ports.

// `access: "anon"` (a public link's file) streams through the SDK worker's unauthenticated client; never
// prewarmed.
export function directSource(params: { file: AnyFile; name: string; contentType: string; access?: RangeAccess }): DirectSource {
	const { file, name, contentType, access = "authed" } = params
	const presetId = access === "anon" ? null : takeWarmDirect(file.uuid)

	return {
		register: id =>
			access === "anon" ? previewStreamUrl(file, name, contentType, id, { access }) : previewStreamUrl(file, name, contentType, id),
		release: releasePreviewStream,
		holdAlive: holdPreviewStreamAlive,
		onGone: onPreviewStreamGone,
		status: previewStreamStatus,
		...(presetId === null ? {} : { presetId })
	}
}

// Which SDK client serves the bytes: the session's, or an unauthenticated one for a public link's file.
type RangeAccess = "authed" | "anon"

function createRemuxSource(file: AnyFile, options: { warmKey?: string; access?: RangeAccess } = {}): RemuxSource {
	const { warmKey, access = "authed" } = options
	const token = crypto.randomUUID()

	return {
		openPort: async () => {
			const { port1, port2 } = new MessageChannel()
			const transferred = Comlink.transfer(port1, [port1])

			await (access === "anon"
				? sdkApi.openLinkedRangePortAnon(transferred, file, token)
				: sdkApi.openRangePort(transferred, file, token))

			return port2
		},
		close: () => {
			void sdkApi.cancelPreviewDownload(token)
		},
		...(warmKey === undefined ? {} : { warmKey })
	}
}

export function remuxSource(file: AnyFile): RemuxSource {
	return takeWarmRemux(file.uuid) ?? createRemuxSource(file)
}

// An audio file's bytes for its edge analysis: always a port of its own, never the file warmed for playback.
export function analysisRemuxSource(file: AnyFile): RemuxSource {
	return createRemuxSource(file)
}

// A public link's file, read without a session; never prewarmed.
export function linkedRemuxSource(file: AnyFile): RemuxSource {
	return createRemuxSource(file, { access: "anon" })
}

// ── Prewarm ─────────────────────────────────────────────────────────────────
// The next item, readied while the current one ends (Up Next shows): a Matroska file or transport stream is
// opened in the remux worker (its head and index read into the cache the session then takes over, through the
// same port); a file played as it is gets its service worker registration up front. One at a time, once per
// file.

type Warm =
	| { kind: "remux"; fileUuid: string; source: RemuxSource; port: Promise<void>; warmth: Promise<RemuxWarmth> }
	| { kind: "direct"; fileUuid: string; id: string; registered: Promise<unknown> }

let warm: Warm | null = null

const DIRECT_TYPES: Readonly<Record<string, string>> = { mp4: "video/mp4", mov: "video/mp4", webm: "video/webm" }

export function prewarmPlayback(params: { file: AnyFile; name: string; probe: VideoProbe; idrOnlyStart: boolean }): void {
	const { file, name, probe } = params

	if (warm?.fileUuid === file.uuid) {
		return
	}

	cancelPrewarm()

	if (probe.container === "mkv" || probe.container === "ts") {
		const key = crypto.randomUUID()
		const source = createRemuxSource(file, { warmKey: key })
		const port = source.openPort()

		warm = {
			kind: "remux",
			fileUuid: file.uuid,
			source,
			port: port.then(
				() => undefined,
				() => undefined
			),
			warmth: port.then(opened =>
				warmRemuxFile({
					port: opened,
					size: Number(file.size),
					key,
					idrOnlyStart: params.idrOnlyStart,
					...(probe.index === null ? {} : { index: probe.index })
				})
			)
		}
		warm.warmth.catch(() => {
			cancelPrewarm(file.uuid)
		})

		return
	}

	const contentType = DIRECT_TYPES[probe.container]

	if (contentType !== undefined) {
		const id = crypto.randomUUID()

		warm = { kind: "direct", fileUuid: file.uuid, id, registered: previewStreamUrl(file, name, contentType, id).catch(() => undefined) }
	}
}

// Lets go of what was readied and not taken (Watch credits, a seek back, the player closing).
export function cancelPrewarm(fileUuid?: string): void {
	const current = warm

	if (current === null || (fileUuid !== undefined && current.fileUuid !== fileUuid)) {
		return
	}

	warm = null

	if (current.kind === "direct") {
		releasePreviewStream(current.id)

		return
	}

	current.source.close()
	void current.warmth.then(
		warmth => {
			warmth.cancel()
		},
		() => undefined
	)
}

function takeWarmRemux(fileUuid: string): RemuxSource | null {
	const current = warm

	if (current?.kind !== "remux" || current.fileUuid !== fileUuid) {
		return null
	}

	warm = null

	const warmed = current.warmth.then(
		warmth => {
			warmth.handOver()
		},
		() => undefined
	)

	return { ...current.source, warmed, warmPort: current.port }
}

function takeWarmDirect(fileUuid: string): string | null {
	const current = warm

	if (current?.kind !== "direct" || current.fileUuid !== fileUuid) {
		return null
	}

	warm = null

	return current.id
}
