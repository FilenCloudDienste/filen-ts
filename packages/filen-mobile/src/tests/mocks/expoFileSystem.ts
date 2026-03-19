/**
 * In-memory mock of expo-file-system for Vitest.
 *
 * 1:1 mock of the real expo-file-system API (v55), backed by an in-memory
 * Map<string, Uint8Array | "dir">. All methods that exist on the real
 * File, Directory, and Paths classes are implemented here.
 *
 * Usage in test files:
 *
 *   vi.mock("expo-file-system", async () => await import("@/tests/mocks/expoFileSystem"))
 *
 *   import { fs } from "@/tests/mocks/expoFileSystem"
 *
 *   beforeEach(() => fs.clear())
 *
 *   fs.set("file:///document/test.bin", new Uint8Array([1, 2, 3]))
 */

type Entry = Uint8Array | "dir"

const DOCUMENT_URI = "file:///document"
const CACHE_URI = "file:///cache"
const BUNDLE_URI = "file:///bundle"

/** The backing store — shared singleton across all tests in the same file. */
export const fs = new Map<string, Entry>()

/** Resolve a variadic constructor arg to a URI string. */
function resolveUri(...uris: (string | File | Directory)[]): string {
	return uris
		.map(u => (typeof u === "string" ? u : u.uri))
		.map((p, i) => (i === 0 ? p.replace(/\/+$/, "") : p.replace(/^\/+|\/+$/g, "")))
		.filter(Boolean)
		.join("/")
}

export class File {
	uri: string

	constructor(...uris: (string | File | Directory)[]) {
		this.uri = resolveUri(...uris)
	}

	get exists(): boolean {
		return fs.get(this.uri) instanceof Uint8Array
	}

	get parentDirectory(): Directory {
		return new Directory(Paths.dirname(this.uri))
	}

	get name(): string {
		return this.uri.split("/").pop() ?? ""
	}

	get extension(): string {
		const name = this.name
		const dot = name.lastIndexOf(".")

		return dot === -1 ? "" : name.slice(dot)
	}

	get size(): number {
		const entry = fs.get(this.uri)

		return entry instanceof Uint8Array ? entry.length : 0
	}

	get md5(): string | null {
		return this.exists ? "mock-md5" : null
	}

	get modificationTime(): number | null {
		return this.exists ? Date.now() : null
	}

	get creationTime(): number | null {
		return this.exists ? Date.now() : null
	}

	get type(): string {
		return this.exists ? "application/octet-stream" : ""
	}

	get contentUri(): string {
		return this.uri
	}

	async bytes(): Promise<Uint8Array> {
		return this.bytesSync()
	}

	bytesSync(): Uint8Array {
		const entry = fs.get(this.uri)

		if (!(entry instanceof Uint8Array)) {
			throw new Error(`File not found: ${this.uri}`)
		}

		return entry
	}

	async text(): Promise<string> {
		return this.textSync()
	}

	textSync(): string {
		return new TextDecoder().decode(this.bytesSync())
	}

	async base64(): Promise<string> {
		return this.base64Sync()
	}

	base64Sync(): string {
		const bytes = this.bytesSync()
		let binary = ""

		for (let i = 0; i < bytes.length; i++) {
			binary += String.fromCharCode(bytes[i] as number)
		}

		return btoa(binary)
	}

	write(content: string | Uint8Array, _options?: { encoding?: string; append?: boolean }): void {
		if (typeof content === "string") {
			fs.set(this.uri, new TextEncoder().encode(content))
		} else {
			fs.set(this.uri, content)
		}
	}

	create(_options?: { intermediates?: boolean; overwrite?: boolean }): void {
		if (!this.exists) {
			fs.set(this.uri, new Uint8Array([]))
		}
	}

	delete(): void {
		fs.delete(this.uri)
	}

	copy(destination: File | Directory): void {
		const entry = fs.get(this.uri)

		if (!(entry instanceof Uint8Array)) {
			throw new Error(`File not found: ${this.uri}`)
		}

		const destUri = destination instanceof File ? destination.uri : Paths.join(destination.uri, this.name)

		fs.set(destUri, new Uint8Array(entry))
	}

	move(destination: File | Directory): void {
		this.copy(destination)
		this.delete()

		this.uri = destination instanceof File ? destination.uri : Paths.join(destination.uri, this.name)
	}

	rename(newName: string): void {
		const dir = Paths.dirname(this.uri)
		const newUri = Paths.join(dir, newName)
		const entry = fs.get(this.uri)

		if (entry instanceof Uint8Array) {
			fs.set(newUri, entry)
			fs.delete(this.uri)
		}

		this.uri = newUri
	}

	info(): { exists: boolean; uri: string; size: number; isDirectory: false } {
		return {
			exists: this.exists,
			uri: this.uri,
			size: this.size,
			isDirectory: false
		}
	}

