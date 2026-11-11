import type { DesktopSdkVariant } from "./desktop"

// Converts SDK items between the wasm shapes the page holds (`@filen/sdk-rs` sdk-rs.d.ts: untagged unions,
// `{ type, data }` metas, hex hashes, number[] bytes) and the native shapes napi takes and returns (ubrn's
// generated filen_sdk_rs.ts: `{ tag, inner: [..] }` enums, Uint8Array bytes). Every field is checked on the way:
// an unknown or missing field, a wrong leaf type or a variant that does not fit throws SdkShapeError, so a
// value from a newer SDK fails loudly instead of reaching napi half converted. Messages name the field path,
// never a value (items carry file keys).

export class SdkShapeError extends Error {
	override name = "SdkShapeError"
}

type Obj = Record<string, unknown>

interface Conv {
	ubrn(value: unknown, at: string): unknown
	wasm(value: unknown, at: string): unknown
}

function fail(at: string, reason: string): never {
	throw new SdkShapeError(`${at || "value"}: ${reason}`)
}

function objectAt(value: unknown, at: string): Obj {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		fail(at, "expected an object")
	}

	return value as Obj
}

function join(at: string, key: string): string {
	return at ? `${at}.${key}` : key
}

function leaf(kind: "string" | "boolean" | "bigint"): Conv {
	const check = (value: unknown, at: string): unknown => {
		if (typeof value !== kind) {
			fail(at, `expected a ${kind}`)
		}

		return value
	}

	return {
		ubrn: check,
		wasm: check
	}
}

const str = leaf("string")
const bool = leaf("boolean")
// u64 sizes and chunk counts, and DateTime millis: bigint on both sides.
const big = leaf("bigint")

const u8: Conv = {
	ubrn: (value, at) => {
		if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 255) {
			fail(at, "expected an integer 0-255")
		}

		return value
	},
	wasm: (value, at) => u8.ubrn(value, at)
}

// FileEncryptionVersion: 1 | 2 | 3 in wasm, ubrn's numeric enum V1 = 1, V2 = 2, V3 = 3.
const encryptionVersion: Conv = {
	ubrn: (value, at) => {
		if (value !== 1 && value !== 2 && value !== 3) {
			fail(at, "expected 1, 2 or 3")
		}

		return value
	},
	wasm: (value, at) => encryptionVersion.ubrn(value, at)
}

// ShareInfo.id is a u64: a number in wasm, a bigint in ubrn.
const shareId: Conv = {
	ubrn: (value, at) => {
		if (typeof value === "bigint") {
			return value
		}

		if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
			fail(at, "expected a non-negative integer")
		}

		return BigInt(value)
	},
	wasm: (value, at) => {
		if (typeof value !== "bigint" || value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
			fail(at, "expected a bigint within the safe integer range")
		}

		return Number(value)
	}
}

const HEX_DIGITS = "0123456789abcdef"

function hexValue(code: number): number {
	if (code >= 48 && code <= 57) {
		return code - 48
	}

	// Lower-case the letter, then a-f.
	const lower = code | 0x20

	return lower >= 97 && lower <= 102 ? lower - 87 : -1
}

// Blake3 hash: 64 hex chars in wasm, 32 bytes in ubrn.
const hash: Conv = {
	ubrn: (value, at) => {
		if (typeof value !== "string" || value.length !== 64) {
			fail(at, "expected 64 hex characters")
		}

		const bytes = new Uint8Array(32)

		for (let i = 0; i < 32; i++) {
			const high = hexValue(value.charCodeAt(i * 2))
			const low = hexValue(value.charCodeAt(i * 2 + 1))

			if (high < 0 || low < 0) {
				fail(at, "expected 64 hex characters")
			}

			bytes[i] = (high << 4) | low
		}

		return bytes
	},
	wasm: (value, at) => {
		if (!(value instanceof Uint8Array) || value.length !== 32) {
			fail(at, "expected 32 bytes")
		}

		let hex = ""

		for (const byte of value) {
			hex += HEX_DIGITS[byte >> 4]! + HEX_DIGITS[byte & 15]!
		}

		return hex
	}
}

