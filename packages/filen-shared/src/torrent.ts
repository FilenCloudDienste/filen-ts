// A .torrent file's metadata (BEP 3, 12, 19, 27, 52), read from its bencoding. Every bound is checked: the caller
// hands untrusted bytes. The `info` dictionary's exact span is kept, so its infohashes can be taken over the bytes the
// file holds. Nothing here contacts a tracker or a peer: their addresses are text.

export interface TorrentFile {
	// Path parts joined with "/".
	readonly path: string
	readonly size: bigint
}

export interface TorrentInfo {
	readonly name: string
	// 1, 2 or both ("hybrid", BEP 52).
	readonly version: 1 | 2 | "hybrid"
	readonly private: boolean
	readonly pieceLength: bigint
	// v1 piece count (from `pieces`), or null for a v2-only torrent.
	readonly pieceCount: number | null
	readonly files: readonly TorrentFile[]
	// Listed files beyond FILE_LIMIT, not returned.
	readonly filesOmitted: number
	readonly totalSize: bigint
	// Tracker URLs in tier order, each once (`announce`, `announce-list`).
	readonly trackers: readonly string[]
	// Web seeds (`url-list`).
	readonly webSeeds: readonly string[]
	readonly comment: string | null
	readonly createdBy: string | null
	// Seconds since the epoch.
	readonly creationDate: number | null
	// [start, end) of the `info` dictionary's bencoding.
	readonly infoSpan: readonly [number, number]
}

export class TorrentError extends Error {
	constructor(message: string) {
		super(message)
		this.name = "TorrentError"
	}
}

// The most nested a bencoding may be (a v2 file tree nests one level per directory).
const MAX_DEPTH = 64
// The most values a file may hold before it is refused (a bencode bomb is tiny bytes and huge counts).
const MAX_VALUES = 4_000_000
// The most files returned; the rest are counted.
export const TORRENT_FILE_LIMIT = 200_000
const MAX_TRACKERS = 500

type Value = bigint | Uint8Array | Value[] | Dict

interface Dict {
	readonly entries: Map<string, Value>
	readonly spans: Map<string, readonly [number, number]>
}

interface Utf8Decoder {
	decode(input: Uint8Array): string
}

// Lossy UTF-8 (a torrent's text is UTF-8 by convention, not by guarantee). The platform's decoder, not declared for
// this package's ESNext-only types.
const utf8 = new (globalThis as unknown as { TextDecoder: new (label: string) => Utf8Decoder }).TextDecoder("utf-8")

// Bytes as one character each (dictionary keys, digits): exact, unlike a codepage decoder.
function byteString(bytes: Uint8Array): string {
	let out = ""

	for (const byte of bytes) {
		out += String.fromCharCode(byte)
	}

	return out
}

class Reader {
	private offset = 0
	private values = 0
	private readonly bytes: Uint8Array

	constructor(bytes: Uint8Array) {
		this.bytes = bytes
	}

	read(): Value {
		const value = this.value(0)

		if (this.offset !== this.bytes.length) {
			throw new TorrentError("trailing bytes after the torrent")
		}

		return value
	}

	private byte(): number {
		const byte = this.bytes[this.offset]

		if (byte === undefined) {
			throw new TorrentError("truncated torrent")
		}

		return byte
	}

	// Decimal digits up to `end`, as BEP 3 writes integers and string lengths.
	private digits(end: number, signed: boolean): bigint {
		const start = this.offset

		while (this.byte() !== end) {
			this.offset++
		}

		const text = byteString(this.bytes.subarray(start, this.offset))

		if (!(signed ? /^(?:0|-?[1-9]\d*)$/ : /^(?:0|[1-9]\d*)$/).test(text) || text.length > 20) {
			throw new TorrentError("malformed number")
		}

		this.offset++

		return BigInt(text)
	}

