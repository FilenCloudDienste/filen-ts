/// <reference lib="webworker" />
import * as Comlink from "comlink"
import { readTorrent, torrentHashes, torrentMagnet, TorrentError, type TorrentHashes, type TorrentInfo } from "@filen/shared/torrent"
import { readCalendar, type CalendarFile } from "@filen/shared/calendarFile"
import { readContacts, type ContactFile } from "@filen/shared/contactFile"
import { cmsSigner } from "@filen/office/core/pdfsign"
import { readBinaryReading, type BinaryReading } from "@/features/preview/lib/binaryInfo/reading"
import { readEmail, readEmailNames, type EmailReading } from "@/features/preview/lib/emailReading"
import { emailText } from "@/features/preview/lib/emailText"
import { mailboxText } from "@/features/preview/lib/mailboxText"
import { readSubtitleText, type SubtitleReading } from "@/features/preview/lib/subtitleCues.logic"
import { readNotebook, type NotebookReading } from "@/features/preview/lib/notebookReading"

// The text family's parsers, off the page: each call takes a copy of a file the page holds, reads it and answers with
// plain data, keeping nothing (a stateless worker, textFamilyClient.ts).

export type EmailTextReading = { readonly status: "ok"; readonly text: string } | { readonly status: "tooLarge" }

export type TorrentReading =
	| { readonly status: "ok"; readonly info: TorrentInfo; readonly hashes: TorrentHashes; readonly magnet: string }
	| { readonly status: "malformed" | "tooLarge" }

const api = {
	torrent: async (bytes: Uint8Array<ArrayBuffer>): Promise<TorrentReading> => {
		let info: TorrentInfo

		try {
			info = readTorrent(bytes)
		} catch (e) {
			if (e instanceof TorrentError) {
				return { status: e.kind }
			}

			throw e
		}

		const hashes = await torrentHashes(bytes, info, (algorithm, data) => crypto.subtle.digest(algorithm, data))

		return { status: "ok", info, hashes, magnet: torrentMagnet(info, hashes) }
	},
	// A message: a copy of its bytes, parsed and dropped; attachments come back as Blobs (no copy on the way).
	email: (bytes: Uint8Array<ArrayBuffer>): Promise<EmailReading> => readEmail(bytes),
	// The start of a mailbox (`complete`: the whole file) as plain text: its first messages listed, the first one's
	// extract; at most `limit` characters and one more.
	mailboxText: async (prefix: Uint8Array<ArrayBuffer>, complete: boolean, limit: number): Promise<string> =>
		await mailboxText(prefix, complete, limit),
	// A message as plain text (headers, body, attachment names), at most `limit` characters and one more.
	emailText: async (bytes: Uint8Array<ArrayBuffer>, limit: number): Promise<EmailTextReading> => {
		const reading = await readEmailNames(bytes)

		return reading.status === "ok" ? { status: "ok", text: emailText(reading, limit) } : reading
	},
	// The text the page already decoded (in the encoding it shows), parsed by its extension's format: cue times as
	// transferred arrays, cue text as plain text.
	subtitles: (text: string, extension: string): SubtitleReading => {
		const reading = readSubtitleText(text, extension)

		return reading.status === "ok" ? Comlink.transfer(reading, [reading.starts.buffer, reading.ends.buffer]) : reading
	},
	// The text the page decoded, read as a Jupyter notebook; its images Blobs within `maxPixels` each.
	notebook: (text: string, maxPixels: number): NotebookReading => readNotebook(text, maxPixels),
	// The text the page decoded, read as iCalendar: its events and to-dos.
	calendar: (text: string): CalendarFile => readCalendar(text),
	// The text the page decoded, read as vCards.
	contacts: (text: string): ContactFile => readContacts(text),
	// An executable's or disk image's headers, read through the page's byte reader over `port` (the page answers each
	// range with a copy), and the signer its signature names (parsed with pkijs, which stays off the page; never verified).
	binary: async (port: MessagePort, size: number, name: string): Promise<BinaryReading> => {
		const read = Comlink.wrap<(offset: number, length: number) => Promise<Uint8Array>>(port)

		try {
			return await readBinaryReading({ size, read: (offset, length) => read(offset, length) }, name, cmsSigner)
		} finally {
			read[Comlink.releaseProxy]()
			port.close()
		}
	}
}

export type TextFamilyWorkerApi = typeof api

Comlink.expose(api)
