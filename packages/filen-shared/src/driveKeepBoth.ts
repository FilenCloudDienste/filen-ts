import { nameCollisionKey } from "./driveItem"
import { utf8Length, utf8Prefix } from "./utf8"

// The drive's name length limit in UTF-8 bytes (sdk-rs MAX_BYTES).
const MAX_NAME_BYTES = 255
// A counter ` (n)` continues only while n + 1 fits the SDK's u64.
const MAX_COUNTER = 18446744073709551615n

// `name` as the SDK's keep-both naming (sdk-rs fs/name/keep_both) gives it in a directory holding `taken` (collision
// keys, nameCollisionKey): the name itself when free, else `stem (n).ext` with the smallest free n. A file keeps its
// last extension apart ("a.tar.gz" → "a.tar (1).gz"; a leading dot is no extension); a directory is numbered whole. A
// name already ending in ` (n)` continues from n + 1. The base is cut at a character boundary to stay within 255 bytes,
// the extension folded into it when it leaves no room for the base's first character. NFC, as the SDK stores names.
// The caller adds the result's key to `taken` when it allocates several names in one directory.
export function driveKeepBothName({
	name,
	isDirectory,
	taken
}: {
	name: string
	isDirectory: boolean
	taken: ReadonlySet<string>
}): string {
	const normalized = name.normalize("NFC")

	if (!taken.has(nameCollisionKey(normalized))) {
		return normalized
	}

	const dot = isDirectory ? -1 : normalized.lastIndexOf(".")
	const stem = dot > 0 ? normalized.slice(0, dot) : normalized
	const extension = dot > 0 ? normalized.slice(dot) : ""
	const counter = stripCounter(stem)
	let base = counter?.base ?? stem
	let n = counter?.next ?? 1n

	for (;;) {
		const candidate = numberedCandidate(base, n, extension)

		if (!taken.has(nameCollisionKey(candidate))) {
			return candidate
		}

		if (n === MAX_COUNTER) {
			base = stem
			n = 1n
		} else {
			n++
		}
	}
}

// A trailing ` (n)` split off `stem` when a non-empty base precedes it and n + 1 still fits: the base and n + 1.
function stripCounter(stem: string): { base: string; next: bigint } | undefined {
	if (!stem.endsWith(")")) {
		return undefined
	}

	const open = stem.lastIndexOf(" (")

	if (open <= 0) {
		return undefined
	}

	const digits = stem.slice(open + 2, -1)

	if (digits.length === 0 || !/^[0-9]+$/.test(digits)) {
		return undefined
	}

	const n = BigInt(digits)

	return n >= MAX_COUNTER ? undefined : { base: stem.slice(0, open), next: n + 1n }
}

// `base (n)ext` within MAX_NAME_BYTES: the base cut first; an extension that leaves no room for the base's first
// character is folded into the base and cut with it.
function numberedCandidate(base: string, n: bigint, extension: string): string {
	const suffix = ` (${n.toString()})`
	const budget = MAX_NAME_BYTES - utf8Length(suffix) - utf8Length(extension)

	if (budget > 0 && utf8Prefix(base, budget).length > 0) {
		return `${utf8Prefix(base, budget)}${suffix}${extension}`
	}

	return `${utf8Prefix(base + extension, MAX_NAME_BYTES - utf8Length(suffix))}${suffix}`
}