	private value(depth: number): Value {
		if (depth > MAX_DEPTH) {
			throw new TorrentError("nested too deep")
		}

		if (++this.values > MAX_VALUES) {
			throw new TorrentError("too many values")
		}

		const lead = this.byte()

		// i<integer>e
		if (lead === 0x69) {
			this.offset++

			return this.digits(0x65, true)
		}

		// l<values>e
		if (lead === 0x6c) {
			this.offset++

			const list: Value[] = []

			while (this.byte() !== 0x65) {
				list.push(this.value(depth + 1))
			}

			this.offset++

			return list
		}

		// d<key><value>…e
		if (lead === 0x64) {
			this.offset++

			const entries = new Map<string, Value>()
			const spans = new Map<string, readonly [number, number]>()

			while (this.byte() !== 0x65) {
				const key = this.string()
				const start = this.offset
				const value = this.value(depth + 1)
				const name = byteString(key)

				entries.set(name, value)
				spans.set(name, [start, this.offset])
			}

			this.offset++

			return { entries, spans }
		}

		return this.string()
	}

	// <length>:<bytes>
	private string(): Uint8Array {
		const length = this.digits(0x3a, false)

		if (length > BigInt(this.bytes.length - this.offset)) {
			throw new TorrentError("string past the end")
		}

		const start = this.offset

		this.offset += Number(length)

		return this.bytes.subarray(start, this.offset)
	}
}

function isDict(value: Value | undefined): value is Dict {
	return value !== undefined && !(value instanceof Uint8Array) && !Array.isArray(value) && typeof value !== "bigint"
}

function text(value: Value | undefined): string | null {
	return value instanceof Uint8Array ? utf8.decode(value) : null
}

function integer(value: Value | undefined): bigint | null {
	return typeof value === "bigint" ? value : null
}

// A list of strings, or a single one (`url-list` may be either).
function texts(value: Value | undefined): string[] {
	const list = Array.isArray(value) ? value : [value]

	return list.map(text).filter((entry): entry is string => entry !== null)
}

// A name or path part: its UTF-8 copy (`.utf-8`, BEP 3 extension) when there is one.
function named(dict: Dict, key: string): string | null {
	return text(dict.entries.get(`${key}.utf-8`)) ?? text(dict.entries.get(key))
}

interface Files {
	list: TorrentFile[]
	omitted: number
	total: bigint
}

function addFile(files: Files, path: string, size: bigint): void {
	if (size < 0n) {
		throw new TorrentError("negative file size")
	}

	files.total += size

	if (files.list.length < TORRENT_FILE_LIMIT) {
		files.list.push({ path, size })
	} else {
		files.omitted++
	}
}

// v1: a single `length`, or `files` of { length, path: [parts] }.
function v1Files(info: Dict, name: string, files: Files): void {
	const list = info.entries.get("files")

	if (!Array.isArray(list)) {
		addFile(files, name, integer(info.entries.get("length")) ?? 0n)

		return
	}

	for (const entry of list) {
		if (!isDict(entry)) {
			throw new TorrentError("malformed file entry")
		}

		const parts = entry.entries.get("path.utf-8") ?? entry.entries.get("path")
		const path = Array.isArray(parts) ? parts.map(text).filter((part): part is string => part !== null) : []

		// BEP 47 padding files are not the torrent's content.
		if (text(entry.entries.get("attr"))?.includes("p") === true) {
			continue
		}

		addFile(files, [name, ...path].join("/"), integer(entry.entries.get("length")) ?? 0n)
	}
}

// v2: `file tree` of nested directories, a file being a dict whose "" key holds { length, pieces root }. Iterative.
function v2Files(tree: Dict, name: string, files: Files): void {
	const pending: [Dict, string][] = [[tree, name]]

	for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
		const [dict, path] = next

		for (const [key, value] of dict.entries) {
			if (!isDict(value)) {
				throw new TorrentError("malformed file tree")
			}

			const leaf = key === "" ? value : null

			if (leaf !== null) {
				addFile(files, path, integer(leaf.entries.get("length")) ?? 0n)
			} else {
				pending.push([value, `${path}/${utf8.decode(Uint8Array.from(key, char => char.charCodeAt(0)))}`])
			}
		}
	}
}