// Undecodable decrypted metadata: number[] in wasm, Uint8Array in ubrn.
const rawBytes: Conv = {
	ubrn: (value, at) => {
		if (!Array.isArray(value)) {
			fail(at, "expected a byte array")
		}

		const bytes = new Uint8Array(value.length)

		for (let i = 0; i < value.length; i++) {
			const byte: unknown = value[i]

			if (typeof byte !== "number" || !Number.isInteger(byte) || byte < 0 || byte > 255) {
				fail(at, "expected a byte array")
			}

			bytes[i] = byte
		}

		return bytes
	},
	wasm: (value, at) => {
		if (!(value instanceof Uint8Array)) {
			fail(at, "expected a Uint8Array")
		}

		return Array.from(value)
	}
}

interface Field {
	conv: Conv
	// The ubrn key where it differs from the wasm one.
	ubrn?: string
	// May be undefined: an omitted wasm key, an undefined ubrn key.
	optional?: true
}

// A record whose fields map one to one. Unknown keys are refused both ways.
function record(fields: Record<string, Field>): Conv {
	const entries = Object.entries(fields).map(([wasm, field]) => ({
		wasm,
		ubrn: field.ubrn ?? wasm,
		conv: field.conv,
		optional: field.optional === true
	}))
	const wasmKeys: ReadonlySet<string> = new Set(entries.map(entry => entry.wasm))
	const ubrnKeys: ReadonlySet<string> = new Set(entries.map(entry => entry.ubrn))

	const refuseUnknown = (obj: Obj, keys: ReadonlySet<string>, at: string): void => {
		for (const key of Object.keys(obj)) {
			if (!keys.has(key)) {
				fail(join(at, key), "unknown field")
			}
		}
	}

	return {
		ubrn: (value, at) => {
			const obj = objectAt(value, at)

			refuseUnknown(obj, wasmKeys, at)

			const out: Obj = {}

			for (const entry of entries) {
				const field = obj[entry.wasm]
				const fieldAt = join(at, entry.wasm)

				if (field === undefined) {
					if (!entry.optional) {
						fail(fieldAt, "missing")
					}

					out[entry.ubrn] = undefined

					continue
				}

				out[entry.ubrn] = entry.conv.ubrn(field, fieldAt)
			}

			return out
		},
		wasm: (value, at) => {
			const obj = objectAt(value, at)

			refuseUnknown(obj, ubrnKeys, at)

			const out: Obj = {}

			for (const entry of entries) {
				const field = obj[entry.ubrn]
				const fieldAt = join(at, entry.ubrn)

				if (field === undefined) {
					if (!entry.optional) {
						fail(fieldAt, "missing")
					}

					continue
				}

				out[entry.wasm] = entry.conv.wasm(field, fieldAt)
			}

			return out
		}
	}
}

// One ubrn variant `{ tag, inner: [value] }`, or `{ tag }` for a unit variant.
function ubrnVariant(value: unknown, at: string): { tag: string; inner: unknown } {
	const obj = objectAt(value, at)
	const tag = obj["tag"]

	if (typeof tag !== "string") {
		fail(join(at, "tag"), "expected a string")
	}

	for (const key of Object.keys(obj)) {
		if (key !== "tag" && key !== "inner") {
			fail(join(at, key), "unknown field")
		}
	}

	return {
		tag,
		inner: obj["inner"]
	}
}

function innerOf(inner: unknown, at: string): unknown {
	if (!Array.isArray(inner) || inner.length !== 1) {
		fail(join(at, "inner"), "expected one value")
	}

	return inner[0]
}

function tagged(tag: string, value: unknown): { tag: string; inner: [unknown] } {
	return {
		tag,
		inner: [value]
	}
}

// A wasm value that is one known variant of an untagged union, as ubrn's tagged variant.
function only(tag: string, conv: Conv): Conv {
	return {
		ubrn: (value, at) => tagged(tag, conv.ubrn(value, at)),
		wasm: (value, at) => {
			const variant = ubrnVariant(value, at)

			if (variant.tag !== tag) {
				fail(join(at, "tag"), `expected ${tag}`)
			}

			return conv.wasm(innerOf(variant.inner, at), join(at, "inner.0"))
		}
	}
}

