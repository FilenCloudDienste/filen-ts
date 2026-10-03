import { crc32, deflateRawSync, gzipSync } from "node:zlib"

// Deterministic archive builders for the archive e2e specs: the shared fixture tree's archives
// (setup/fixtures.setup.ts uploads them) and the small ones the write specs upload into their own
// scratch directories. Node-only and byte-for-byte reproducible, so no binary is checked in and every
// expected name, size and text lives next to the bytes that carry it.

// The password of every ZipCrypto fixture.
export const ZIPCRYPTO_PASSWORD = "e2e-zipcrypto"

// xorshift32: an incompressible, seeded byte stream. Each call continues where the last one ended.
export function prng(seed: number): (length: number) => Buffer {
	let state = seed >>> 0 || 0x9e3779b9

	return length => {
		const words = new Uint32Array(Math.ceil(length / 4))

		for (let i = 0; i < words.length; i++) {
			state ^= state << 13
			state ^= state >>> 17
			state ^= state << 5
			state >>>= 0
			words[i] = state
		}

		return Buffer.from(words.buffer, 0, length)
	}
}

// What an AppleDouble file (a `._` twin holding macOS metadata) starts with: magic, version 2, 16
// filler bytes and an empty entry table. The SDK tells one by these bytes, not by its name alone.
export const APPLE_DOUBLE_BYTES = Buffer.from([
	0x00,
	0x05,
	0x16,
	0x07,
	0x00,
	0x02,
	0x00,
	0x00,
	...new Array<number>(16).fill(0),
	0x00,
	0x00
])

export interface ZipEntrySpec {
	name: string
	data?: Buffer | string
	kind?: "file" | "dir" | "symlink"
	// A symlink's target, stored as its data.
	target?: string
	// deflate by default; directories and symlinks are always stored.
	method?: "stored" | "deflate"
	// Encrypts the entry with ZipCrypto under this password.
	zipCrypto?: string
	// The data is an AppleDouble header (any `data` is ignored).
	appleDouble?: boolean
}

// 2024-01-01 12:00:00 in MS-DOS form.
const DOS_TIME = 12 << 11
const DOS_DATE = ((2024 - 1980) << 9) | (1 << 5) | 1
const UTF8_FLAG = 1 << 11
const ENCRYPTED_FLAG = 1
// Unix, spec version 2.0: the external attributes' high half is a st_mode.
const MADE_BY_UNIX = (3 << 8) | 20
const MODE_FILE = 0o100644
const MODE_DIR = 0o040755
const MODE_SYMLINK = 0o120777
const MSDOS_DIR = 0x10
const ZIP64_MIN_ENTRIES = 0xffff

function asBuffer(data: Buffer | string | undefined): Buffer {
	return data === undefined ? Buffer.alloc(0) : typeof data === "string" ? Buffer.from(data, "utf8") : data
}

// ZipCrypto's three keys over the zip CRC-32 step (APPNOTE 6.1).
function crcStep(crc: number, byte: number): number {
	let value = (crc ^ byte) & 0xff

	for (let bit = 0; bit < 8; bit++) {
		value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1
	}

	return (value ^ (crc >>> 8)) >>> 0
}

// The 12-byte header (random, its last byte the CRC's high byte) and the data, encrypted.
function zipCryptoEncrypt(password: string, check: number, data: Buffer, header: Buffer): Buffer {
	let k0 = 0x12345678
	let k1 = 0x23456789
	let k2 = 0x34567890
	const update = (byte: number): void => {
		k0 = crcStep(k0, byte)
		k1 = (Math.imul(k1 + (k0 & 0xff), 134775813) + 1) >>> 0
		k2 = crcStep(k2, k1 >>> 24)
	}
	const plain = Buffer.concat([header.subarray(0, 11), Buffer.from([check]), data])
	const out = Buffer.alloc(plain.length)

	for (const byte of Buffer.from(password, "utf8")) {
		update(byte)
	}

	for (let i = 0; i < plain.length; i++) {
		const temp = (k2 | 2) & 0xffff
		const stream = (Math.imul(temp, temp ^ 1) >>> 8) & 0xff
		const byte = plain[i] ?? 0

		out[i] = byte ^ stream
		update(byte)
	}

	return out
}