	open(): {
		close: () => void
		readBytes: (length: number) => Uint8Array
		writeBytes: (bytes: Uint8Array) => void
		offset: number | null
		size: number | null
	} {
		const entry = fs.get(this.uri)
		let offset = 0

		return {
			close() {},
			readBytes(length: number) {
				if (!(entry instanceof Uint8Array)) {
					throw new Error("File not found")
				}

				const chunk = entry.slice(offset, offset + length)

				offset += length

				return chunk
			},
			writeBytes(_bytes: Uint8Array) {},
			get offset() {
				return offset
			},
			get size() {
				return entry instanceof Uint8Array ? entry.length : null
			}
		}
	}

	readableStream(): ReadableStream<Uint8Array> {
		const entry = fs.get(this.uri)

		return new ReadableStream({
			start(controller) {
				if (entry instanceof Uint8Array) {
					controller.enqueue(entry)
				}

				controller.close()
			}
		})
	}

	writableStream(): WritableStream<Uint8Array> {
		const uri = this.uri

		return new WritableStream({
			write(chunk) {
				fs.set(uri, chunk)
			}
		})
	}

	async arrayBuffer(): Promise<ArrayBuffer> {
		const bytes = await this.bytes()

		return bytes.buffer as ArrayBuffer
	}

	stream(): ReadableStream<Uint8Array> {
		return this.readableStream()
	}

	slice(start?: number, end?: number, contentType?: string): Blob {
		const entry = fs.get(this.uri)

		if (!(entry instanceof Uint8Array)) {
			return new Blob([], {
				type: contentType
			})
		}

		return new Blob([entry.slice(start, end)], {
			type: contentType
		})
	}

	validatePath(): void {}

	static async downloadFileAsync(
		url: string,
		destination: Directory | File,
		_options?: { headers?: Record<string, string>; idempotent?: boolean }
	): Promise<File> {
		const destFile =
			destination instanceof File ? destination : new File(Paths.join(destination.uri, url.split("/").pop() ?? "download"))

		destFile.write(new Uint8Array([]))

		return destFile
	}

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	static async pickFileAsync(_initialUri?: string, _mimeType?: string): Promise<any> {
		return new File(`${DOCUMENT_URI}/picked-file`)
	}
}

export class Directory {
	uri: string

	constructor(...uris: (string | File | Directory)[]) {
		this.uri = resolveUri(...uris)
	}

	get exists(): boolean {
		return fs.get(this.uri) === "dir"
	}

	get parentDirectory(): Directory {
		return new Directory(Paths.dirname(this.uri))
	}

	get name(): string {
		return this.uri.split("/").pop() ?? ""
	}

	get size(): number | null {
		if (!this.exists) {
			return null
		}

		const prefix = this.uri.endsWith("/") ? this.uri : `${this.uri}/`
		let total = 0

		for (const [key, value] of fs) {
			if (key.startsWith(prefix) && value instanceof Uint8Array) {
				total += value.length
			}
		}

		return total
	}

	create(_options?: { intermediates?: boolean; overwrite?: boolean; idempotent?: boolean }): void {
		const knownBases = [CACHE_URI, DOCUMENT_URI, BUNDLE_URI]
		const base = knownBases.find(b => this.uri.startsWith(b + "/") || this.uri === b)

		if (base) {
			const relative = this.uri.slice(base.length + 1)

			if (!relative) {
				fs.set(this.uri, "dir")

				return
			}

			const parts = relative.split("/")
			let current = base

			for (const part of parts) {
				current = `${current}/${part}`

				if (!fs.has(current)) {
					fs.set(current, "dir")
				}
			}

			return
		}

		// For paths outside known bases (e.g. shared containers), create from the scheme root
		const schemeEnd = this.uri.indexOf(":///")

		if (schemeEnd === -1) {
			fs.set(this.uri, "dir")

			return
		}

		const root = this.uri.slice(0, schemeEnd + 4)
		const segments = this.uri.slice(root.length).split("/")
		let current = root.slice(0, -1)

		for (const segment of segments) {
			current = `${current}/${segment}`

			if (!fs.has(current)) {
				fs.set(current, "dir")
			}
		}
	}

	delete(): void {
		const prefix = this.uri.endsWith("/") ? this.uri : `${this.uri}/`

		for (const key of [...fs.keys()]) {
			if (key === this.uri || key.startsWith(prefix)) {
				fs.delete(key)
			}
		}
	}

	list(): (File | Directory)[] {
		const prefix = this.uri.endsWith("/") ? this.uri : `${this.uri}/`
		const results: (File | Directory)[] = []

		for (const [key, value] of fs) {
			if (!key.startsWith(prefix)) {
				continue
			}

			const relative = key.slice(prefix.length)

			if (relative.includes("/")) {
				continue
			}

			results.push(value === "dir" ? new Directory(key) : new File(key))
		}

		return results
	}

