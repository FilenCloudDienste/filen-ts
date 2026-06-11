/**
 * High-performance in-memory mock of expo-file-system for BENCHMARKS.
 *
 * The canonical mock (@/tests/mocks/expoFileSystem) backs everything with one flat
 * Map and pays O(total fs entries) for every list()/delete() — fine for unit tests,
 * but it drowns the signal when benchmarking library code against thousands of
 * files. This mock is a hierarchical node tree: O(depth) resolution, O(children)
 * list(), O(1) subtree detach.
 *
 * It also counts operations per category (exported `fsOpCounts`) so benchmarks can
 * report "native FS calls" as an efficiency metric — on device every one of these
 * is a JS→native hop.
 *
 * Only the API surface used by the offline lib stack (offline.ts, fsAtomic, tmp,
 * fsUtils, storageRoots) is implemented. Semantics mirror the canonical mock and
 * the real expo-file-system v56 behavior it verified (never-overwrite relocation,
 * unix-mv directory move, mkdir -p create).
 *
 * Usage:
 *   vi.mock("expo-file-system", async () => await import("@/tests/mocks/fastExpoFileSystem"))
 *   import { benchFs } from "@/tests/mocks/fastExpoFileSystem"
 */

type FileNode = {
	file: true
	size: number
	text: string | null
}

type DirNode = {
	file: false
	children: Map<string, FileNode | DirNode>
}

type Node = FileNode | DirNode

const DOCUMENT_URI = "file:///document"
const CACHE_URI = "file:///cache"
const BUNDLE_URI = "file:///bundle"

const ROOT: DirNode = {
	file: false,
	children: new Map()
}

export const fsOpCounts = {
	stat: 0,
	list: 0,
	read: 0,
	write: 0,
	create: 0,
	delete: 0,
	move: 0
}

export function resetFsOpCounts(): void {
	fsOpCounts.stat = 0
	fsOpCounts.list = 0
	fsOpCounts.read = 0
	fsOpCounts.write = 0
	fsOpCounts.create = 0
	fsOpCounts.delete = 0
	fsOpCounts.move = 0
}

export function snapshotFsOpCounts(): typeof fsOpCounts {
	return {
		stat: fsOpCounts.stat,
		list: fsOpCounts.list,
		read: fsOpCounts.read,
		write: fsOpCounts.write,
		create: fsOpCounts.create,
		delete: fsOpCounts.delete,
		move: fsOpCounts.move
	}
}

/** Split a file:/// uri (or absolute path) into segments, dropping empties. */
function segmentsOf(uri: string): string[] {
	let path = uri

	if (path.startsWith("file://")) {
		path = path.slice(7)
	}

	const parts = path.split("/")
	const out: string[] = []

	for (let i = 0; i < parts.length; i++) {
		const part = parts[i]

		if (part !== undefined && part.length > 0) {
			out.push(part)
		}
	}

	return out
}

function lookup(uri: string): Node | undefined {
	const segs = segmentsOf(uri)
	let node: Node = ROOT

	for (let i = 0; i < segs.length; i++) {
		if (node.file) {
			return undefined
		}

		const next = node.children.get(segs[i] as string)

		if (!next) {
			return undefined
		}

		node = next
	}

	return node
}

/** mkdir -p down to the parent of the final segment; returns [parentDir, name]. */
function ensureParent(uri: string): [DirNode, string] {
	const segs = segmentsOf(uri)

	if (segs.length === 0) {
		throw new Error(`Invalid uri: ${uri}`)
	}

	let node: DirNode = ROOT

	for (let i = 0; i < segs.length - 1; i++) {
		const seg = segs[i] as string
		const next = node.children.get(seg)

		if (next === undefined) {
			const created: DirNode = {
				file: false,
				children: new Map()
			}

			node.children.set(seg, created)
			node = created
		} else if (next.file) {
			throw new Error(`Not a directory: ${seg} in ${uri}`)
		} else {
			node = next
		}
	}

	return [node, segs[segs.length - 1] as string]
}

function detach(uri: string): Node | undefined {
	const [parent, name] = ensureParent(uri)
	const node = parent.children.get(name)

	if (node !== undefined) {
		parent.children.delete(name)
	}

	return node
}

function attach(uri: string, node: Node): void {
	const [parent, name] = ensureParent(uri)

	parent.children.set(name, node)
}

/** Mirrors the canonical mock's resolveUri/Paths.join semantics exactly. */
function joinParts(parts: string[]): string {
	let out = ""

	for (let i = 0; i < parts.length; i++) {
		let part = parts[i] as string

		if (i === 0) {
			// Trim trailing slashes only.
			let end = part.length

			while (end > 0 && part.charCodeAt(end - 1) === 47) {
				end--
			}

			part = part.slice(0, end)
		} else {
			// Trim leading + trailing slashes.
			let start = 0
			let end = part.length

			while (start < end && part.charCodeAt(start) === 47) {
				start++
			}

			while (end > start && part.charCodeAt(end - 1) === 47) {
				end--
			}

			part = part.slice(start, end)
		}

		if (part.length === 0) {
			continue
		}

		out = out.length === 0 ? part : `${out}/${part}`
	}

	return out
}

