import { bytesToHex, platformTextDecoder, type PlatformTextDecoder } from "./bytes"
import { withoutFormatControls } from "./formatControls"

// A .torrent file's metadata (BEP 3, 12, 19, 27, 47, 52), read from its bencoding. Every bound is checked: the caller
// hands untrusted bytes, so the value count, nesting, every text and the paths all have caps, and what passes a cap is
// counted or cut rather than kept. The `info` dictionary's exact span is kept, so its infohashes are taken over the
// bytes the file holds. Nothing here contacts a tracker or a peer: their addresses are text. Texts come back without
// format or bidi controls, which could disguise a name (an extension shown reversed).

export interface TorrentFile {
	// Path parts joined with "/", each part and the whole cut to their caps.
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
	// In the file's own order (a v2 file tree depth first, as it is written).
	readonly files: readonly TorrentFile[]
	// Listed files not returned: past TORRENT_FILE_LIMIT, or past the path characters a reading may hold.
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

// "malformed": not a torrent this reader can read. "tooLarge": a torrent past the reader's caps.
export class TorrentError extends Error {
	readonly kind: "malformed" | "tooLarge"

	constructor(kind: "malformed" | "tooLarge", message: string) {
		super(message)
		this.name = "TorrentError"
		this.kind = kind
	}
}

// The most nested a bencoding may be (a v2 file tree nests one level per directory).
const MAX_DEPTH = 64
// The most values a file may hold (a 200,000-file torrent holds about 800,000): a bencode bomb is tiny bytes and huge
// counts, each value an allocation.
const MAX_VALUES = 1_000_000
// The most files returned; the rest are counted.
export const TORRENT_FILE_LIMIT = 200_000
// Text caps, in UTF-16 units: a path part or name, a whole path, all paths of a reading together, and the free texts.
const MAX_PART = 1024
const MAX_PATH = 4096
const MAX_PATH_TOTAL = 16 * 1024 * 1024
const MAX_COMMENT = 4096
const MAX_CREATED_BY = 256
const MAX_ADDRESS = 2048
const MAX_ADDRESSES = 500
// A dictionary key's bytes at most: real keys are short, and a file name is cut to MAX_PART anyway.
const MAX_KEY_BYTES = 8192

type Value = bigint | Uint8Array | Value[] | Dict | FileTree

// A v2 `file tree` (BEP 52) read straight into a flat table, not a dictionary per entry: each node (a directory, or a
// file's own name) is its name's bytes and its parent; each file is its node and length, in the tree's order.
class FileTree {
	readonly names: Uint8Array[] = []
	readonly parents: number[] = []
	readonly fileNodes: number[] = []
	readonly lengths: bigint[] = []
}

// A dictionary as its keys (one character a byte) and values, in the file's order.
class Dict {
	readonly keys: string[] = []
	readonly values: Value[] = []

	get(key: string): Value | undefined {
		const index = this.keys.indexOf(key)

		return index === -1 ? undefined : this.values[index]
	}
}

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
	// The root dictionary's `info` value span.
	infoSpan: [number, number] | null = null

	constructor(bytes: Uint8Array) {
		this.bytes = bytes
	}

	read(): Value {
		const value = this.value(0)

		if (this.offset !== this.bytes.length) {
			throw new TorrentError("malformed", "trailing bytes after the torrent")
		}

		return value
	}

	private byte(): number {
		const byte = this.bytes[this.offset]

		if (byte === undefined) {
			throw new TorrentError("malformed", "truncated torrent")
		}

		return byte
	}

	// Decimal digits up to `end`, as BEP 3 writes integers and string lengths.
	private digits(end: number, signed: boolean): bigint {
		const start = this.offset

		while (this.byte() !== end) {
			if (this.offset - start > 20) {
				throw new TorrentError("malformed", "malformed number")
			}

			this.offset++
		}

		const text = byteString(this.bytes.subarray(start, this.offset))

		if (!(signed ? /^(?:0|-?[1-9]\d*)$/ : /^(?:0|[1-9]\d*)$/).test(text)) {
			throw new TorrentError("malformed", "malformed number")
		}

		this.offset++

		return BigInt(text)
	}

