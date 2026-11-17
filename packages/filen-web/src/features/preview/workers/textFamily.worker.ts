/// <reference lib="webworker" />
import * as Comlink from "comlink"
import { readTorrent, torrentHashes, torrentMagnet, TorrentError, type TorrentHashes, type TorrentInfo } from "@filen/shared/torrent"
import { readCalendar, type CalendarFile } from "@filen/shared/calendarFile"
import { readContacts, type ContactFile } from "@filen/shared/contactFile"
import { cmsSigner } from "@filen/office/core/pdfsign"
import { readBinaryReading, type BinaryReading } from "@/features/preview/lib/binaryInfo/reading"
import { readEmail, type EmailReading } from "@/features/preview/lib/emailReading"
import { readSubtitleText, type SubtitleReading } from "@/features/preview/lib/subtitleCues.logic"

// The text family's parsers, off the page: each call takes a copy of a file the page holds, reads it and answers with
// plain data, keeping nothing (a stateless worker, textFamilyClient.ts).

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
	// The text the page already decoded (in the encoding it shows), parsed by its extension's format: cue times as
	// transferred arrays, cue text as plain text.
	// A message: a copy of its bytes, parsed and dropped; attachments come back as Blobs (no copy on the way).
	email: (bytes: Uint8Array<ArrayBuffer>): Promise<EmailReading> => readEmail(bytes),
	subtitles: (text: string, extension: string): SubtitleReading => {
		const reading = readSubtitleText(text, extension)

		return reading.status === "ok" ? Comlink.transfer(reading, [reading.starts.buffer, reading.ends.buffer]) : reading
	},
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