// wasm `{ type, data }` (data absent on a unit variant) ↔ ubrn `{ tag, inner: [data] }`; null conv = unit variant.
function adjacent(variants: Record<string, { tag: string; conv: Conv | null }>): Conv {
	const byTag = new Map(Object.entries(variants).map(([type, variant]) => [variant.tag, { type, conv: variant.conv }]))

	return {
		ubrn: (value, at) => {
			const obj = objectAt(value, at)
			const type = obj["type"]
			const variant = typeof type === "string" && Object.hasOwn(variants, type) ? variants[type] : undefined

			if (variant === undefined) {
				fail(join(at, "type"), "unknown variant")
			}

			for (const key of Object.keys(obj)) {
				if (key !== "type" && (key !== "data" || variant.conv === null)) {
					fail(join(at, key), "unknown field")
				}
			}

			if (variant.conv === null) {
				return {
					tag: variant.tag
				}
			}

			if (obj["data"] === undefined) {
				fail(join(at, "data"), "missing")
			}

			return tagged(variant.tag, variant.conv.ubrn(obj["data"], join(at, "data")))
		},
		wasm: (value, at) => {
			const { tag, inner } = ubrnVariant(value, at)
			const variant = byTag.get(tag)

			if (variant === undefined) {
				fail(join(at, "tag"), "unknown variant")
			}

			if (variant.conv === null) {
				if (inner !== undefined) {
					fail(join(at, "inner"), "unknown field")
				}

				return {
					type: variant.type
				}
			}

			return {
				type: variant.type,
				data: variant.conv.wasm(innerOf(inner, at), join(at, "inner.0"))
			}
		}
	}
}

// MaybeEncrypted<string>: wasm `{ Decrypted: s } | { Encrypted: s }` ↔ ubrn MaybeEncryptedUniffi.
const maybeEncrypted: Conv = {
	ubrn: (value, at) => {
		const obj = objectAt(value, at)
		const keys = Object.keys(obj)
		const key = keys[0]

		if (keys.length !== 1 || (key !== "Decrypted" && key !== "Encrypted")) {
			fail(at, "expected Decrypted or Encrypted")
		}

		return tagged(key, str.ubrn(obj[key], join(at, key)))
	},
	wasm: (value, at) => {
		const { tag, inner } = ubrnVariant(value, at)

		if (tag !== "Decrypted" && tag !== "Encrypted") {
			fail(join(at, "tag"), "unknown variant")
		}

		return {
			[tag]: str.wasm(innerOf(inner, at), join(at, "inner.0"))
		}
	}
}

const TRASH_PLACEHOLDER = "00000000-0000-0000-0000-000000000000"
const PARENT_SENTINELS: ReadonlyMap<string, string> = new Map([
	["recents", "Recents"],
	["favorites", "Favorites"],
	["links", "Links"]
])

// ParentUuid: a wasm string ↔ ubrn tags. wasm renders a trashed item's parent as "trash" and drops the original
// parent; it reads "trash" back as Trash(nil), and so does this.
const parent: Conv = {
	ubrn: (value, at) => {
		if (typeof value !== "string") {
			fail(at, "expected a string")
		}

		if (value === "trash") {
			return tagged("Trash", TRASH_PLACEHOLDER)
		}

		const sentinel = PARENT_SENTINELS.get(value)

		return sentinel === undefined ? tagged("Uuid", value) : { tag: sentinel }
	},
	wasm: (value, at) => {
		const { tag, inner } = ubrnVariant(value, at)

		switch (tag) {
			case "Uuid": {
				return str.wasm(innerOf(inner, at), join(at, "inner.0"))
			}

			case "Trash": {
				str.wasm(innerOf(inner, at), join(at, "inner.0"))

				return "trash"
			}

			case "Recents":
			case "Favorites":
			case "Links": {
				if (inner !== undefined) {
					fail(join(at, "inner"), "unknown field")
				}

				return tag.toLowerCase()
			}

			default: {
				fail(join(at, "tag"), "unknown variant")
			}
		}
	}
}