function toUriString(value: string | File | Directory): string {
	return typeof value === "string" ? value : value.uri
}

function resolveUri(uris: (string | File | Directory)[]): string {
	if (uris.length === 1) {
		const only = uris[0] as string | File | Directory

		if (typeof only === "string") {
			// Fast path: single already-clean string (no trailing slash).
			if (only.charCodeAt(only.length - 1) !== 47) {
				return only
			}
		} else {
			return only.uri
		}
	}

	const parts = new Array<string>(uris.length)

	for (let i = 0; i < uris.length; i++) {
		parts[i] = toUriString(uris[i] as string | File | Directory)
	}

	return joinParts(parts)
}

const textEncoder = new TextEncoder()

export class File {
	uri: string

	constructor(...uris: (string | File | Directory)[]) {
		this.uri = resolveUri(uris)
	}

	get exists(): boolean {
		fsOpCounts.stat++

		const node = lookup(this.uri)

		return node !== undefined && node.file
	}

	get parentDirectory(): Directory {
		return new Directory(Paths.dirname(this.uri))
	}

	get name(): string {
		const idx = this.uri.lastIndexOf("/")

		return idx === -1 ? this.uri : this.uri.slice(idx + 1)
	}

	get size(): number {
		fsOpCounts.stat++

		const node = lookup(this.uri)

		return node !== undefined && node.file ? node.size : 0
	}

	async text(): Promise<string> {
		return this.textSync()
	}

	textSync(): string {
		fsOpCounts.read++

		const node = lookup(this.uri)

		if (node === undefined || !node.file) {
			throw new Error(`File not found: ${this.uri}`)
		}

		return node.text ?? ""
	}

	async bytes(): Promise<Uint8Array> {
		fsOpCounts.read++

		const node = lookup(this.uri)

		if (node === undefined || !node.file) {
			throw new Error(`File not found: ${this.uri}`)
		}

		return node.text !== null ? textEncoder.encode(node.text) : new Uint8Array(node.size)
	}

	write(content: string | Uint8Array, _options?: { encoding?: string; append?: boolean }): void {
		fsOpCounts.write++

		if (typeof content === "string") {
			attach(this.uri, {
				file: true,
				size: textEncoder.encode(content).length,
				text: content
			})
		} else {
			attach(this.uri, {
				file: true,
				size: content.length,
				text: null
			})
		}
	}

	create(_options?: { intermediates?: boolean; overwrite?: boolean }): void {
		fsOpCounts.create++

		const node = lookup(this.uri)

		if (node === undefined) {
			attach(this.uri, {
				file: true,
				size: 0,
				text: ""
			})
		}
	}

	delete(): void {
		fsOpCounts.delete++
		detach(this.uri)
	}

	move(destination: File | Directory, options?: { overwrite?: boolean }): void {
		fsOpCounts.move++

		const node = lookup(this.uri)

		if (node === undefined || !node.file) {
			throw new Error(`File not found: ${this.uri}`)
		}

		const destUri = destination instanceof File ? destination.uri : Paths.join(destination.uri, this.name)
		const destNode = lookup(destUri)

		if (destNode !== undefined) {
			if (options?.overwrite !== true) {
				throw new Error(`Destination already exists: ${destUri}`)
			}

			detach(destUri)
		}

		detach(this.uri)
		attach(destUri, node)

		this.uri = destUri
	}

	moveSync(destination: File | Directory, options?: { overwrite?: boolean }): void {
		this.move(destination, options)
	}

	info(_options?: { md5?: boolean }): { exists: boolean; uri: string; size: number; isDirectory: false } {
		fsOpCounts.stat++

		const node = lookup(this.uri)
		const isFile = node !== undefined && node.file

		return {
			exists: isFile,
			uri: this.uri,
			size: isFile && node.file ? node.size : 0,
			isDirectory: false
		}
	}

	rename(newName: string): void {
		fsOpCounts.move++

		const dir = Paths.dirname(this.uri)
		const newUri = Paths.join(dir, newName)
		const node = lookup(this.uri)

		if (node !== undefined && node.file) {
			detach(this.uri)
			attach(newUri, node)
		}

		this.uri = newUri
	}
}

export class Directory {
	uri: string

	constructor(...uris: (string | File | Directory)[]) {
		this.uri = resolveUri(uris)
	}

	get exists(): boolean {
		fsOpCounts.stat++

		const node = lookup(this.uri)

		return node !== undefined && !node.file
	}

	get parentDirectory(): Directory {
		return new Directory(Paths.dirname(this.uri))
	}

	get name(): string {
		const idx = this.uri.lastIndexOf("/")

		return idx === -1 ? this.uri : this.uri.slice(idx + 1)
	}

