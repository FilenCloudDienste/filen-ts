import * as Comlink from "comlink"
import { isAbortError, type AudioSynthKind } from "@filen/shared"
import type { AnyFile } from "@filen/sdk-rs"
import { registerPortStream, releasePreviewStream } from "@/features/preview/lib/previewStream"
import { mseFailureKind, mseOpenFailureKind } from "@/features/preview/lib/previewPlayback.logic"
import type { MediaFailureKind } from "@/lib/media/mediaFailure"
import { openRemuxSession, type RemuxSession } from "@/lib/media/mseController"
import { holdRemuxWorker } from "@/lib/media/remuxClient"
import type { PcmStreamInfo } from "@/lib/media/remuxTypes"
import type { RemuxSource } from "@/lib/media/playback/remuxSession"
import { linkedRemuxSource, originRemuxSource, remuxSource } from "@/lib/media/playback/sources"
import { originKey, originSize, type ByteOrigin, type OriginAccess } from "@/lib/sdk/byteOrigin"

// An audio file decoded into a WAV stream in the remux worker and served by the service worker's range route
// at a URL an <audio> element plays like any other: the worker reads the file through the SDK worker's range
// port and answers the service worker's reads on a second port. Nothing of the file or of its decoded audio is
// held beyond what the element's current requests need.

export interface DecodedAudioStream {
	url: string
	info: PcmStreamInfo
	// The element is done with the URL: the registration, the decode and the file's port go.
	release(): void
}

// What is decoded: a drive or public link file, or any origin the SDK worker reads (an archive's entry).
export type DecodedAudioSubject =
	{ readonly file: AnyFile; readonly access: "authed" | "anon" } | { readonly origin: ByteOrigin; readonly access: OriginAccess }

// Rejects with AudioUnsupportedError (isAudioUnsupported) when nothing in the file can be decoded, and with
// another error when the service worker cannot take the stream (the caller falls back to MediaSource).
// `synth` names the synthesizer a file a synthesizer renders needs (audioSynthKind).
export async function openDecodedAudioStream(
	params: DecodedAudioSubject & {
		synth?: AudioSynthKind | undefined
		id?: string
	}
): Promise<DecodedAudioStream> {
	const { synth, id = crypto.randomUUID() } = params
	const hold = await holdRemuxWorker()
	const source =
		"origin" in params
			? originRemuxSource(params.origin, params.access)
			: params.access === "anon"
				? linkedRemuxSource(params.file)
				: remuxSource(params.file)
	const size = "origin" in params ? originSize(params.origin) : Number(params.file.size)
	// The synthesizer's cache key: what the bytes are.
	const key = "origin" in params ? originKey(params.origin) : params.file.uuid
	let released = false
	const opened: { info: PcmStreamInfo | null } = { info: null }
	const release = (): void => {
		if (released) {
			return
		}

		released = true
		releasePreviewStream(id)
		source.close()
		hold.release()
	}

	try {
		const url = await registerPortStream(
			id,
			async output => {
				const input = await source.openPort()

				const info = await Promise.race([
					hold.remote.openPcm(
						Comlink.transfer(
							{
								port: input,
								size,
								...(synth === undefined ? {} : { synth: { kind: synth, key } })
							},
							[input]
						),
						Comlink.transfer(output, [output])
					),
					hold.dead
				])

				opened.info = info

				return { name: "audio.wav", size: info.size, contentType: info.contentType, readAhead: false }
			},
			() => {
				source.close()

				// The decode ends at once, whether or not the service worker ever read its port.
				if (opened.info !== null) {
					void hold.remote.closePcm(opened.info.id).catch(() => undefined)
				}
			}
		)

		if (opened.info === null) {
			throw new Error("the decoded audio stream was not opened")
		}

		return { url, info: opened.info, release }
	} catch (error) {
		release()

		throw error
	}
}

// An audio file played through MediaSource instead, where no service worker serves the page: the remux worker
// copies or decodes its audio into fragmented MP4 as the element's buffer drains. `attach` reports what goes
// wrong through `onFailure`, never by rejecting.
export interface AudioMediaSource {
	attach(element: HTMLMediaElement, options: { startTime?: number; onFailure: (kind: MediaFailureKind) => void }): Promise<void>
	dispose(): void
}

export function audioMediaSource(params: { file: AnyFile; access: "authed" | "anon" }): AudioMediaSource {
	const { file, access } = params
	const lifetime = new AbortController()
	// A function rather than a read: it changes across the awaits below.
	const disposed = (): boolean => lifetime.signal.aborted
	let session: RemuxSession | null = null
	let source: RemuxSource | null = null
	let portOpen = false

	return {
		attach: async (element, { startTime = 0, onFailure }) => {
			try {
				const opening = access === "anon" ? linkedRemuxSource(file) : remuxSource(file)

				source = opening

				const port = await opening.openPort()

				portOpen = true

				if (disposed()) {
					port.close()
					opening.close()

					return
				}

				const opened = await openRemuxSession({
					port,
					size: Number(file.size),
					startTime,
					onFailure: reason => {
						if (!disposed()) {
							onFailure(mseFailureKind(reason))
						}
					}
				})

				if (disposed()) {
					opened.dispose()

					return
				}

				session = opened
				await opened.attach(element)
			} catch (error) {
				// An AbortError is the worker ended at sign-out, not a failure of the file.
				if (!disposed() && !isAbortError(error)) {
					onFailure(mseOpenFailureKind(error))
				}
			}
		},
		dispose: () => {
			lifetime.abort()
			session?.dispose()

			if (portOpen) {
				source?.close()
			}
		}
	}
}