const NAMED_COLORS: ReadonlyMap<string, string> = new Map([
	["default", "Default"],
	["blue", "Blue"],
	["green", "Green"],
	["purple", "Purple"],
	["red", "Red"],
	["gray", "Gray"]
])
const COLOR_NAMES: ReadonlyMap<string, string> = new Map(Array.from(NAMED_COLORS, ([name, tag]) => [tag, name]))

// DirColor: a wasm string (a named color, else a custom hex) ↔ ubrn tags with Custom(hex).
const color: Conv = {
	ubrn: (value, at) => {
		if (typeof value !== "string") {
			fail(at, "expected a string")
		}

		const named = NAMED_COLORS.get(value)

		return named === undefined ? tagged("Custom", value) : { tag: named }
	},
	wasm: (value, at) => {
		const { tag, inner } = ubrnVariant(value, at)

		if (tag === "Custom") {
			return str.wasm(innerOf(inner, at), join(at, "inner.0"))
		}

		const name = COLOR_NAMES.get(tag)

		if (name === undefined) {
			fail(join(at, "tag"), "unknown variant")
		}

		if (inner !== undefined) {
			fail(join(at, "inner"), "unknown field")
		}

		return name
	}
}

const shareInfo = record({
	email: { conv: str },
	id: { conv: shareId }
})

// SharingRole: wasm flattens ShareInfo next to `type` (`({ type } & ShareInfo)`); ubrn wraps it.
const SHARING_ROLE_TAGS: ReadonlyMap<unknown, string> = new Map([
	["sharer", "Sharer"],
	["receiver", "Receiver"]
])

const sharingRole: Conv = {
	ubrn: (value, at) => {
		const { type, ...info } = objectAt(value, at)
		const tag = SHARING_ROLE_TAGS.get(type)

		if (tag === undefined) {
			fail(join(at, "type"), "unknown variant")
		}

		return tagged(tag, shareInfo.ubrn(info, at))
	},
	wasm: (value, at) => {
		const { tag, inner } = ubrnVariant(value, at)

		if (tag !== "Sharer" && tag !== "Receiver") {
			fail(join(at, "tag"), "unknown variant")
		}

		return {
			type: tag.toLowerCase(),
			...(shareInfo.wasm(innerOf(inner, at), join(at, "inner.0")) as Obj)
		}
	}
}

const passwordState = adjacent({
	known: { tag: "Known", conv: str },
	hashed: { tag: "Hashed", conv: str },
	none: { tag: "None", conv: null }
})

const decryptedDirMeta = record({
	name: { conv: str },
	created: { conv: big, optional: true }
})

const dirMeta = adjacent({
	decoded: { tag: "Decoded", conv: decryptedDirMeta },
	decryptedRaw: { tag: "DecryptedRaw", conv: rawBytes },
	decryptedUTF8: { tag: "DecryptedUTF8", conv: str },
	encrypted: { tag: "Encrypted", conv: str },
	rSAEncrypted: { tag: "RSAEncrypted", conv: str }
})

const decryptedFileMeta = record({
	name: { conv: str },
	mime: { conv: str },
	created: { conv: big, optional: true },
	modified: { conv: big },
	hash: { conv: hash, optional: true },
	size: { conv: big },
	key: { conv: str },
	version: { conv: encryptionVersion }
})

const fileMeta = adjacent({
	decoded: { tag: "Decoded", conv: decryptedFileMeta },
	decryptedUTF8: { tag: "DecryptedUTF8", conv: str },
	decryptedRaw: { tag: "DecryptedRaw", conv: rawBytes },
	encrypted: { tag: "Encrypted", conv: str },
	rSAEncrypted: { tag: "RSAEncrypted", conv: str }
})

const file = record({
	uuid: { conv: str },
	stableUUID: { conv: str, ubrn: "stableUuid", optional: true },
	meta: { conv: fileMeta },
	parent: { conv: parent },
	size: { conv: big },
	favorited: { conv: bool },
	region: { conv: str },
	bucket: { conv: str },
	timestamp: { conv: big },
	chunks: { conv: big },
	canMakeThumbnail: { conv: bool }
})