// A zip of `entries` in order (a name may repeat): local headers, central directory and end record,
// with the zip64 end record and locator once the count passes what 16 bits hold. Names are UTF-8
// (flag bit 11); every entry is made by Unix, so a symlink is told by its mode.
export function buildZip(entries: readonly ZipEntrySpec[]): Buffer {
	const local: Buffer[] = []
	const central: Buffer[] = []
	const headerBytes = prng(0x5eed)
	let offset = 0

	for (const entry of entries) {
		const kind = entry.kind ?? "file"
		const name = Buffer.from(kind === "dir" && !entry.name.endsWith("/") ? `${entry.name}/` : entry.name, "utf8")
		const data = kind === "symlink" ? asBuffer(entry.target) : entry.appleDouble === true ? APPLE_DOUBLE_BYTES : asBuffer(entry.data)
		const deflated = kind === "file" && (entry.method ?? "deflate") === "deflate"
		const crc = crc32(data)
		let stored = deflated ? deflateRawSync(data) : data
		let flags = UTF8_FLAG

		if (entry.zipCrypto !== undefined) {
			stored = zipCryptoEncrypt(entry.zipCrypto, crc >>> 24, stored, headerBytes(12))
			flags |= ENCRYPTED_FLAG
		}

		const mode = kind === "dir" ? MODE_DIR : kind === "symlink" ? MODE_SYMLINK : MODE_FILE
		const external = (mode * 0x10000 + (kind === "dir" ? MSDOS_DIR : 0)) >>> 0
		const header = Buffer.alloc(30)

		header.writeUInt32LE(0x04034b50, 0)
		header.writeUInt16LE(20, 4)
		header.writeUInt16LE(flags, 6)
		header.writeUInt16LE(deflated ? 8 : 0, 8)
		header.writeUInt16LE(DOS_TIME, 10)
		header.writeUInt16LE(DOS_DATE, 12)
		header.writeUInt32LE(crc, 14)
		header.writeUInt32LE(stored.length, 18)
		header.writeUInt32LE(data.length, 22)
		header.writeUInt16LE(name.length, 26)
		header.writeUInt16LE(0, 28)
		local.push(header, name, stored)

		const record = Buffer.alloc(46)

		record.writeUInt32LE(0x02014b50, 0)
		record.writeUInt16LE(MADE_BY_UNIX, 4)
		header.copy(record, 6, 4, 26)
		record.writeUInt16LE(name.length, 28)
		record.writeUInt32LE(external, 38)
		record.writeUInt32LE(offset, 42)
		central.push(record, name)

		offset += header.length + name.length + stored.length
	}

	const directory = Buffer.concat(central)
	const zip64 = entries.length >= ZIP64_MIN_ENTRIES
	const tail: Buffer[] = []

	if (zip64) {
		const record = Buffer.alloc(56)

		record.writeUInt32LE(0x06064b50, 0)
		record.writeBigUInt64LE(44n, 4)
		record.writeUInt16LE((3 << 8) | 45, 12)
		record.writeUInt16LE(45, 14)
		record.writeBigUInt64LE(BigInt(entries.length), 24)
		record.writeBigUInt64LE(BigInt(entries.length), 32)
		record.writeBigUInt64LE(BigInt(directory.length), 40)
		record.writeBigUInt64LE(BigInt(offset), 48)

		const locator = Buffer.alloc(20)

		locator.writeUInt32LE(0x07064b50, 0)
		locator.writeBigUInt64LE(BigInt(offset + directory.length), 8)
		locator.writeUInt32LE(1, 16)
		tail.push(record, locator)
	}

	const end = Buffer.alloc(22)
	const count = zip64 ? 0xffff : entries.length

	end.writeUInt32LE(0x06054b50, 0)
	end.writeUInt16LE(count, 8)
	end.writeUInt16LE(count, 10)
	end.writeUInt32LE(directory.length, 12)
	end.writeUInt32LE(offset, 16)

	return Buffer.concat([...local, directory, ...tail, end])
}

export interface TarEntrySpec {
	name: string
	data?: Buffer | string
	kind?: "file" | "dir" | "symlink" | "hardlink"
	// A link's target.
	target?: string
}

const TAR_BLOCK = 512
const TAR_TYPES = { file: "0", hardlink: "1", symlink: "2", dir: "5" } as const
const TAR_MTIME = Date.UTC(2024, 0, 1, 12) / 1000

function writeOctal(block: Buffer, at: number, width: number, value: number): void {
	block.write(`${value.toString(8).padStart(width - 1, "0")}\0`, at, width, "ascii")
}

function tarHeader(name: string, size: number, type: string, target: string, mode: number): Buffer {
	const block = Buffer.alloc(TAR_BLOCK)

	block.write(name, 0, 100, "utf8")
	writeOctal(block, 100, 8, mode)
	writeOctal(block, 108, 8, 0)
	writeOctal(block, 116, 8, 0)
	writeOctal(block, 124, 12, size)
	writeOctal(block, 136, 12, TAR_MTIME)
	block.fill(0x20, 148, 156)
	block.write(type, 156, 1, "ascii")
	block.write(target, 157, 100, "utf8")
	block.write("ustar\0", 257, 6, "ascii")
	block.write("00", 263, 2, "ascii")
	block.write("e2e", 265, 32, "ascii")
	block.write("e2e", 297, 32, "ascii")

	let sum = 0

	for (const byte of block) {
		sum += byte
	}

	block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii")

	return block
}