	// `info`: this is the root's `info` dictionary, whose `file tree` is read as a flat table.
	private value(depth: number, info = false): Value {
		if (depth > MAX_DEPTH) {
			throw new TorrentError("tooLarge", "nested too deep")
		}

		if (++this.values > MAX_VALUES) {
			throw new TorrentError("tooLarge", "too many values")
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

		// d<key><value>…e: keys unique (BEP 3 also has them sorted; out of order is read as written).
		if (lead === 0x64) {
			this.offset++

			const dict = new Dict()
			let seen: Set<string> | null = null

			while (this.byte() !== 0x65) {
				const raw = this.string()

				if (raw.length > MAX_KEY_BYTES) {
					throw new TorrentError("tooLarge", "dictionary key too long")
				}

				const key = byteString(raw)
				const last = dict.keys.at(-1)

				if (last !== undefined && key <= last) {
					seen ??= new Set(dict.keys)

					if (seen.has(key)) {
						throw new TorrentError("malformed", "duplicate dictionary key")
					}
				}

				seen?.add(key)

				const start = this.offset
				const value = info && key === "file tree" ? this.fileTree(depth + 1) : this.value(depth + 1, depth === 0 && key === "info")

				if (depth === 0 && key === "info") {
					this.infoSpan = [start, this.offset]
				}

				dict.keys.push(key)
				dict.values.push(value)
			}

			this.offset++

			return dict
		}

		return this.string()
	}

	private fileTree(depth: number): FileTree {
		const tree = new FileTree()

		this.treeNode(tree, -1, new Uint8Array(0), depth)

		return tree
	}

	// A directory dictionary: its "" key holds a file's properties (the file is this node), every other key a child node.
	// Keys unique, as for any dictionary.
	private treeNode(tree: FileTree, parent: number, name: Uint8Array, depth: number): void {
		if (depth > MAX_DEPTH) {
			throw new TorrentError("tooLarge", "nested too deep")
		}

		if (++this.values > MAX_VALUES) {
			throw new TorrentError("tooLarge", "too many values")
		}

		if (this.byte() !== 0x64) {
			throw new TorrentError("malformed", "malformed file tree")
		}

		this.offset++

		const node = tree.names.push(name) - 1
		let last: string | null = null
		let seen: Set<string> | null = null
		const keys: string[] = []

		tree.parents.push(parent)

		while (this.byte() !== 0x65) {
			const raw = this.string()

			if (raw.length > MAX_KEY_BYTES) {
				throw new TorrentError("tooLarge", "dictionary key too long")
			}

			const key = byteString(raw)

			if (last !== null && key <= last) {
				seen ??= new Set(keys)

				if (seen.has(key)) {
					throw new TorrentError("malformed", "duplicate dictionary key")
				}
			}

			seen?.add(key)
			// Kept only until the dictionary ends, for the duplicate check of a key out of order.
			keys.push(key)
			last = key

			if (key === "") {
				const props = this.value(depth + 1)

				if (!(props instanceof Dict)) {
					throw new TorrentError("malformed", "malformed file tree")
				}

				tree.fileNodes.push(node)
				tree.lengths.push(integer(props.get("length")) ?? 0n)
			} else {
				this.treeNode(tree, node, raw, depth + 1)
			}
		}

		this.offset++
	}

	// <length>:<bytes>
	private string(): Uint8Array {
		const length = this.digits(0x3a, false)

		if (length > BigInt(this.bytes.length - this.offset)) {
			throw new TorrentError("malformed", "string past the end")
		}

		const start = this.offset

		this.offset += Number(length)

		return this.bytes.subarray(start, this.offset)
	}
}

let decoder: PlatformTextDecoder | null = null

// The first `units` UTF-16 units, without a high surrogate left alone at the end (`encodeURIComponent` throws on one).
function cutUnits(text: string, units: number): string {
	return units > 0 && (text.charCodeAt(units - 1) & 0xfc00) === 0xd800 ? text.slice(0, units - 1) : text.slice(0, units)
}

// Lossy UTF-8 (a torrent's text is UTF-8 by convention, not by guarantee), its controls out, cut to `cap` units.
function display(bytes: Uint8Array, cap: number): string {
	decoder ??= platformTextDecoder("utf-8")

	// A cap's worth of characters takes at most four bytes each.
	const text = withoutFormatControls(decoder.decode(bytes.subarray(0, cap * 4)))

	return text.length > cap ? `${cutUnits(text, cap - 1)}…` : text
}

function text(value: Value | undefined, cap: number): string | null {
	return value instanceof Uint8Array ? display(value, cap) : null
}

function integer(value: Value | undefined): bigint | null {
	return typeof value === "bigint" ? value : null
}

// A name or path part: its UTF-8 copy (`.utf-8`, BEP 3 extension) when there is one.
function named(dict: Dict, key: string, cap: number): string | null {
	return text(dict.get(`${key}.utf-8`), cap) ?? text(dict.get(key), cap)
}

interface Files {
	list: TorrentFile[]
	omitted: number
	total: bigint
	pathChars: number
	// No further path fits: the file limit is reached or a path ran past the characters left. Every later file is
	// counted without building its path.
	full: boolean
}

// A path being built, cut once it reaches MAX_PATH: a cut path takes no more parts.
interface PathPrefix {
	readonly path: string
	readonly cut: boolean
}

function withPart(prefix: PathPrefix, part: string): PathPrefix {
	if (prefix.cut) {
		return prefix
	}

	const room = MAX_PATH - prefix.path.length - 1

	return part.length <= room
		? { path: `${prefix.path}/${part}`, cut: false }
		: { path: `${cutUnits(`${prefix.path}/${cutUnits(part, room + 1)}`, MAX_PATH - 1)}…`, cut: true }
}

// Whether another file's path is to be built: a file past the limit or the budget is only counted.
function admits(files: Files, size: bigint): boolean {
	if (size < 0n) {
		throw new TorrentError("malformed", "negative file size")
	}

	files.total += size

	if (files.full || files.list.length >= TORRENT_FILE_LIMIT) {
		files.full = true
		files.omitted++

		return false
	}

	return true
}

function addFile(files: Files, path: string, size: bigint): void {
	if (files.pathChars + path.length > MAX_PATH_TOTAL) {
		files.full = true
		files.omitted++

		return
	}

	files.pathChars += path.length
	files.list.push({ path, size })
}

// v1: a single `length`, or `files` of { length, path: [parts] }.
function v1Files(info: Dict, name: string, files: Files): void {
	const list = info.get("files")

	if (!Array.isArray(list)) {
		const size = integer(info.get("length")) ?? 0n

		if (admits(files, size)) addFile(files, name, size)

		return
	}

	for (const entry of list) {
		if (!(entry instanceof Dict)) {
			throw new TorrentError("malformed", "malformed file entry")
		}

		// BEP 47 padding files are not the torrent's content.
		if (text(entry.get("attr"), 16)?.includes("p") === true) {
			continue
		}

		const size = integer(entry.get("length")) ?? 0n

		if (!admits(files, size)) {
			continue
		}

		const raw = entry.get("path.utf-8") ?? entry.get("path")
		let path: PathPrefix = { path: name, cut: false }

		for (const part of Array.isArray(raw) ? raw : []) {
			if (path.cut) break

			const decoded = text(part, MAX_PART)

			if (decoded !== null) path = withPart(path, decoded)
		}

		addFile(files, path.path, size)
	}
}

// A file tree key as a path part: only the bytes a part can show are decoded.
function keyPart(key: Uint8Array): string {
	return display(key, MAX_PART)
}

// v2: the file tree's files in its order. Each directory's path is built (and cut) once, the first time a file under
// it is listed; a file appends only its own name. Past the file limit or the path budget, files are only counted: no
// name is decoded.
function v2Files(tree: FileTree, name: string, files: Files): void {
	const prefixes = new Map<number, PathPrefix>([[0, { path: name, cut: false }]])

	const prefixOf = (node: number): PathPrefix => {
		const known = prefixes.get(node)

		if (known !== undefined) {
			return known
		}

		const prefix = withPart(prefixOf(tree.parents[node] ?? 0), keyPart(tree.names[node] ?? new Uint8Array(0)))

		prefixes.set(node, prefix)

		return prefix
	}

	for (let index = 0; index < tree.fileNodes.length; index++) {
		const node = tree.fileNodes[index] ?? 0
		const size = tree.lengths[index] ?? 0n

		if (!admits(files, size)) continue

		// A file's own node is no directory: its path is not kept.
		const path = node === 0 ? name : withPart(prefixOf(tree.parents[node] ?? 0), keyPart(tree.names[node] ?? new Uint8Array(0))).path

		addFile(files, path, size)
	}
}

// Strings, from a list or a single one (`url-list` may be either), the first `count` only, each cut.
function addresses(value: Value | undefined, count: number): string[] {
	const list = (Array.isArray(value) ? value : [value]).slice(0, count)

	return list.map(entry => text(entry, MAX_ADDRESS)).filter((entry): entry is string => entry !== null)
}

export function readTorrent(bytes: Uint8Array): TorrentInfo {
	const reader = new Reader(bytes)
	const root = reader.read()

	if (!(root instanceof Dict)) {
		throw new TorrentError("malformed", "not a torrent")
	}

	const info = root.get("info")
	const infoSpan = reader.infoSpan

	if (!(info instanceof Dict) || infoSpan === null) {
		throw new TorrentError("malformed", "no info dictionary")
	}

	const name = named(info, "name", MAX_PART) ?? ""
	const pieces = info.get("pieces")
	const tree = info.get("file tree")
	const v1 = pieces instanceof Uint8Array
	const v2 = integer(info.get("meta version")) === 2n && tree instanceof FileTree

	if (!v1 && !v2) {
		throw new TorrentError("malformed", "neither a v1 nor a v2 torrent")
	}

	if (v1 && pieces.length % 20 !== 0) {
		throw new TorrentError("malformed", "malformed pieces")
	}

	const files: Files = { list: [], omitted: 0, total: 0n, pathChars: 0, full: false }

	if (v2) {
		v2Files(tree, name, files)
	} else {
		v1Files(info, name, files)
	}

	const trackers = new Set<string>()
	const announce = text(root.get("announce"), MAX_ADDRESS)
	const tiers = root.get("announce-list")

	if (announce !== null) {
		trackers.add(announce)
	}

	if (Array.isArray(tiers)) {
		for (const tier of tiers) {
			if (trackers.size >= MAX_ADDRESSES) {
				break
			}

			for (const tracker of addresses(tier, MAX_ADDRESSES - trackers.size)) {
				trackers.add(tracker)
			}
		}
	}

	const date = integer(root.get("creation date"))

	return {
		name,
		version: v1 && v2 ? "hybrid" : v2 ? 2 : 1,
		private: integer(info.get("private")) === 1n,
		pieceLength: integer(info.get("piece length")) ?? 0n,
		pieceCount: v1 ? pieces.length / 20 : null,
		files: files.list,
		filesOmitted: files.omitted,
		totalSize: files.total,
		trackers: [...trackers],
		webSeeds: addresses(root.get("url-list"), MAX_ADDRESSES),
		comment: named(root, "comment", MAX_COMMENT),
		createdBy: text(root.get("created by"), MAX_CREATED_BY),
		creationDate: date === null || date < 0n || date > 253_402_300_799n ? null : Number(date),
		infoSpan
	}
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
		v1: info.version === 2 ? null : bytesToHex(await digest("SHA-1", span)),
		v2: info.version === 1 ? null : bytesToHex(await digest("SHA-256", span))
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
