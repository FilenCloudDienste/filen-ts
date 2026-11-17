import * as Comlink from "comlink"
import TextFamilyWorker from "@/features/preview/workers/textFamily.worker.ts?worker"
import type { TextFamilyWorkerApi, TorrentReading } from "@/features/preview/workers/textFamily.worker"
import { statelessWorker } from "@/lib/workers/ownedWorker"
import type { SubtitleReading } from "@/features/preview/lib/subtitleCues.logic"

export type { TorrentReading } from "@/features/preview/workers/textFamily.worker"

// The text family's parsers in one stateless worker: idle after 30 s with nothing to read, ended at sign-out. The page keeps its bytes (the preview cache's) and posts a copy.
const TEXT_FAMILY_IDLE_MS = 30_000

const textFamilyWorker = statelessWorker<TextFamilyWorkerApi>(() => new TextFamilyWorker(), TEXT_FAMILY_IDLE_MS, "text-family")

export async function readTorrentFile(bytes: Uint8Array): Promise<TorrentReading> {
	const copy = bytes.slice()

	return await textFamilyWorker.use<TorrentReading>(({ remote }) => remote.torrent(Comlink.transfer(copy, [copy.buffer])))
}

// A subtitle file's cues, from the text the page decoded; the worker transfers the times back.
export async function readSubtitleCues(text: string, extension: string): Promise<SubtitleReading> {
	return await textFamilyWorker.use<SubtitleReading>(({ remote }) => remote.subtitles(text, extension))
}
