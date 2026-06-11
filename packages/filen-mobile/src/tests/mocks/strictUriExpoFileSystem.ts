/**
 * URI-ENCODING-FAITHFUL mock of expo-file-system for Vitest.
 *
 * The canonical mock (@/tests/mocks/expoFileSystem) joins paths WITHOUT any percent-encoding,
 * so it cannot catch the class of bug where library code bypasses expo's encoding pipeline
 * (regression 2026-06-11: replacing `Paths.join(base, rawName)` with `base + rawName` string
 * concatenation broke every filename containing `[ ] ^ |` on device).
 *
 * This mock reproduces the REAL (patched) expo-file-system 56.0.7 semantics:
 *
 * 1. `Paths.join(first, ...rest)` — and therefore the File/Directory constructors, which are
 *    `super(Paths.join(...uris))` upstream — run every REST argument through the PATCHED
 *    `encodePathChars` (space→%20, %→%25, and — via patches/expo-file-system+56.0.7.patch —
 *    `" < > ` { } [ ] ^ |` + control chars). See node_modules/expo-file-system/src/
 *    pathUtilities/{index,url}.ts.
 * 2. A SINGLE-string `file://` input is parsed like a WHATWG URL: the WHATWG path
 *    percent-encode set (space, `"`, `<`, `>`, backtick, `{`, `}`, `?`, `#`) is encoded, but
 *    `[ ] ^ |` survive RAW — exactly the characters Foundation NSURL / java.net.URI then
 *    reject, which is what makes the on-device stat miss.
 * 3. The backing store is keyed by the FULLY-ENCODED uri (what the native layer sees). A
 *    lookup whose uri carries raw `[ ] ^ |` therefore NEVER matches a properly-stored file —
 *    reproducing the device failure mode byte-for-byte.
 * 4. `.uri` returns the encoded form (real getter contract); `.name` returns the DECODED last
 *    segment (real native behavior — Foundation reports raw filesystem names).
 *
 * Only the API surface the offline lib touches is implemented.
 *
 * Usage:
 *   vi.mock("expo-file-system", async () => await import("@/tests/mocks/strictUriExpoFileSystem"))
 *   import { strictFs } from "@/tests/mocks/strictUriExpoFileSystem"
 */

type Entry = Uint8Array | "dir"

const DOCUMENT_URI = "file:///document"
const CACHE_URI = "file:///cache"
const BUNDLE_URI = "file:///bundle"

/** Backing store, keyed by FULLY-ENCODED uri. */
export const strictFs = new Map<string, Entry>()

// ─── faithful encoding pipeline ──────────────────────────────────────────────