	info(): { exists: boolean; uri: string; isDirectory: true } {
		return {
			exists: this.exists,
			uri: this.uri,
			isDirectory: true
		}
	}

	copy(destination: Directory | File): void {
		const destUri = destination instanceof Directory ? Paths.join(destination.uri, this.name) : destination.uri
		const prefix = this.uri.endsWith("/") ? this.uri : `${this.uri}/`

		fs.set(destUri, "dir")

		for (const [key, value] of fs) {
			if (key.startsWith(prefix)) {
				const relative = key.slice(this.uri.length)

				fs.set(`${destUri}${relative}`, value instanceof Uint8Array ? new Uint8Array(value) : value)
			}
		}
	}

	move(destination: Directory | File): void {
		this.copy(destination)
		this.delete()

		this.uri = destination instanceof Directory ? Paths.join(destination.uri, this.name) : destination.uri
	}

	rename(newName: string): void {
		const parent = Paths.dirname(this.uri)
		const newUri = Paths.join(parent, newName)
		const prefix = this.uri.endsWith("/") ? this.uri : `${this.uri}/`

		fs.set(newUri, "dir")

		for (const [key, value] of [...fs.entries()]) {
			if (key.startsWith(prefix)) {
				const relative = key.slice(this.uri.length)

				fs.set(`${newUri}${relative}`, value)
				fs.delete(key)
			}
		}

		fs.delete(this.uri)
		this.uri = newUri
	}

	createFile(name: string, _mimeType: string | null): File {
		return new File(Paths.join(this.uri, name))
	}

	createDirectory(name: string): Directory {
		return new Directory(Paths.join(this.uri, name))
	}

	listAsRecords(): { isDirectory: string; uri: string }[] {
		return this.list().map(item => ({
			isDirectory: item instanceof Directory ? "true" : "false",
			uri: item.uri
		}))
	}

	validatePath(): void {}

	static async pickDirectoryAsync(_initialUri?: string): Promise<Directory> {
		return new Directory(`${DOCUMENT_URI}/picked-directory`)
	}
}

function toUriString(path: string | File | Directory): string {
	return typeof path === "string" ? path : path.uri
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
	get totalDiskSpace(): number {
		return 256 * 1024 * 1024 * 1024
	},
	get availableDiskSpace(): number {
		return 128 * 1024 * 1024 * 1024
	},
	join(...paths: (string | File | Directory)[]): string {
		return paths
			.map(p => toUriString(p))
			.map((p, i) => (i === 0 ? p.replace(/\/+$/, "") : p.replace(/^\/+|\/+$/g, "")))
			.filter(Boolean)
			.join("/")
	},
	relative(from: string | File | Directory, to: string | File | Directory): string {
		const fromStr = toUriString(from)
		const toStr = toUriString(to)
		const fromParts = fromStr.split("/")
		const toParts = toStr.split("/")
		let common = 0

		while (common < fromParts.length && common < toParts.length && fromParts[common] === toParts[common]) {
			common++
		}

		const ups = fromParts.length - common
		const rest = toParts.slice(common)

		return [...Array<string>(ups).fill(".."), ...rest].join("/")
	},
	isAbsolute(path: string | File | Directory): boolean {
		return toUriString(path).startsWith("file://") || toUriString(path).startsWith("/")
	},
	normalize(path: string | File | Directory): string {
		return toUriString(path).replace(/\/+/g, "/").replace(/\/$/, "")
	},
	dirname(path: string | File | Directory): string {
		const str = toUriString(path)
		const result = str.replace(/\/[^/]+\/?$/, "")

		if (result) {
			return result
		}

		// For POSIX paths like "/foo", dirname is "/"
		if (str.startsWith("/") && !str.startsWith("file://")) {
			return "/"
		}

		return DOCUMENT_URI
	},
	basename(path: string | File | Directory, ext?: string): string {
		const str = toUriString(path)
		let base = str.split("/").pop() ?? ""

		if (ext && base.endsWith(ext)) {
			base = base.slice(0, -ext.length)
		}

		return base
	},
	extname(path: string | File | Directory): string {
		const base = Paths.basename(path)
		const dot = base.lastIndexOf(".")

		return dot === -1 ? "" : base.slice(dot)
	},
	parse(path: string | File | Directory): { root: string; dir: string; base: string; ext: string; name: string } {
		const str = toUriString(path)
		const dir = Paths.dirname(str)
		const base = Paths.basename(str)
		const ext = Paths.extname(str)
		const name = ext ? base.slice(0, -ext.length) : base

		return { root: "file:///", dir, base, ext, name }
	},
	info(...uris: string[]): { exists: boolean; type: "file" | "directory" | null } {
		const uri = uris.join("/")
		const entry = fs.get(uri)

		if (entry === "dir") {
			return { exists: true, type: "directory" }
		}

		if (entry instanceof Uint8Array) {
			return { exists: true, type: "file" }
		}

		return { exists: false, type: null }
	}
}
