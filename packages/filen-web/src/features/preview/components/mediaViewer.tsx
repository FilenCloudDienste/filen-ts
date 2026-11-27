import { useEffect, useRef, useState } from "react"
import { audioSynthKind, cn, driveItemName, isAbortError, type AudioSynthKind } from "@filen/shared"
import { asDirectoryOrFile, type DriveItem } from "@/features/drive/lib/item"
import { narrowToAnyFile } from "@/features/drive/lib/download"
import { itemTypeExtension } from "@/features/drive/lib/preview.logic"
import { BlockSource } from "@filen/shared/videos"
import { urlReadRange } from "@/lib/media/urlReadRange"
import { reportMediaFailure, type MediaFailureKind } from "@/lib/media/mediaFailure"
import { audioDemotions, audioRoute } from "@/lib/media/audioRoute.logic"
import { audioMediaSource, openDecodedAudioStream } from "@/lib/media/playback/audioStream"
import { isAudioUnsupported } from "@/lib/media/remuxTypes"
import {
	mediaControlsList,
	usePreviewAccessMode,
	useProvidedPreviewOrigin,
	usePreviewDownloadable
} from "@/features/preview/lib/accessMode"
import { allowedMediaContentType } from "@/features/preview/lib/mediaType"
import { holdPreviewStreamAlive, isMediaStreamAvailable } from "@/features/preview/lib/previewStream"
import { usePreviewStreamUrl } from "@/features/preview/hooks/usePreviewStreamUrl"
import { EntryMedia } from "@/features/preview/components/entryMedia"
import { VideoPlayer } from "@/features/preview/components/videoPlayer"
import { MediaCannotStream, MediaFormatFailure, MediaPlaybackFailure } from "@/features/preview/components/mediaFailureState"
import { PreviewLoading } from "@/features/preview/components/previewErrorState"
import { useReleaseOnUnmount } from "@/lib/media/useReleaseOnUnmount"
import { usePreviewMediaSession } from "@/features/preview/hooks/usePreviewMediaSession"
import type { ByteOrigin } from "@/lib/sdk/byteOrigin"

export interface MediaViewerProps {
	item: DriveItem
	category: "video" | "audio"
	alt: string
}

// The preview's <audio> element; `preload="metadata"` avoids streaming the whole file just to show a
// scrubber. Hidden, not unmounted, once playback failed: a fresh element would only load and fail again.
export function PreviewAudioElement({
	alt,
	src,
	hidden,
	onElement,
	onError,
	onTimeUpdate
}: {
	alt: string
	src?: string | undefined
	hidden?: boolean | undefined
	onElement?: ((audio: HTMLAudioElement | null) => void) | undefined
	onError?: ((audio: HTMLAudioElement) => void) | undefined
	onTimeUpdate?: ((audio: HTMLAudioElement) => void) | undefined
}) {
	const downloadable = usePreviewDownloadable()
	const [audio, setAudio] = useState<HTMLAudioElement | null>(null)

	usePreviewMediaSession(audio, alt)

	return (
		<audio
			ref={element => {
				setAudio(element)
				onElement?.(element)
			}}
			controls
			controlsList={mediaControlsList(downloadable)}
			preload="metadata"
			src={src}
			aria-label={alt}
			className={cn("w-full max-w-md", hidden === true && "hidden")}
			onError={
				onError === undefined
					? undefined
					: event => {
							onError(event.currentTarget)
						}
			}
			onTimeUpdate={
				onTimeUpdate === undefined
					? undefined
					: event => {
							onTimeUpdate(event.currentTarget)
						}
			}
		/>
	)
}

// Where audio that moves from one stream to another goes on from.
interface AudioResume {
	time: number
	play: boolean
}

const FROM_START: AudioResume = { time: 0, play: false }

// The file as it is, through the service worker's range route, as a signed-in page with a worker plays it. A
// stream that cannot be registered or breaks hands over to MediaSource (onStreamFailed); a format the browser
// cannot decode hands over to the decoded stream (onFormatFailed).
function StreamedAudio({
	item,
	alt,
	contentType,
	onStreamFailed,
	onFormatFailed
}: {
	item: DriveItem
	alt: string
	contentType: string
	// Where the stream stood, so the next route goes on from there.
	onStreamFailed: (resume: AudioResume) => void
	onFormatFailed: (resume: AudioResume) => void
}) {
	const result = usePreviewStreamUrl(item, driveItemName(item), contentType)
	const [audio, setAudio] = useState<HTMLAudioElement | null>(null)

	useReleaseOnUnmount(audio)
	// An idle worker loses the registration, and a paused element's next range request with it.
	useEffect(() => holdPreviewStreamAlive(), [])

	useEffect(() => {
		if (result.status === "error") {
			onStreamFailed(FROM_START)
		}
	}, [result.status, onStreamFailed])

	if (result.status !== "success") {
		return <PreviewLoading />
	}

	return (
		<div className="relative flex size-full items-center justify-center px-6">
			<PreviewAudioElement
				alt={alt}
				src={result.url}
				onElement={setAudio}
				onError={element => {
					// Reads the file's first block to tell a format failure from a broken stream.
					const blocks = new BlockSource(Number(asDirectoryOrFile(item).data.size), urlReadRange(result.url))
					const resume = { time: element.currentTime, play: !element.paused }

					reportMediaFailure(element, blocks, kind => {
						if (kind === "other") {
							onStreamFailed(resume)
						} else {
							onFormatFailed(resume)
						}
					})
				}}
			/>
		</div>
	)
}

