import { useEffect, useState } from "react"
import { driveItemName } from "@filen/shared"
import type { CueStore } from "@filen/shared/videos"
import type { DriveItem } from "@/features/drive/lib/item"
import { embeddedSubtitleSupport } from "@/lib/media/playback/embeddedCues"
import { usePreviewAccessMode, usePreviewSiblings } from "@/features/preview/lib/accessMode"
import { cachedSiblings, loadSidecar, previewSidecars, type PreviewSubtitleFile } from "@/features/preview/lib/previewSubtitles"
import type { PreviewVideo, PreviewVideoSnapshot } from "@/features/preview/lib/previewVideo"

// The subtitles a preview offers: text files beside the video (from a listing already held) and the text
// tracks inside a Matroska or MP4 file, which the remux reads as it plays. Nothing is read until one is chosen.

export interface PreviewSubtitleOption {
	// "s:<uuid>" for a file beside the video, "e:<track>" for a track inside it.
	id: string
	lang: string | null
	title: string
	forced: boolean
	sdh: boolean
	embedded: boolean
	// A track inside the file this browser can't show with it (no remux plays the file whole): offered, not choosable.
	unplayable: boolean
}

export interface PreviewSubtitles {
	options: PreviewSubtitleOption[]
	// "off" or an option's id.
	selected: string
	select: (id: string) => void
	cues: CueStore | null
	// The chosen file could not be read or parsed.
	failed: boolean
}

// A chosen file's outcome, kept for the preview's life: switching back costs no second read. `fps`: the rate a
// frame-based file was timed at (null for MicroDVD's usual rate and for every other format).
type SidecarState = { status: "ok"; cues: CueStore; fps: number | null } | { status: "failed" }

function sidecarOption(file: PreviewSubtitleFile): PreviewSubtitleOption {
	return {
		id: `s:${file.uuid}`,
		lang: file.lang,
		title: file.title,
		forced: file.forced,
		sdh: file.sdh,
		embedded: false,
		unplayable: false
	}
}

export function usePreviewSubtitles(
	item: DriveItem,
	controller: PreviewVideo | null,
	snapshot: PreviewVideoSnapshot | null
): PreviewSubtitles {
	const access = usePreviewAccessMode()
	const provided = usePreviewSiblings()
	const [selected, setSelected] = useState("off")
	const [loaded, setLoaded] = useState<ReadonlyMap<string, SidecarState>>(() => new Map())
	// Looked up once per file: the listing held when the preview opened is the one beside it. A listing the host provides
	// later (a public link's subdirectory, listed as its video shows) brings its files then, the video never waiting.
	const [sidecarsFrom, setSidecarsFrom] = useState(provided)
	const [sidecars, setSidecars] = useState(() =>
		previewSidecars(driveItemName(item), provided ?? (access === "authed" ? cachedSiblings(item.data.uuid) : []))
	)

	if (provided !== sidecarsFrom && provided !== null) {
		setSidecarsFrom(provided)
		setSidecars(previewSidecars(driveItemName(item), provided))
	}

	const probe = snapshot?.probe ?? null
	const blocked = snapshot?.embeddedTextBlocked === true
	const fps = probe?.video?.fps ?? null
	const embedded: PreviewSubtitleOption[] =
		probe === null
			? []
			: probe.subs
					.filter(sub => embeddedSubtitleSupport(probe, sub) === "text")
					.map(sub => ({
						id: `e:${String(sub.id)}`,
						lang: sub.lang,
						title: sub.name ?? "",
						forced: sub.forced,
						sdh: sub.hi,
						embedded: true,
						unplayable: blocked
					}))
	const options = [...sidecars.map(sidecarOption), ...embedded]
	// A chosen track inside the file that turned out unplayable shows as off; the choice comes back with another audio
	// track that a remux does play.
	const shown = blocked && selected.startsWith("e:") ? "off" : selected
	const selectedSidecar = selected.startsWith("s:") ? sidecars.find(file => `s:${file.uuid}` === selected) : undefined
	// Only a frame-based (MicroDVD) file is timed by the rate: it is read again when the probe states another one, while
	// a read of any other format is not restarted when the probe lands.
	const chosenFps = selectedSidecar?.format === "sub" ? fps : null
	const selectedState = loaded.get(selected)
	const chosenSidecar =
		selectedState === undefined || (selectedState.status === "ok" && selectedState.fps !== chosenFps) ? selectedSidecar : undefined

	useEffect(() => {
		if (chosenSidecar === undefined) {
			return
		}

		const abort = new AbortController()
		const id = `s:${chosenSidecar.uuid}`
		const settle = (state: SidecarState): void => {
			if (!abort.signal.aborted) {
				setLoaded(previous => new Map(previous).set(id, state))
			}
		}

		void loadSidecar(chosenSidecar, access, abort.signal, chosenFps).then(
			result => {
				settle(result.status === "ok" ? { status: "ok", cues: result.cues, fps: chosenFps } : { status: "failed" })
			},
			() => {
				settle({ status: "failed" })
			}
		)

		return () => {
			abort.abort()
		}
	}, [chosenSidecar, access, chosenFps])

	function select(id: string): void {
		// Choosing a failed file again reads it once more: the failure may have been a dropped connection.
		if (loaded.get(id)?.status === "failed") {
			setLoaded(previous => {
				const next = new Map(previous)

				next.delete(id)

				return next
			})
		}

		setSelected(id)
		controller?.setSubtitle(id === "off" ? "none" : id.startsWith("e:") ? "embedded-text" : "sidecar")
	}

	let cues: CueStore | null = null

	if (shown.startsWith("e:") && controller !== null && snapshot !== null) {
		cues = controller.embeddedCues(Number(selected.slice(2)), snapshot.embeddedVersion)
	} else if (selectedState?.status === "ok") {
		cues = selectedState.cues
	}

	return { options, selected: shown, select, cues, failed: selectedState?.status === "failed" }
}