export function readTorrent(bytes: Uint8Array): TorrentInfo {
	const root = new Reader(bytes).read()

	if (!isDict(root)) {
		throw new TorrentError("not a torrent")
	}

	const info = root.entries.get("info")
	const infoSpan = root.spans.get("info")

	if (!isDict(info) || infoSpan === undefined) {
		throw new TorrentError("no info dictionary")
	}

	const name = named(info, "name") ?? ""
	const pieces = info.entries.get("pieces")
	const tree = info.entries.get("file tree")
	const v1 = pieces instanceof Uint8Array
	const v2 = integer(info.entries.get("meta version")) === 2n && isDict(tree)

	if (!v1 && !v2) {
		throw new TorrentError("neither a v1 nor a v2 torrent")
	}

	if (v1 && pieces.length % 20 !== 0) {
		throw new TorrentError("malformed pieces")
	}

	const files: Files = { list: [], omitted: 0, total: 0n }

	if (v2) {
		v2Files(tree, name, files)
	} else {
		v1Files(info, name, files)
	}

	const trackers = new Set<string>()
	const announce = text(root.entries.get("announce"))
	const tiers = root.entries.get("announce-list")

	if (announce !== null) {
		trackers.add(announce)
	}

	if (Array.isArray(tiers)) {
		for (const tier of tiers) {
			for (const tracker of texts(tier)) {
				if (trackers.size < MAX_TRACKERS) {
					trackers.add(tracker)
				}
			}
		}
	}

	const date = integer(root.entries.get("creation date"))

	return {
		name,
		version: v1 && v2 ? "hybrid" : v2 ? 2 : 1,
		private: integer(info.entries.get("private")) === 1n,
		pieceLength: integer(info.entries.get("piece length")) ?? 0n,
		pieceCount: v1 ? pieces.length / 20 : null,
		files: files.list,
		filesOmitted: files.omitted,
		totalSize: files.total,
		trackers: [...trackers],
		webSeeds: texts(root.entries.get("url-list")).slice(0, MAX_TRACKERS),
		comment: named(root, "comment"),
		createdBy: text(root.entries.get("created by")),
		creationDate: date === null || date < 0n || date > 253_402_300_799n ? null : Number(date),
		infoSpan
	}
}

function hex(bytes: ArrayBuffer): string {
	return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, "0")).join("")
}

export interface TorrentHashes {
	// SHA-1 of the info dictionary (v1 and hybrid torrents).
	readonly v1: string | null
	// SHA-256 of it (v2 and hybrid torrents).
	readonly v2: string | null
}

// The infohashes over the file's own `info` bytes, with the platform's digest (WebCrypto).
export async function torrentHashes(
	bytes: Uint8Array<ArrayBuffer>,
	info: TorrentInfo,
	digest: (algorithm: "SHA-1" | "SHA-256", data: Uint8Array<ArrayBuffer>) => Promise<ArrayBuffer>
): Promise<TorrentHashes> {
	const span = bytes.subarray(info.infoSpan[0], info.infoSpan[1])

	return {
		v1: info.version === 2 ? null : hex(await digest("SHA-1", span)),
		v2: info.version === 1 ? null : hex(await digest("SHA-256", span))
	}
}

// A magnet link for the torrent (BEP 9 and 52): its infohashes, name and trackers. Text only.
export function torrentMagnet(info: TorrentInfo, hashes: TorrentHashes): string {
	const parts: string[] = []

	if (hashes.v1 !== null) {
		parts.push(`xt=urn:btih:${hashes.v1}`)
	}

	if (hashes.v2 !== null) {
		parts.push(`xt=urn:btmh:1220${hashes.v2}`)
	}

	if (info.name !== "") {
		parts.push(`dn=${encodeURIComponent(info.name)}`)
	}

	for (const tracker of info.trackers) {
		parts.push(`tr=${encodeURIComponent(tracker)}`)
	}

	return `magnet:?${parts.join("&")}`
}