// Port of the PATCHED encodePathChars + encodeURLChars tail (?# handling) from
// expo-file-system/src/pathUtilities/url.ts. Order matters: % first.
function encodeRestSegment(filepath: string): string {
	let out = filepath

	if (out.indexOf("%") !== -1) {
		out = out.replace(/%/g, "%25")
	}

	out = out.replace(/\\/g, "%5C")
	out = out.replace(/\n/g, "%0A")
	out = out.replace(/\r/g, "%0D")
	out = out.replace(/\t/g, "%09")
	out = out.replace(/ /g, "%20")
	out = out.replace(/"/g, "%22")
	out = out.replace(/</g, "%3C")
	out = out.replace(/>/g, "%3E")
	out = out.replace(/`/g, "%60")
	out = out.replace(/\{/g, "%7B")
	out = out.replace(/\}/g, "%7D")
	out = out.replace(/\[/g, "%5B")
	out = out.replace(/\]/g, "%5D")
	out = out.replace(/\^/g, "%5E")
	out = out.replace(/\|/g, "%7C")
	// eslint-disable-next-line no-control-regex
	out = out.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, char => {
		return `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`
	})
	out = out.replace(/\?/g, "%3F")
	out = out.replace(/#/g, "%23")

	return out
}

// WHATWG URL path-state emulation for SINGLE-string file:// inputs: the WHATWG path
// percent-encode set IS encoded (space, ", <, >, backtick, {, }) and ?/# terminate into
// query/fragment (we encode them here — close enough for path-only file URIs the lib builds),
// but `[ ] ^ |` SURVIVE RAW — the native-fatal gap this mock exists to expose.
function whatwgPathEncode(uri: string): string {
	let out = uri

	if (out.indexOf("%") !== -1) {
		// WHATWG keeps existing %XX escapes verbatim (no double-encoding of valid escapes);
		// emulate by leaving % untouched — inputs built by join are already encoded.
	}

	out = out.replace(/ /g, "%20")
	out = out.replace(/"/g, "%22")
	out = out.replace(/</g, "%3C")
	out = out.replace(/>/g, "%3E")
	out = out.replace(/`/g, "%60")
	out = out.replace(/\{/g, "%7B")
	out = out.replace(/\}/g, "%7D")

	// [ ] ^ | deliberately NOT encoded — they reach the "native layer" raw.
	return out
}

function toUriString(value: string | File | Directory): string {
	return typeof value === "string" ? value : value.uri
}

function trimSlashes(part: string, isFirst: boolean): string {
	if (isFirst) {
		return part.replace(/\/+$/, "")
	}

	return part.replace(/^\/+|\/+$/g, "")
}

/** The real join: first segment WHATWG-parsed, rest segments through the patched encoder. */
function joinStrict(parts: (string | File | Directory)[]): string {
	const strings = parts.map(toUriString)
	const first = whatwgPathEncode(trimSlashes(strings[0] ?? "", true))
	const rest = strings
		.slice(1)
		.map(part => encodeRestSegment(trimSlashes(part, false)))
		.filter(part => part.length > 0)

	return rest.length === 0 ? first : `${first}/${rest.join("/")}`
}

function decodeSegment(segment: string): string {
	try {
		return decodeURIComponent(segment)
	} catch {
		return segment
	}
}

function deleteRecursive(uri: string): void {
	if (strictFs.get(uri) === "dir") {
		const prefix = `${uri}/`

		for (const key of [...strictFs.keys()]) {
			if (key.startsWith(prefix)) {
				strictFs.delete(key)
			}
		}
	}

	strictFs.delete(uri)
}

export class File {
	uri: string

	constructor(...uris: (string | File | Directory)[]) {
		// Real constructor is `super(Paths.join(...uris))`.
		this.uri = joinStrict(uris)
	}

	get exists(): boolean {
		return strictFs.get(this.uri) instanceof Uint8Array
	}

	get name(): string {
		const idx = this.uri.lastIndexOf("/")

		return decodeSegment(idx === -1 ? this.uri : this.uri.slice(idx + 1))
	}

	get parentDirectory(): Directory {
		return new Directory(Paths.dirname(this.uri))
	}

	get size(): number {
		const entry = strictFs.get(this.uri)

		return entry instanceof Uint8Array ? entry.length : 0
	}

	get md5(): string | null {
		return this.exists ? "strict-md5" : null
	}

	info(_options?: { md5?: boolean }): { exists: boolean; uri: string; size: number; isDirectory: false } {
		const entry = strictFs.get(this.uri)
		const isFile = entry instanceof Uint8Array

		return {
			exists: isFile,
			uri: this.uri,
			size: isFile ? entry.length : 0,
			isDirectory: false
		}
	}

	async text(): Promise<string> {
		const entry = strictFs.get(this.uri)

		if (!(entry instanceof Uint8Array)) {
			throw new Error(`File not found: ${this.uri}`)
		}

		return new TextDecoder().decode(entry)
	}

	write(content: string | Uint8Array): void {
		strictFs.set(this.uri, typeof content === "string" ? new TextEncoder().encode(content) : content)
	}

	create(_options?: { intermediates?: boolean; overwrite?: boolean }): void {
		if (!this.exists) {
			strictFs.set(this.uri, new Uint8Array([]))
		}
	}

	delete(): void {
		strictFs.delete(this.uri)
	}

	move(destination: File | Directory, options?: { overwrite?: boolean }): void {
		const entry = strictFs.get(this.uri)

		if (!(entry instanceof Uint8Array)) {
			throw new Error(`File not found: ${this.uri}`)
		}

		const destUri = destination instanceof File ? destination.uri : `${destination.uri}/${this.uri.slice(this.uri.lastIndexOf("/") + 1)}`

		if (strictFs.has(destUri) && destUri !== this.uri) {
			if (options?.overwrite !== true) {
				throw new Error(`Destination already exists: ${destUri}`)
			}

			deleteRecursive(destUri)
		}

		strictFs.delete(this.uri)
		strictFs.set(destUri, entry)

		this.uri = destUri
	}

	moveSync(destination: File | Directory, options?: { overwrite?: boolean }): void {
		this.move(destination, options)
	}

	async copy(destination: File | Directory, options?: { overwrite?: boolean }): Promise<void> {
		const entry = strictFs.get(this.uri)

		if (!(entry instanceof Uint8Array)) {
			throw new Error(`File not found: ${this.uri}`)
		}

		const destUri = destination instanceof File ? destination.uri : `${destination.uri}/${this.uri.slice(this.uri.lastIndexOf("/") + 1)}`

		if (strictFs.has(destUri) && options?.overwrite !== true) {
			throw new Error(`Destination already exists: ${destUri}`)
		}

		strictFs.set(destUri, new Uint8Array(entry))
	}

	rename(newName: string): void {
		const dir = this.uri.slice(0, this.uri.lastIndexOf("/"))
		// Real rename goes through the native layer with a RAW name — encode like a rest segment.
		const newUri = `${dir}/${encodeRestSegment(newName)}`
		const entry = strictFs.get(this.uri)

		if (entry instanceof Uint8Array) {
			strictFs.set(newUri, entry)
			strictFs.delete(this.uri)
		}

		this.uri = newUri
	}
}

export class Directory {
	uri: string

	constructor(...uris: (string | File | Directory)[]) {
		this.uri = joinStrict(uris)
	}

	get exists(): boolean {
		return strictFs.get(this.uri) === "dir"
	}

	get name(): string {
		const idx = this.uri.lastIndexOf("/")

		return decodeSegment(idx === -1 ? this.uri : this.uri.slice(idx + 1))
	}

	get parentDirectory(): Directory {
		return new Directory(Paths.dirname(this.uri))
	}

	create(_options?: { intermediates?: boolean; overwrite?: boolean; idempotent?: boolean }): void {
		const schemeEnd = this.uri.indexOf(":///")
		const root = schemeEnd === -1 ? "" : this.uri.slice(0, schemeEnd + 4)
		const segments = this.uri.slice(root.length).split("/")
		let current = root.slice(0, -1)

		for (const segment of segments) {
			current = `${current}/${segment}`

			if (!strictFs.has(current)) {
				strictFs.set(current, "dir")
			}
		}
	}

	delete(): void {
		deleteRecursive(this.uri)
	}

	list(): (File | Directory)[] {
		const prefix = `${this.uri}/`
		const results: (File | Directory)[] = []

		for (const [key, value] of strictFs) {
			if (!key.startsWith(prefix) || key.slice(prefix.length).includes("/")) {
				continue
			}

			// Constructing from the stored (already-encoded) uri must NOT re-encode: real
			// constructors treat a full file:// string as already-parsed. joinStrict's WHATWG
			// emulation is idempotent on encoded input (it never touches %).
			results.push(value === "dir" ? new Directory(key) : new File(key))
		}

		return results
	}

	move(destination: Directory | File, options?: { overwrite?: boolean }): void {
		if (!(destination instanceof Directory)) {
			throw new Error("Cannot copy or move a directory to a file")
		}

		const node = strictFs.get(this.uri)

		if (node !== "dir") {
			throw new Error(`Directory not found: ${this.uri}`)
		}

		const destNode = strictFs.get(destination.uri)
		const destUri = destNode === "dir" ? `${destination.uri}/${this.uri.slice(this.uri.lastIndexOf("/") + 1)}` : destination.uri

		if (strictFs.has(destUri) && destUri !== this.uri) {
			if (options?.overwrite !== true) {
				throw new Error(`Destination already exists: ${destUri}`)
			}

			deleteRecursive(destUri)
		}

		const prefix = `${this.uri}/`

		strictFs.set(destUri, "dir")

		for (const [key, value] of [...strictFs.entries()]) {
			if (key.startsWith(prefix)) {
				strictFs.set(`${destUri}/${key.slice(prefix.length)}`, value)
				strictFs.delete(key)
			}
		}

		strictFs.delete(this.uri)
		this.uri = destUri
	}

	moveSync(destination: Directory | File, options?: { overwrite?: boolean }): void {
		this.move(destination, options)
	}
}

export const Paths = {
	get document(): Directory {
		return new Directory(DOCUMENT_URI)
	},
	get cache(): Directory {
		return new Directory(CACHE_URI)
	},
	get bundle(): Directory {
		return new Directory(BUNDLE_URI)
	},
	get appleSharedContainers(): Record<string, Directory> {
		return new Proxy({} as Record<string, Directory>, {
			get(_target, prop) {
				return new Directory(`file:///shared/${String(prop)}`)
			}
		})
	},
	join(...paths: (string | File | Directory)[]): string {
		return joinStrict(paths)
	},
	dirname(path: string | File | Directory): string {
		const str = toUriString(path)
		let end = str.length

		while (end > 0 && str.charCodeAt(end - 1) === 47) {
			end--
		}

		const idx = str.lastIndexOf("/", end - 1)
		const result = idx === -1 ? "" : str.slice(0, idx)

		if (result.length > 0) {
			return result
		}

		if (str.startsWith("/") && !str.startsWith("file://")) {
			return "/"
		}

		return DOCUMENT_URI
	},
	basename(path: string | File | Directory, ext?: string): string {
		const str = toUriString(path)
		const idx = str.lastIndexOf("/")
		let base = decodeSegment(idx === -1 ? str : str.slice(idx + 1))

		if (ext && base.endsWith(ext)) {
			base = base.slice(0, -ext.length)
		}

		return base
	},
	extname(path: string | File | Directory): string {
		const base = Paths.basename(path)
		const dot = base.lastIndexOf(".")

		return dot === -1 ? "" : base.slice(dot)
	}
}

/** Test helpers. */
export const strictFsHelpers = {
	reset(): void {
		strictFs.clear()
	},
	/** Write a file at a path built like the lib SHOULD build it: encoded rest segments. */
	writeFileAt(base: string, rawRelativePath: string, bytes: Uint8Array): string {
		const uri = joinStrict([base, rawRelativePath])
		// Ensure parent dir chain exists.
		const parent = uri.slice(0, uri.lastIndexOf("/"))

		new Directory(parent).create({
			intermediates: true,
			idempotent: true
		})
		strictFs.set(uri, bytes)

		return uri
	},
	has(uri: string): boolean {
		return strictFs.has(uri)
	}
}
