import * as Comlink from "comlink"
import TextFamilyWorker from "@/features/preview/workers/textFamily.worker.ts?worker"
import type { TextFamilyWorkerApi, TorrentReading } from "@/features/preview/workers/textFamily.worker"
import { statelessWorker, type WorkerHandle } from "@/lib/workers/ownedWorker"
import { workerJob } from "@/features/preview/lib/workerJob"
import type { SubtitleReading } from "@/features/preview/lib/subtitleCues.logic"
import type { CalendarFile } from "@filen/shared/calendarFile"
import type { ContactFile } from "@filen/shared/contactFile"
import type { BinaryReading } from "@/features/preview/lib/binaryInfo/reading"
import type { BinarySource } from "@/features/preview/lib/binaryInfo/types"

export type { TorrentReading } from "@/features/preview/workers/textFamily.worker"

// The text family's parsers in one stateless worker: idle after 30 s with nothing to read, ended at sign-out. The page keeps its bytes (the preview cache's) and posts a copy.
const TEXT_FAMILY_IDLE_MS = 30_000

// Every capped parse ends well within this; one that does not is stopped rather than left to hold the others back.
const TEXT_FAMILY_JOB_BUDGET_MS = 20_000

const textFamilyWorker = statelessWorker<TextFamilyWorkerApi>(() => new TextFamilyWorker(), TEXT_FAMILY_IDLE_MS, "text-family")

function job<R>(run: (remote: WorkerHandle<TextFamilyWorkerApi>["remote"]) => Promise<R>): Promise<R> {
	return workerJob(textFamilyWorker, "text-family", TEXT_FAMILY_JOB_BUDGET_MS, handle => run(handle.remote))
}

export async function readTorrentFile(bytes: Uint8Array): Promise<TorrentReading> {
	return await job<TorrentReading>(async remote => {
		// A copy per attempt: a transferred one is gone.
		const copy = bytes.slice()

		return await remote.torrent(Comlink.transfer(copy, [copy.buffer]))
	})
}

// A subtitle file's cues, from the text the page decoded; the worker transfers the times back.
export async function readSubtitleCues(text: string, extension: string): Promise<SubtitleReading> {
	return await job<SubtitleReading>(async remote => await remote.subtitles(text, extension))
}

// A calendar file's events and to-dos, from the text the page decoded.
export async function readCalendarFile(text: string): Promise<CalendarFile> {
	return await job<CalendarFile>(async remote => await remote.calendar(text))
}

// A contact file's cards, from the text the page decoded.
export async function readContactFile(text: string): Promise<ContactFile> {
	return await job<ContactFile>(async remote => await remote.contacts(text))
}

// An executable's or disk image's headers, parsed in the worker; it asks the page for each range it reads, which
// `source` answers (a copy is sent, never a view of the reader's memo).
export async function readBinaryHeaders(source: BinarySource, name: string, signal: AbortSignal): Promise<BinaryReading> {
	const read = Comlink.proxy(async (offset: number, length: number): Promise<Uint8Array> => {
		const copy = (await source.read(offset, length, signal)).slice()

		return Comlink.transfer(copy, [copy.buffer])
	})

	return await job<BinaryReading>(async remote => await remote.binary(read, source.size, name))
}
