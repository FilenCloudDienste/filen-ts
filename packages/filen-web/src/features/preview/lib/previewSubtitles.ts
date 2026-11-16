import { MAX_SUBTITLE_CHARS, parseSubtitle, type CueStore } from "@filen/shared/videos"
import { decodeSubtitleBytes } from "@filen/shared/textEncoding"
import { asDirectoryOrFile, type DriveItem } from "@/features/drive/lib/item"
import { narrowToAnyFile } from "@/features/drive/lib/download"
import { DRIVE_LISTING_KEY_PREFIX } from "@/features/drive/queries/drive"
import { cachedQueriesWithPrefix } from "@/queries/patch"
import { sdkApi } from "@/lib/sdk/client"
import { runOp } from "@/lib/actions/outcome"
import { sidecarSubtitles, type PreviewSidecarSubtitle, type SidecarCandidate } from "@/features/preview/lib/previewPlayback.logic"
import type { PreviewAccessMode } from "@/features/preview/lib/accessMode"

// A preview's sidecar subtitles: found by name among the files beside the video, as a listing already
// held has them (never a fetch), and read only once chosen.

// A directory's own listing: the drive's, or a shared directory's below the shared root. A flat listing
// (recents, favorites, trash, links) or the shared root holds files from anywhere.
function isDirectoryListing(params: unknown): boolean {
	if (typeof params !== "object" || params === null || !("variant" in params) || !("uuid" in params)) {
		return false
	}

	return params.variant === "drive" || ((params.variant === "sharedIn" || params.variant === "sharedOut") && params.uuid !== null)
}

// The files of the first cached directory listing holding `uuid`; empty when none does.
export function cachedSiblings(uuid: string): readonly DriveItem[] {
	for (const query of cachedQueriesWithPrefix(DRIVE_LISTING_KEY_PREFIX)) {
		// Every query under the listing prefix holds a listing's rows.
		const data = query.state.data as DriveItem[] | undefined

		if (data !== undefined && isDirectoryListing(query.queryKey[2]) && data.some(item => item.data.uuid === uuid)) {
			return data
		}
	}

	return []
}

export interface PreviewSubtitleFile extends PreviewSidecarSubtitle {
	item: DriveItem
}

// The sidecar subtitles of the video `name` among `siblings`.
export function previewSidecars(name: string, siblings: readonly DriveItem[]): PreviewSubtitleFile[] {
	const byUuid = new Map<string, DriveItem>()
	const candidates: SidecarCandidate[] = []

	for (const sibling of siblings) {
		const base = asDirectoryOrFile(sibling)

		if (base.type !== "file" || base.data.decryptedMeta === null) {
			continue
		}

		byUuid.set(base.data.uuid, sibling)
		candidates.push({ uuid: base.data.uuid, name: base.data.decryptedMeta.name, size: Number(base.data.size) })
	}

	return sidecarSubtitles(name, candidates, MAX_SUBTITLE_CHARS).flatMap(subtitle => {
		const item = byUuid.get(subtitle.uuid)

		return item === undefined ? [] : [{ ...subtitle, item }]
	})
}

export type SidecarLoad = { status: "ok"; cues: CueStore } | { status: "unreadable" }

// One read of the whole (small, size-checked) subtitle file, decoded with the language's legacy codepage
// as the fallback, and parsed. Cancelled through `signal`.
export async function loadSidecar(subtitle: PreviewSubtitleFile, access: PreviewAccessMode, signal: AbortSignal): Promise<SidecarLoad> {
	const file = narrowToAnyFile(subtitle.item)
	const token = crypto.randomUUID()
	const stop = (): void => {
		void sdkApi.cancelPreviewDownload(token)
	}

	signal.addEventListener("abort", stop, { once: true })

	try {
		const bytes = await runOp(
			access === "anon" ? sdkApi.downloadLinkedFileBytesAnon(file, token) : sdkApi.downloadFileBytes(file, token)
		)
		const text = decodeSubtitleBytes(bytes, { languageHint: subtitle.lang })
		const cues = text === null ? null : parseSubtitle(text.text, subtitle.format)

		return cues === null || cues.texts.length === 0 ? { status: "unreadable" } : { status: "ok", cues }
	} finally {
		signal.removeEventListener("abort", stop)
	}
}