const sharedFile = record({
	uuid: { conv: str },
	size: { conv: big },
	region: { conv: str },
	bucket: { conv: str },
	chunks: { conv: big },
	timestamp: { conv: big },
	meta: { conv: fileMeta },
	sharingRole: { conv: sharingRole },
	sharedTag: { conv: bool },
	canMakeThumbnail: { conv: bool }
})

const linkedFile = record({
	uuid: { conv: str },
	name: { conv: maybeEncrypted },
	mime: { conv: maybeEncrypted },
	size: { conv: big },
	chunks: { conv: big },
	region: { conv: str },
	bucket: { conv: str },
	version: { conv: encryptionVersion },
	timestamp: { conv: big },
	fileKey: { conv: str },
	downloadable: { conv: bool },
	linkedTag: { conv: bool },
	canMakeThumbnail: { conv: bool }
})

const root = record({
	uuid: { conv: str }
})

const dir = record({
	uuid: { conv: str },
	parent: { conv: parent },
	color: { conv: color },
	timestamp: { conv: big },
	favorited: { conv: bool },
	meta: { conv: dirMeta }
})

const rootDirWithMeta = record({
	uuid: { conv: str },
	color: { conv: color },
	timestamp: { conv: big },
	meta: { conv: dirMeta }
})

const sharedDir = record({
	inner: { conv: dir },
	sharedTag: { conv: bool }
})

const sharedRootDir = record({
	inner: { conv: rootDirWithMeta },
	sharingRole: { conv: sharingRole },
	writeAccess: { conv: bool }
})

const linkedDir = record({
	inner: { conv: dir },
	linkedTag: { conv: bool }
})

const linkedRootDir = record({
	inner: { conv: rootDirWithMeta },
	linkedTag: { conv: bool }
})

const dirPublicLink = record({
	linkUuid: { conv: str },
	linkKey: { conv: str },
	linkKeyVersion: { conv: u8 },
	password: { conv: passwordState },
	enableDownload: { conv: bool },
	salt: { conv: str }
})

function sharedWithContext(tag: "Dir" | "Root", conv: Conv): Conv {
	return only(
		"Shared",
		record({
			dir: { conv: only(tag, conv) },
			shareInfo: { conv: sharingRole }
		})
	)
}

function linkedWithContext(tag: "Dir" | "Root", conv: Conv): Conv {
	return only(
		"Linked",
		record({
			dir: { conv: only(tag, conv) },
			link: { conv: dirPublicLink }
		})
	)
}

const VARIANTS: Readonly<Record<DesktopSdkVariant, Conv>> = {
	"AnyFile.File": only("File", file),
	"AnyFile.Shared": only("Shared", sharedFile),
	"AnyFile.Linked": only("Linked", linkedFile),
	"AnyNormalDir.Dir": only("Dir", dir),
	"AnyNormalDir.Root": only("Root", root),
	"AnyDirWithContext.Normal.Dir": only("Normal", only("Dir", dir)),
	"AnyDirWithContext.Normal.Root": only("Normal", only("Root", root)),
	"AnyDirWithContext.Shared.Dir": sharedWithContext("Dir", sharedDir),
	"AnyDirWithContext.Shared.Root": sharedWithContext("Root", sharedRootDir),
	"AnyDirWithContext.Linked.Dir": linkedWithContext("Dir", linkedDir),
	"AnyDirWithContext.Linked.Root": linkedWithContext("Root", linkedRootDir)
}

// The wasm value the page sent, as the ubrn value napi takes for that variant.
export function ubrnOf(variant: DesktopSdkVariant, wasm: unknown): unknown {
	const conv = Object.hasOwn(VARIANTS, variant) ? VARIANTS[variant] : undefined

	if (conv === undefined) {
		fail("", "unknown variant")
	}

	return conv.ubrn(wasm, "")
}

// A File (napi uploadFile) or Dir (napi createDir) as the wasm shape the page holds.
export function wasmOf(kind: "File" | "Dir", ubrn: unknown): unknown {
	return (kind === "File" ? file : dir).wasm(ubrn, "")
}