// The file's audio decoded in the remux worker into a WAV stream the service worker serves, for what the
// browser cannot play as it is. A stream the service worker cannot take, or that breaks, hands over to
// MediaSource; a file nothing decodes shows the format failure.
function DecodedAudio({
	item,
	alt,
	resume,
	synth,
	onStreamFailed,
	origin
}: {
	item: DriveItem
	alt: string
	resume: AudioResume
	synth: AudioSynthKind | undefined
	onStreamFailed: (resume: AudioResume) => void
	// An archive's entry: decoded from its origin, not from a drive file.
	origin?: ByteOrigin | undefined
}) {
	const access = usePreviewAccessMode()
	// What is decoded, as it was on mount: a provider hands over a new origin object for the same bytes each render.
	const [subject] = useState(() => (origin === undefined ? { file: narrowToAnyFile(item) } : { origin }))
	const [state, setState] = useState<{ status: "pending" } | { status: "ready"; url: string } | { status: "unsupported" }>({
		status: "pending"
	})
	const [audio, setAudio] = useState<HTMLAudioElement | null>(null)
	const resumed = useRef(false)

	useReleaseOnUnmount(audio)
	useEffect(() => holdPreviewStreamAlive(), [])

	useEffect(() => {
		let live = true
		let release: (() => void) | null = null

		void openDecodedAudioStream({ ...subject, access, synth }).then(
			stream => {
				if (live) {
					release = () => {
						stream.release()
					}
					setState({ status: "ready", url: stream.url })
				} else {
					stream.release()
				}
			},
			(error: unknown) => {
				// An AbortError is the worker ended at sign-out: nothing to fall back to.
				if (!live || isAbortError(error)) {
					return
				}

				if (isAudioUnsupported(error)) {
					setState({ status: "unsupported" })
				} else {
					onStreamFailed(resume)
				}
			}
		)

		return () => {
			live = false
			release?.()
		}
	}, [subject, access, synth, resume, onStreamFailed])

	if (state.status === "unsupported") {
		return (
			<MediaFormatFailure
				item={item}
				codecs={[]}
			/>
		)
	}

	if (state.status === "pending") {
		return <PreviewLoading />
	}

	return (
		<div className="relative flex size-full items-center justify-center px-6">
			<PreviewAudioElement
				alt={alt}
				src={state.url}
				onElement={element => {
					setAudio(element)

					if (element !== null && !resumed.current && (resume.time > 0 || resume.play)) {
						resumed.current = true
						element.currentTime = resume.time

						if (resume.play) {
							void element.play().catch(() => undefined)
						}
					}
				}}
				onError={element => {
					onStreamFailed({ time: element.currentTime, play: !element.paused })
				}}
			/>
		</div>
	)
}

// Streamed through MediaSource: the remux worker reads the file's ranges from the SDK worker (an
// unauthenticated client for a public link), so this plays with no service worker at all and never
// holds more of the file than its buffer window.
function MediaSourceAudio({ item, alt, resume: initialResume }: { item: DriveItem; alt: string; resume: AudioResume }) {
	const access = usePreviewAccessMode()
	const [audio, setAudio] = useState<HTMLAudioElement | null>(null)
	const [failure, setFailure] = useState<MediaFailureKind | null>(null)
	// Where a retry goes on from: the start, then wherever the element last really was.
	const [resume, setResume] = useState(initialResume)
	const lastPosition = useRef<AudioResume>(initialResume)
	const [file] = useState(() => narrowToAnyFile(item))

	useEffect(() => {
		if (audio === null) {
			return
		}

		const media = audioMediaSource({ file, access })
		let failed = false

		void media
			.attach(audio, {
				startTime: resume.time,
				onFailure: kind => {
					failed = true
					setFailure(kind)
				}
			})
			.then(() => {
				if (resume.play && !failed) {
					void audio.play().catch(() => undefined)
				}
			})

		return () => {
			media.dispose()
		}
	}, [audio, file, access, resume])

	return (
		<div className="relative flex size-full items-center justify-center px-6">
			<PreviewAudioElement
				alt={alt}
				hidden={failure !== null}
				onElement={setAudio}
				onTimeUpdate={element => {
					if (element.readyState >= HTMLMediaElement.HAVE_METADATA && !element.seeking) {
						lastPosition.current = { time: element.currentTime, play: !element.paused }
					}
				}}
			/>
			{failure === "format" ? (
				<div className="absolute inset-0">
					<MediaFormatFailure
						item={item}
						codecs={[]}
					/>
				</div>
			) : failure === "other" ? (
				<div className="absolute inset-0">
					<MediaPlaybackFailure
						onRetry={() => {
							setFailure(null)
							setResume({ ...lastPosition.current })
						}}
					/>
				</div>
			) : null}
		</div>
	)
}

