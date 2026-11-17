import * as Comlink from "comlink"
import TextFamilyWorker from "@/features/preview/workers/textFamily.worker.ts?worker"
import type { EmailTextReading, TextFamilyWorkerApi, TorrentReading } from "@/features/preview/workers/textFamily.worker"
import { statelessWorker, type WorkerHandle } from "@/lib/workers/ownedWorker"
import { WorkerJobTimeoutError, workerJob, type JobClock } from "@/features/preview/lib/workerJob"
import type { SubtitleReading } from "@/features/preview/lib/subtitleCues.logic"
import type { EmailReading } from "@/features/preview/lib/emailReading"
import type { CalendarFile } from "@filen/shared/calendarFile"
import type { ContactFile } from "@filen/shared/contactFile"
import type { BinaryReading } from "@/features/preview/lib/binaryInfo/reading"
import type { BinarySource } from "@/features/preview/lib/binaryInfo/types"

export type { EmailTextReading, TorrentReading } from "@/features/preview/workers/textFamily.worker"

// The text family's parsers in one stateless worker: idle after 30 s with nothing to read, ended at sign-out. The page keeps its bytes (the preview cache's) and posts a copy.
const TEXT_FAMILY_IDLE_MS = 30_000

// Every capped parse ends well within this; one that does not is stopped rather than left to hold the others back.
const TEXT_FAMILY_JOB_BUDGET_MS = 20_000

const textFamilyWorker = statelessWorker<TextFamilyWorkerApi>(() => new TextFamilyWorker(), TEXT_FAMILY_IDLE_MS, "text-family")

function job<R>(run: (remote: WorkerHandle<TextFamilyWorkerApi>["remote"], clock: JobClock) => Promise<R>): Promise<R> {
	return workerJob(textFamilyWorker, "text-family", TEXT_FAMILY_JOB_BUDGET_MS, (handle, clock) => run(handle.remote, clock))
}

export async function readTorrentFile(bytes: Uint8Array): Promise<TorrentReading> {
	return await job<TorrentReading>(async remote => {
		// A copy per attempt: a transferred one is gone.
		const copy = bytes.slice()

		return await remote.torrent(Comlink.transfer(copy, [copy.buffer]))
	})
}

// A message's headers, bodies and attachments (Blobs), from a copy of its bytes.
export async function readEmailFile(bytes: Uint8Array): Promise<EmailReading> {
	return await emailJob<EmailReading>(async remote => {
		// A copy per attempt: a transferred one is gone.
		const copy = bytes.slice()

		return await remote.email(Comlink.transfer(copy, [copy.buffer]))
	})
}

// A message as plain text for the assistant: headers, body and attachment names, at most `limit` characters and one
// more; only that string comes back.
export async function readEmailText(bytes: Uint8Array, limit: number): Promise<EmailTextReading> {
	return await emailJob<EmailTextReading>(async remote => {
		const copy = bytes.slice()

		return await remote.emailText(Comlink.transfer(copy, [copy.buffer]), limit)
	})
}

// A message's parse past the job's budget is a message too large to read here (a slow device on a hostile one), not a
// failure.
async function emailJob<R>(run: (remote: WorkerHandle<TextFamilyWorkerApi>["remote"]) => Promise<R>): Promise<R | { status: "tooLarge" }> {
	try {
		return await job<R>(run)
	} catch (e) {
		if (e instanceof WorkerJobTimeoutError) {
			return { status: "tooLarge" }
		}

		throw e
	}
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
// The page's end of each channel is its own, closed once the job settles: a worker ended mid-job never releases it.
export async function readBinaryHeaders(source: BinarySource, name: string, signal: AbortSignal): Promise<BinaryReading> {
	const channels: MessageChannel[] = []

	try {
		return await job<BinaryReading>(async (remote, clock) => {
			const channel = new MessageChannel()

			channels.push(channel)
			// A download is the page's time, not the parse's: the job's budget waits for it.
			Comlink.expose(async (offset: number, length: number): Promise<Uint8Array> => {
				clock.pause()

				try {
					const copy = (await source.read(offset, length, signal)).slice()

					return Comlink.transfer(copy, [copy.buffer])
				} finally {
					clock.resume()
				}
			}, channel.port1)

			return await remote.binary(Comlink.transfer(channel.port2, [channel.port2]), source.size, name)
		})
	} finally {
		for (const channel of channels) channel.port1.close()
	}
}
