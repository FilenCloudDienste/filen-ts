import { describe, expect, it } from "vitest"
import { readTorrent, torrentHashes, torrentMagnet, TORRENT_FILE_LIMIT } from "@filen/shared/torrent"

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

const digest = (algorithm: "SHA-1" | "SHA-256", data: Uint8Array<ArrayBuffer>): Promise<ArrayBuffer> =>
	crypto.subtle.digest(algorithm, data)

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
		const info = readTorrent(
			bencode({ info: { name: "x", "name.utf-8": "Grüße.txt", length: 5, "piece length": 16384, pieces: new Uint8Array(20) } })
		)

		expect(info).toMatchObject({ name: "Grüße.txt", files: [{ path: "Grüße.txt", size: 5n }], private: false, trackers: [] })
	})

	it("reads a v2 file tree, and a hybrid's both hashes", async () => {
		const tree = {
			"file tree": { docs: { "a.txt": { "": { length: 3, "pieces root": new Uint8Array(32) } } }, "b.bin": { "": { length: 7 } } }
		}
		const v2 = readTorrent(bencode({ info: { name: "Set", "meta version": 2, "piece length": 16384, ...tree } }))
		const hybridBytes = bencode({
			info: { name: "Set", "meta version": 2, "piece length": 16384, pieces: new Uint8Array(20), length: 10, ...tree }
		})
		const hybrid = readTorrent(hybridBytes)

		expect(v2).toMatchObject({ version: 2, pieceCount: null, totalSize: 10n })
		// The file tree's own order, depth first.
		expect(v2.files.map(file => file.path)).toEqual(["Set/b.bin", "Set/docs/a.txt"])
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
		["no info dictionary", bencode({ announce: "x" })],
		["pieces of a wrong length", bencode({ info: { name: "x", length: 1, pieces: new Uint8Array(21) } })],
		["neither v1 nor v2", bencode({ info: { name: "x", length: 1 } })],
		["a negative size", bencode({ info: { name: "x", length: -1, pieces: new Uint8Array(20) } })],
		["a duplicate key", Buffer.from("d4:infod6:lengthi1e6:lengthi2e4:name1:x6:pieces20:aaaaaaaaaaaaaaaaaaaaee")]
	])("refuses %s as malformed", (_, bytes) => {
		expect(() => readTorrent(bytes)).toThrow(expect.objectContaining({ kind: "malformed" }))
	})

	it("refuses nesting and value counts past its caps as too large", () => {
		expect(() => readTorrent(Buffer.from(`${"l".repeat(100)}${"e".repeat(100)}`))).toThrow(
			expect.objectContaining({ kind: "tooLarge" })
		)
		expect(() => readTorrent(Buffer.from(`l${"de".repeat(1_000_001)}e`))).toThrow(expect.objectContaining({ kind: "tooLarge" }))
	})

	// 999,999 empty dictionaries: the most values a file may hold, each one an allocation.
	it("keeps the heap small for a file full of values", () => {
		const bomb = Buffer.from(`l${"de".repeat(999_998)}e`)
		const before = process.memoryUsage().heapUsed
		let peak = before

		try {
			readTorrent(bomb)
		} catch (e) {
			peak = Math.max(peak, process.memoryUsage().heapUsed)
			expect(e).toMatchObject({ kind: "malformed" })
		}

		expect(peak - before).toBeLessThan(200 * 1024 * 1024)
	})

	// A long name repeated into every path, or a path per file, cannot grow past the caps.
	it("caps names, paths and the characters of all paths together", () => {
		const name = "n".repeat(2 * 1024 * 1024)
		const files = Array.from({ length: 50_000 }, () => ({ length: 1, path: ["p".repeat(5000)] }))
		const started = Date.now()
		const info = readTorrent(
			bencode({ comment: "c".repeat(100_000), info: { name, "piece length": 16384, pieces: new Uint8Array(20), files } })
		)

		expect(Date.now() - started).toBeLessThan(10_000)
		expect(info.name.length).toBe(1024)
		expect(info.comment?.length).toBe(4096)
		expect(info.files.every(file => file.path.length <= 4096)).toBe(true)
		expect(info.files.reduce((sum, file) => sum + file.path.length, 0)).toBeLessThanOrEqual(16 * 1024 * 1024)
		expect(info.files.length + info.filesOmitted).toBe(50_000)
		expect(info.filesOmitted).toBeGreaterThan(0)
		expect(info.totalSize).toBe(50_000n)
	})

	// Deep directories of long names over many files: each directory's path is cut once, and files past the budget are
	// counted without a path being built.
	it("bounds a v2 tree whose every file sits under a long, deep path", () => {
		const leaves: Record<string, B> = {}

		for (let index = 0; index < 200_000; index++) leaves[`f${String(index).padStart(6, "0")}`] = { "": { length: 1 } }

		let tree: B = leaves

		for (let depth = 0; depth < 58; depth++) tree = { [`${String(depth)}${"d".repeat(8000)}`]: tree }

		const bytes = bencode({ info: { name: "Deep", "meta version": 2, "piece length": 16384, "file tree": tree } })
		const before = process.memoryUsage().heapUsed
		const started = Date.now()
		const info = readTorrent(bytes)

		expect(Date.now() - started).toBeLessThan(5000)
		expect(process.memoryUsage().heapUsed - before).toBeLessThan(256 * 1024 * 1024)
		expect(info.files.length + info.filesOmitted).toBe(200_000)
		expect(info.files.every(file => file.path.length === 4096 && file.path.endsWith("…"))).toBe(true)
		expect(info.files.length).toBe(4096)
		expect(info.totalSize).toBe(200_000n)
	})

	// 300k one-byte names: the tree is read into a flat table, not a dictionary per entry.
	it("reads a wide v2 file tree without a dictionary per entry", () => {
		const parts: Buffer[] = [Buffer.from("d4:infod9:file treed")]
		const names: string[] = []

		for (let index = 0; index < 300_000; index++) names.push(index.toString(36).padStart(4, "0"))

		for (const leaf of names.sort()) parts.push(Buffer.from(`${String(leaf.length)}:${leaf}d0:d6:lengthi1eee`))

		parts.push(Buffer.from("e12:meta versioni2e4:name4:Wide12:piece lengthi16384eee"))

		const bytes = Buffer.concat(parts)
		const before = process.memoryUsage().heapUsed
		const started = Date.now()
		const info = readTorrent(bytes)

		expect(Date.now() - started).toBeLessThan(5000)
		expect(process.memoryUsage().heapUsed - before).toBeLessThan(160 * 1024 * 1024)
		expect(info.files.length + info.filesOmitted).toBe(300_000)
		expect(info.files[0]?.path).toBe("Wide/0000")
		expect(info.totalSize).toBe(300_000n)
	})

	it("refuses a dictionary key past a few KiB as too large", () => {
		expect(() => readTorrent(bencode({ ["k".repeat(8193)]: 0, info: { name: "x", length: 1 } }))).toThrow(
			expect.objectContaining({ kind: "tooLarge" })
		)
		expect(
			readTorrent(
				bencode({ ["k".repeat(8192)]: 0, info: { name: "x", length: 1, "piece length": 16384, pieces: new Uint8Array(20) } })
			).name
		).toBe("x")
	})

	it("removes format and bidi controls from names, paths, comments and addresses", () => {
		const info = readTorrent(
			bencode({
				announce: "https://t.example/\u202eannounce",
				comment: "a\u202bb",
				info: { name: "invoice\u202efdp.exe", length: 1, "piece length": 16384, pieces: new Uint8Array(20) }
			})
		)

		expect(info).toMatchObject({ name: "invoicefdp.exe", comment: "ab", trackers: ["https://t.example/announce"] })
		expect(info.files[0]?.path).toBe("invoicefdp.exe")
	})

	it("lists at most 500 web seeds and trackers", () => {
		const seeds = Array.from({ length: 2000 }, (_, index) => `https://seed${String(index)}.example/`)
		const info = readTorrent(
			bencode({
				"announce-list": [seeds],
				"url-list": seeds,
				info: { name: "x", length: 1, "piece length": 16384, pieces: new Uint8Array(20) }
			})
		)

		expect(info.webSeeds).toHaveLength(500)
		expect(info.trackers).toHaveLength(500)
	})

	// Keys out of order are read as written, and the infohash is over the file's own bytes, not a re-encoding.
	it("hashes the info dictionary's bytes as the file holds them", async () => {
		const info = Buffer.concat([
			Buffer.from("d"),
			bencode("pieces"),
			bencode(new Uint8Array(20)),
			bencode("name"),
			bencode("x"),
			bencode("length"),
			bencode(1),
			bencode("piece length"),
			bencode(16384),
			Buffer.from("e")
		])
		const bytes = new Uint8Array(Buffer.concat([Buffer.from("d4:info"), info, Buffer.from("e")]))
		const read = readTorrent(bytes)
		const hashes = await torrentHashes(bytes, read, digest)

		expect(hashes.v1).toBe(await sha1Hex(new Uint8Array(info)))
		expect(hashes.v1).not.toBe(
			await sha1Hex(new Uint8Array(bencode({ pieces: new Uint8Array(20), name: "x", length: 1, "piece length": 16384 })))
		)
	})
})
