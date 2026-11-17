/// <reference lib="webworker" />
import * as Comlink from "comlink"
import { readTorrent, torrentHashes, torrentMagnet, TorrentError, type TorrentHashes, type TorrentInfo } from "@filen/shared/torrent"

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
	}
}

export type TextFamilyWorkerApi = typeof api

Comlink.expose(api)
