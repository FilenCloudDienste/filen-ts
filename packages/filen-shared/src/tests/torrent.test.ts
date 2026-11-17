import { describe, expect, it } from "vitest"
import { readTorrent, torrentHashes, torrentMagnet, TorrentError, TORRENT_FILE_LIMIT } from "@filen/shared/torrent"

// Bencoding, as a torrent writes it: dictionary keys sorted, strings length-prefixed.
type B = number | bigint | string | Uint8Array | B[] | { [key: string]: B }

function bencode(value: B): Buffer {
	if (typeof value === "number" || typeof value === "bigint") {
		return Buffer.from(`i${String(value)}e`)
	}

	if (typeof value === "string" || value instanceof Uint8Array) {
		const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.from(value)

		return Buffer.concat([Buffer.from(`${String(bytes.length)}:`), bytes])
	}

	if (Array.isArray(value)) {
		return Buffer.concat([Buffer.from("l"), ...value.map(bencode), Buffer.from("e")])
	}

	const keys = Object.keys(value).sort()

	return Buffer.concat([Buffer.from("d"), ...keys.flatMap(key => [bencode(key), bencode(value[key] ?? "")]), Buffer.from("e")])
}

const digest = (algorithm: "SHA-1" | "SHA-256", data: Uint8Array<ArrayBuffer>): Promise<ArrayBuffer> => crypto.subtle.digest(algorithm, data)

async function sha1Hex(data: Uint8Array<ArrayBuffer>): Promise<string> {
	return [...new Uint8Array(await digest("SHA-1", data))].map(byte => byte.toString(16).padStart(2, "0")).join("")
}

const V1_INFO = {
	name: "Album",
	"piece length": 262144,
	pieces: new Uint8Array(40),
	private: 1,
	files: [
		{ length: 1000, path: ["CD 1", "01 Intro.flac"] },
		{ length: 24, path: [".pad", "24"], attr: "p" },
		{ length: 2000, path: ["cover.jpg"] }
	]
}

describe("readTorrent", () => {
	it("reads a v1 torrent's files, trackers and facts, and hashes its own info bytes", async () => {
		const bytes = bencode({
			announce: "udp://tracker.example:1337/announce",
			"announce-list": [["udp://tracker.example:1337/announce", "https://t2.example/a"], ["https://t3.example/a"]],
			comment: "Live",
			"created by": "qBittorrent v4.6",
			"creation date": 1_700_000_000,
			info: V1_INFO,
			"url-list": "https://seed.example/album/"
		})
		const info = readTorrent(bytes)

		expect(info).toMatchObject({
			name: "Album",
			version: 1,
			private: true,
			pieceLength: 262144n,
			pieceCount: 2,
			files: [
				{ path: "Album/CD 1/01 Intro.flac", size: 1000n },
				{ path: "Album/cover.jpg", size: 2000n }
			],
			totalSize: 3000n,
			trackers: ["udp://tracker.example:1337/announce", "https://t2.example/a", "https://t3.example/a"],
			webSeeds: ["https://seed.example/album/"],
			comment: "Live",
			createdBy: "qBittorrent v4.6",
			creationDate: 1_700_000_000
		})

		const hashes = await torrentHashes(new Uint8Array(bytes), info, digest)

		expect(hashes).toEqual({ v1: await sha1Hex(new Uint8Array(bencode(V1_INFO))), v2: null })
		expect(torrentMagnet(info, hashes)).toBe(
			`magnet:?xt=urn:btih:${hashes.v1 ?? ""}&dn=Album&tr=${encodeURIComponent("udp://tracker.example:1337/announce")}&tr=${encodeURIComponent("https://t2.example/a")}&tr=${encodeURIComponent("https://t3.example/a")}`
		)
	})

	it("reads a single-file torrent and a UTF-8 name", () => {
		const info = readTorrent(bencode({ info: { name: "x", "name.utf-8": "Grüße.txt", length: 5, "piece length": 16384, pieces: new Uint8Array(20) } }))

		expect(info).toMatchObject({ name: "Grüße.txt", files: [{ path: "Grüße.txt", size: 5n }], private: false, trackers: [] })
	})

	it("reads a v2 file tree, and a hybrid's both hashes", async () => {
		const tree = { "file tree": { docs: { "a.txt": { "": { length: 3, "pieces root": new Uint8Array(32) } } }, "b.bin": { "": { length: 7 } } } }
		const v2 = readTorrent(bencode({ info: { name: "Set", "meta version": 2, "piece length": 16384, ...tree } }))
		const hybridBytes = bencode({ info: { name: "Set", "meta version": 2, "piece length": 16384, pieces: new Uint8Array(20), length: 10, ...tree } })
		const hybrid = readTorrent(hybridBytes)

		expect(v2).toMatchObject({ version: 2, pieceCount: null, totalSize: 10n })
		expect(v2.files.map(file => file.path).sort()).toEqual(["Set/b.bin", "Set/docs/a.txt"])
		expect(hybrid.version).toBe("hybrid")

		const hashes = await torrentHashes(new Uint8Array(hybridBytes), hybrid, digest)

		expect(hashes.v1).toHaveLength(40)
		expect(hashes.v2).toHaveLength(64)
		expect(torrentMagnet(hybrid, hashes)).toContain(`xt=urn:btmh:1220${hashes.v2 ?? ""}`)
	})

	it("returns the first files of a huge torrent and counts the rest", () => {
		const files = Array.from({ length: TORRENT_FILE_LIMIT + 3 }, () => ({ length: 1, path: ["f"] }))
		const info = readTorrent(bencode({ info: { name: "Many", "piece length": 16384, pieces: new Uint8Array(20), files } }))

		expect(info.files).toHaveLength(TORRENT_FILE_LIMIT)
		expect(info.filesOmitted).toBe(3)
		expect(info.totalSize).toBe(BigInt(TORRENT_FILE_LIMIT + 3))
	})

	it.each([
		["truncated bytes", Buffer.from("d4:infod4:name")],
		["trailing bytes", Buffer.concat([bencode({ info: { name: "x", length: 1, pieces: new Uint8Array(20) } }), Buffer.from("x")])],
		["a string past the end", Buffer.from("d4:info999:x")],
		["a malformed number", Buffer.from("d4:infoi01ee")],
		["nesting past the limit", Buffer.from(`${"l".repeat(100)}${"e".repeat(100)}`)],
		["no info dictionary", bencode({ announce: "x" })],
		["pieces of a wrong length", bencode({ info: { name: "x", length: 1, pieces: new Uint8Array(21) } })],
		["neither v1 nor v2", bencode({ info: { name: "x", length: 1 } })],
		["a negative size", bencode({ info: { name: "x", length: -1, pieces: new Uint8Array(20) } })]
	])("refuses %s", (_, bytes) => {
		expect(() => readTorrent(bytes)).toThrow(TorrentError)
	})
})