function padded(data: Buffer): Buffer[] {
	const rest = data.length % TAR_BLOCK

	return rest === 0 ? [data] : [data, Buffer.alloc(TAR_BLOCK - rest)]
}

// A pax record "<len> path=<name>\n", whose length counts its own digits.
function paxRecord(key: string, value: string): Buffer {
	const body = ` ${key}=${value}\n`
	let length = Buffer.byteLength(body) + 1

	while (String(length).length + Buffer.byteLength(body) !== length) {
		length = String(length).length + Buffer.byteLength(body)
	}

	return Buffer.from(`${String(length)}${body}`, "utf8")
}

// A POSIX ustar archive: files, directories, symlinks and hard links, a pax header ahead of any name
// longer than ustar's 100 bytes, and the two zero blocks that end it.
export function buildTar(entries: readonly TarEntrySpec[]): Buffer {
	const blocks: Buffer[] = []

	for (const entry of entries) {
		const kind = entry.kind ?? "file"
		const name = kind === "dir" && !entry.name.endsWith("/") ? `${entry.name}/` : entry.name
		const data = kind === "file" ? asBuffer(entry.data) : Buffer.alloc(0)
		const mode = kind === "dir" ? 0o755 : kind === "symlink" ? 0o777 : 0o644

		if (Buffer.byteLength(name) > 100) {
			const pax = paxRecord("path", name)

			blocks.push(tarHeader(`PaxHeaders/${String(blocks.length)}`, pax.length, "x", "", 0o644), ...padded(pax))
		}

		blocks.push(tarHeader(name.slice(-100), data.length, TAR_TYPES[kind], entry.target ?? "", mode), ...padded(data))
	}

	blocks.push(Buffer.alloc(TAR_BLOCK * 2))

	return Buffer.concat(blocks)
}

// gzip with a fixed header: mtime 0 already, and the OS byte pinned to Unix, which zlib otherwise
// sets per build platform.
export function gzip(data: Buffer, level = 6): Buffer {
	const out = gzipSync(data, { level })

	out[9] = 3

	return out
}

// ── The fixture tree's archives (helpers/fixtures.ts names them) ─────────────────────────────────────

// `tree.zip`'s files, path -> text, in the order written. Sizes are their UTF-8 byte lengths.
export const TREE_FILES = {
	"readme.txt": "tree readme\n",
	"photos/cover.txt": "the cover of the photos\n",
	"photos/2024/x.txt": "x marks the spot\n",
	"photos/2024/y.txt": "why, a second file\n",
	"docs/a/b/c/deep.txt": "deep down in docs\n"
} as const

function treeEntries(readme: string): ZipEntrySpec[] {
	return [
		{ name: "docs", kind: "dir" },
		{ name: "docs/a", kind: "dir" },
		{ name: "docs/a/b", kind: "dir" },
		{ name: "docs/a/b/c", kind: "dir" },
		{ name: "empty-dir", kind: "dir" },
		{ name: "photos", kind: "dir" },
		{ name: "photos/2024", kind: "dir" },
		...Object.entries(TREE_FILES).map(([name, text]) => ({ name, data: name === "readme.txt" ? readme : text }))
	]
}

// What a tree zip (the fixture's, plainTreeZip's) holds at its root.
export const TREE_ROOT = ["docs", "empty-dir", "photos", "readme.txt"] as const

export function treeZip(): Buffer {
	return buildZip(treeEntries(TREE_FILES["readme.txt"]))
}

// 257 segments: one more than the SDK's MAX_ARCHIVE_PATH_DEPTH.
export const HOSTILE_DEEP_PATH = ["deep", ...new Array<string>(255).fill("d"), "x.txt"].join("/")
// U+202E (right-to-left override): reads as "invoiceexe.pdf".
export const HOSTILE_MISLEADING_NAME = "invoice‮fdp.exe"

export function hostileZip(): Buffer {
	return buildZip([
		{ name: "ok.txt", data: "ok\n" },
		{ name: "docs/readme.txt", data: "hostile readme\n" },
		{ name: "link-to-ok", kind: "symlink", target: "ok.txt" },
		{ name: "../escape.txt", data: "escaped\n" },
		{ name: "/abs/rooted.txt", data: "rooted\n" },
		{ name: HOSTILE_MISLEADING_NAME, data: "not a pdf\n" },
		{ name: "dup.txt", data: "first\n" },
		{ name: "dup.txt", data: "second\n" },
		{ name: "__MACOSX/._ok.txt", appleDouble: true },
		{ name: "._readme.txt", appleDouble: true },
		{ name: HOSTILE_DEEP_PATH, data: "too deep\n" }
	])
}