function hasMediaSource(): boolean {
	return typeof MediaSource !== "undefined" || "ManagedMediaSource" in globalThis
}

// Which of the three an audio preview plays through, and from where. A synthesizer's audio has the decoded stream
// alone: where it breaks, Retry opens it again ("failed"); without a service worker it cannot stream.
type AudioStage =
	| { kind: "stream" }
	| { kind: "decoded"; resume: AudioResume }
	| { kind: "mediaSource"; resume: AudioResume }
	| { kind: "failed"; resume: AudioResume }
	| { kind: "cannotStream" }

// With a service worker: what the browser plays natively (AIFF, CAF, ALAC in Safari) plays as it is through
// its route, anything else (or anything that turns out not to play) as a decoded WAV stream through the same
// route. A broken or missing route moves to MediaSource where there is one, else says the browser cannot
// stream it.
function PreviewAudio({ item, alt }: { item: DriveItem; alt: string }) {
	const contentType = allowedMediaContentType(item)
	const uuid = item.data.uuid
	const synth = audioSynthKind(itemTypeExtension(item))
	const [stage, setStage] = useState<AudioStage>(() => {
		if (!isMediaStreamAvailable()) {
			return synth === undefined ? { kind: "mediaSource", resume: FROM_START } : { kind: "cannotStream" }
		}

		return audioRoute({ extension: itemTypeExtension(item), contentType, demoted: audioDemotions.has(uuid) }) === "direct"
			? { kind: "stream" }
			: { kind: "decoded", resume: FROM_START }
	})
	const toMediaSource = (resume: AudioResume): void => {
		setStage(previous =>
			previous.kind === "mediaSource" || previous.kind === "failed"
				? previous
				: synth === undefined
					? { kind: "mediaSource", resume }
					: { kind: "failed", resume }
		)
	}

	if (stage.kind === "stream" && contentType !== null) {
		return (
			<StreamedAudio
				item={item}
				alt={alt}
				contentType={contentType}
				onStreamFailed={toMediaSource}
				onFormatFailed={resume => {
					audioDemotions.add(uuid)
					setStage({ kind: "decoded", resume })
				}}
			/>
		)
	}

	if (stage.kind === "decoded") {
		return (
			<DecodedAudio
				item={item}
				alt={alt}
				resume={stage.resume}
				synth={synth}
				onStreamFailed={toMediaSource}
			/>
		)
	}

	if (stage.kind === "failed") {
		const { resume } = stage

		return (
			<MediaPlaybackFailure
				onRetry={() => {
					setStage({ kind: "decoded", resume })
				}}
			/>
		)
	}

	if (stage.kind === "cannotStream" || !hasMediaSource()) {
		return <MediaCannotStream item={item} />
	}

	return (
		<MediaSourceAudio
			item={item}
			alt={alt}
			resume={stage.kind === "mediaSource" ? stage.resume : FROM_START}
		/>
	)
}

// A synthesizer's audio from a provided origin: decoded through the service worker's route, from the origin's range
// port (an archive's entry, read by range or from its one checked read). Retry opens it again.
function ProvidedSynthAudio({ item, alt, origin, synth }: { item: DriveItem; alt: string; origin: ByteOrigin; synth: AudioSynthKind }) {
	const [failed, setFailed] = useState<AudioResume | null>(null)
	const [attempt, setAttempt] = useState(0)

	if (!isMediaStreamAvailable()) {
		return <MediaCannotStream item={item} />
	}

	if (failed !== null) {
		return (
			<MediaPlaybackFailure
				onRetry={() => {
					setFailed(null)
					setAttempt(attempt + 1)
				}}
			/>
		)
	}

	return (
		<DecodedAudio
			key={attempt}
			item={item}
			alt={alt}
			resume={FROM_START}
			synth={synth}
			origin={origin}
			onStreamFailed={setFailed}
		/>
	)
}

// Video and audio always stream, never as a whole-file buffer: through the service worker's range route
// where it can serve the file, else through MediaSource fed by the remux worker.
export function MediaViewer({ item, category, alt }: MediaViewerProps) {
	const downloadable = usePreviewDownloadable()
	// Only an archive's entry (or an attachment) carries a provided origin: played natively from its range port or its
	// buffer, a synthesizer's (a tracker module) decoded from it.
	const provided = useProvidedPreviewOrigin()
	const synth = category === "audio" ? audioSynthKind(itemTypeExtension(item)) : undefined

	if (provided !== null && synth !== undefined) {
		return (
			<ProvidedSynthAudio
				item={item}
				alt={alt}
				origin={provided}
				synth={synth}
			/>
		)
	}

	if (provided !== null) {
		return (
			<EntryMedia
				item={item}
				category={category}
				alt={alt}
				origin={provided}
			/>
		)
	}

	if (category === "video") {
		return (
			<VideoPlayer
				key={item.data.uuid}
				item={item}
				alt={alt}
				downloadable={downloadable}
				positionKey={item.data.uuid}
			/>
		)
	}

	return (
		<PreviewAudio
			key={item.data.uuid}
			item={item}
			alt={alt}
		/>
	)
}
