import * as Comlink from "comlink"
import TextFamilyWorker from "@/features/preview/workers/textFamily.worker.ts?worker"
import type { TextFamilyWorkerApi, TorrentReading } from "@/features/preview/workers/textFamily.worker"
import { statelessWorker } from "@/lib/workers/ownedWorker"
import type { SubtitleReading } from "@/features/preview/lib/subtitleCues.logic"
import type { CalendarFile } from "@filen/shared/calendarFile"
import type { ContactFile } from "@filen/shared/contactFile"
import type { BinaryReading } from "@/features/preview/lib/binaryInfo/reading"
import type { BinarySource } from "@/features/preview/lib/binaryInfo/types"

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

// A calendar file's events and to-dos, from the text the page decoded.
export async function readCalendarFile(text: string): Promise<CalendarFile> {
	return await textFamilyWorker.use<CalendarFile>(({ remote }) => remote.calendar(text))
}

// A contact file's cards, from the text the page decoded.
export async function readContactFile(text: string): Promise<ContactFile> {
	return await textFamilyWorker.use<ContactFile>(({ remote }) => remote.contacts(text))
}

// An executable's or disk image's headers, parsed in the worker; it asks the page for each range it reads, which
// `source` answers (a copy is sent, never a view of the reader's memo).
export async function readBinaryHeaders(source: BinarySource, name: string, signal: AbortSignal): Promise<BinaryReading> {
	const read = Comlink.proxy(async (offset: number, length: number): Promise<Uint8Array> => {
		const copy = (await source.read(offset, length, signal)).slice()

		return Comlink.transfer(copy, [copy.buffer])
	})

	return await textFamilyWorker.use<BinaryReading>(({ remote }) => remote.binary(read, source.size, name))
}