export const LOCKED_FILES = { "secret.txt": "a ZipCrypto secret\n", "inner/more.txt": "more secrets\n" } as const

export function lockedZip(): Buffer {
	return buildZip(Object.entries(LOCKED_FILES).map(([name, data]) => ({ name, data, zipCrypto: ZIPCRYPTO_PASSWORD })))
}

export const LINKS_TARGET_TEXT = "the hard links' target\n"

export function linksTar(): Buffer {
	return buildTar([
		{ name: "dir", kind: "dir" },
		{ name: "dir/target.txt", data: LINKS_TARGET_TEXT },
		{ name: "dir/hard.txt", kind: "hardlink", target: "dir/target.txt" },
		{ name: "other", kind: "dir" },
		{ name: "other/plain.txt", data: "plain\n" },
		{ name: "other/hl-out.txt", kind: "hardlink", target: "dir/target.txt" },
		{ name: "sym", kind: "symlink", target: "dir/target.txt" },
		{ name: "missing-hl", kind: "hardlink", target: "nope.txt" }
	])
}

export function smallTarGz(): Buffer {
	return gzip(
		buildTar([
			{ name: "small", kind: "dir" },
			{ name: "small/one.txt", data: "one\n" },
			{ name: "small/two.txt", data: "two\n" }
		])
	)
}

export const NOTE_TEXT = "note body\n"

export function noteTxtGz(): Buffer {
	return gzip(Buffer.from(NOTE_TEXT, "utf8"))
}

// An end record and nothing else.
export function emptyZip(): Buffer {
	return buildZip([])
}

export function garbageZip(): Buffer {
	return prng(7)(4096)
}

// Three 64 KiB random files, gzipped, then cut at 70 %: the first entries read, the rest is gone.
export function corruptTarGz(): Buffer {
	const bytes = prng(11)
	const whole = gzip(buildTar(["a.bin", "b.bin", "c.bin"].map(name => ({ name: `corrupt/${name}`, data: bytes(64 * 1024) }))))

	return whole.subarray(0, Math.floor(whole.length * 0.7))
}

// Over the browser's 8 MiB gate, so listing it waits for "Browse contents". gzip level 1 over
// random bytes keeps the archive about as large as its content.
export const GATE_BIG_BLOB_BYTES = 8.5 * 1024 * 1024

export function gateBigTarGz(): Buffer {
	return gzip(buildTar([{ name: "e2e-arc-gate-big/blob.bin", data: prng(13)(GATE_BIG_BLOB_BYTES) }]), 1)
}

export function gateNextZip(): Buffer {
	return buildZip([{ name: "next.txt", data: "the archive after the gate\n" }])
}

export const MANY_LINKS_COUNT = 5000

// `ok.txt` and 5000 symlinks to it: one extracted, 5000 skipped, past the report's 1000-row cap.
export function manyLinksZip(): Buffer {
	return buildZip([
		{ name: "ok.txt", data: "ok\n" },
		...Array.from({ length: MANY_LINKS_COUNT }, (_, index) => ({
			name: `l/${String(index + 1).padStart(5, "0")}`,
			kind: "symlink" as const,
			target: "../ok.txt"
		}))
	])
}

export const HUNDRED_K_COUNT = 100_000

// 100 000 empty stored files, flat: zip64 by count alone, about 9 MB of headers.
export function hundredKZip(): Buffer {
	return buildZip(
		Array.from({ length: HUNDRED_K_COUNT }, (_, index) => ({ name: `f${String(index).padStart(6, "0")}`, method: "stored" as const }))
	)
}

// The bulk-extract trio: two under ZIPCRYPTO_PASSWORD, one plain, each with its own text file.
export function bulkZip(letter: "a" | "b" | "c"): Buffer {
	return buildZip([
		{
			name: `${letter}.txt`,
			data: `bulk ${letter}\n`,
			...(letter === "c" ? {} : { zipCrypto: ZIPCRYPTO_PASSWORD })
		}
	])
}

// A tiny plain zip beside the archive-dialogs text files, so a mixed selection exists there.
export function dialogZip(): Buffer {
	return buildZip([{ name: "dialog.txt", data: "dialog\n" }])
}

// ── Per-test builders for the write specs' own scratch directories ──────────────────────────────────

// readme.txt carries the run id, so a preview of the extracted file proves it came from this upload.
export function treeReadmeText(runId: string): string {
	return `tree readme ${runId}\n`
}

export function plainTreeZip(runId: string): Buffer {
	return buildZip(treeEntries(treeReadmeText(runId)))
}

export function noteText(runId: string): string {
	return `note body ${runId}\n`
}

export function noteGz(runId: string): Buffer {
	return gzip(Buffer.from(noteText(runId), "utf8"))
}