	create(_options?: { intermediates?: boolean; overwrite?: boolean; idempotent?: boolean }): void {
		fsOpCounts.create++

		const segs = segmentsOf(this.uri)
		let node: DirNode = ROOT

		for (let i = 0; i < segs.length; i++) {
			const seg = segs[i] as string
			const next = node.children.get(seg)

			if (next === undefined) {
				const created: DirNode = {
					file: false,
					children: new Map()
				}

				node.children.set(seg, created)
				node = created
			} else if (next.file) {
				throw new Error(`Cannot create directory over file: ${this.uri}`)
			} else {
				node = next
			}
		}
	}

	delete(): void {
		fsOpCounts.delete++
		detach(this.uri)
	}

	list(): (File | Directory)[] {
		fsOpCounts.list++

		const node = lookup(this.uri)

		if (node === undefined || node.file) {
			return []
		}

		const out = new Array<File | Directory>(node.children.size)
		const base = this.uri
		let i = 0

		for (const [name, child] of node.children) {
			out[i++] = child.file ? new File(`${base}/${name}`) : new Directory(`${base}/${name}`)
		}

		return out
	}

	move(destination: Directory | File, options?: { overwrite?: boolean }): void {
		fsOpCounts.move++

		if (!(destination instanceof Directory)) {
			throw new Error("Cannot copy or move a directory to a file")
		}

		const node = lookup(this.uri)

		if (node === undefined || node.file) {
			throw new Error(`Directory not found: ${this.uri}`)
		}

		// Unix mv semantics: existing destination dir → move INTO it; else exact path.
		const destNode = lookup(destination.uri)
		const destUri = destNode !== undefined && !destNode.file ? Paths.join(destination.uri, this.name) : destination.uri
		const occupant = lookup(destUri)

		if (occupant !== undefined && occupant !== node) {
			if (options?.overwrite !== true) {
				throw new Error(`Destination already exists: ${destUri}`)
			}

			detach(destUri)
		}

		detach(this.uri)
		attach(destUri, node)

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
		if (paths.length === 2) {
			// Hot two-arg fast path: base is already clean in this stack.
			const a = toUriString(paths[0] as string | File | Directory)
			const b = toUriString(paths[1] as string | File | Directory)

			if (
				a.length > 0 &&
				b.length > 0 &&
				a.charCodeAt(a.length - 1) !== 47 &&
				b.charCodeAt(0) !== 47 &&
				b.charCodeAt(b.length - 1) !== 47
			) {
				return `${a}/${b}`
			}
		}

		const parts = new Array<string>(paths.length)

		for (let i = 0; i < paths.length; i++) {
			parts[i] = toUriString(paths[i] as string | File | Directory)
		}

		return joinParts(parts)
	},
	dirname(path: string | File | Directory): string {
		const str = toUriString(path)
		// Mirror the canonical mock: strip the final /segment (with optional trailing slash).
		let end = str.length

		while (end > 0 && str.charCodeAt(end - 1) === 47) {
			end--
		}

		const idx = str.lastIndexOf("/", end - 1)
		const result = idx === -1 ? "" : str.slice(0, idx)

		if (result.length > 0) {
			return result
		}

		if (str.charCodeAt(0) === 47 && !str.startsWith("file://")) {
			return "/"
		}

		return DOCUMENT_URI
	},
	basename(path: string | File | Directory, ext?: string): string {
		const str = toUriString(path)
		const idx = str.lastIndexOf("/")
		let base = idx === -1 ? str : str.slice(idx + 1)

		if (ext && base.endsWith(ext)) {
			base = base.slice(0, -ext.length)
		}

		return base
	}
}

/** Benchmark fixture helpers — bypass the public API (and its op counters). */
export const benchFs = {
	reset(): void {
		ROOT.children.clear()
		resetFsOpCounts()
	},
	mkdirp(uri: string): void {
		const segs = segmentsOf(uri)
		let node: DirNode = ROOT

		for (let i = 0; i < segs.length; i++) {
			const seg = segs[i] as string
			const next = node.children.get(seg)

			if (next === undefined) {
				const created: DirNode = {
					file: false,
					children: new Map()
				}

				node.children.set(seg, created)
				node = created
			} else if (next.file) {
				throw new Error(`Not a directory: ${uri}`)
			} else {
				node = next
			}
		}
	},
	writeFile(uri: string, size: number, text: string | null = null): void {
		attach(uri, {
			file: true,
			size,
			text
		})
	},
	deletePath(uri: string): void {
		detach(uri)
	},
	exists(uri: string): boolean {
		return lookup(uri) !== undefined
	},
	isFile(uri: string): boolean {
		const node = lookup(uri)

		return node !== undefined && node.file
	},
	fileSize(uri: string): number {
		const node = lookup(uri)

		return node !== undefined && node.file ? node.size : -1
	},
	readText(uri: string): string | null {
		const node = lookup(uri)

		return node !== undefined && node.file ? node.text : null
	},
	countEntries(uri: string): number {
		const node = lookup(uri)

		if (node === undefined) {
			return 0
		}

		if (node.file) {
			return 1
		}

		let count = 0
		const stack: DirNode[] = [node]

		while (stack.length > 0) {
			const current = stack.pop() as DirNode

			for (const child of current.children.values()) {
				count++

				if (!child.file) {
					stack.push(child)
				}
			}
		}

		return count
	}
}
