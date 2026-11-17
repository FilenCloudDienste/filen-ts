import type { Sqlite3Static, WasmPointer } from "@sqlite.org/sqlite-wasm"
import { patchWalHeader } from "@/features/preview/lib/sqliteBrowse.logic"

// A read-only sqlite VFS over a synchronous range reader (@filen/office's SyncRangeReader on the sync range bridge):
// sqlite reads only the pages it needs, each copied once straight from the bridge's slot ring into sqlite's own
// buffer. The file never sits whole in JS or wasm memory. One main database per registered name; journals, WAL and
// writes are refused, and the database is opened immutable (no locks, no change detection: a snapshot).

export const RANGE_VFS_NAME = "filen-ranged"

// What the VFS reads through: SyncRangeReader's read, which copies up to `length` bytes at `position` into `target`
// at `offset` and answers the count, 0 at the end, or -1 when the read could not complete (aborted, timed out).
export interface SyncByteReader {
	readonly length: number
	read(target: Uint8Array, offset: number, length: number, position: number): number
}

export interface RangeFileState {
	readonly reader: SyncByteReader
	// The header's format versions said WAL (rewritten to rollback in what sqlite reads).
	wal: boolean
	// Bytes read, for a check's progress.
	bytesRead: number
	// The last read failed (abort or deadline): sqlite saw SQLITE_IOERR_READ.
	failed: boolean
}

export interface RangeVfs {
	// Makes `reader` the file sqlite opens as `name` ("file:<name>?vfs=filen-ranged&immutable=1").
	add(name: string, reader: SyncByteReader): RangeFileState
	remove(name: string): void
}

const installed = new WeakMap<Sqlite3Static, RangeVfs>()

// A struct type's byte size (its static structInfo).
function structSize(struct: object): number {
	const info: unknown = Reflect.get(struct, "structInfo")
	const size: unknown = typeof info === "object" && info !== null ? Reflect.get(info, "sizeof") : undefined

	if (typeof size !== "number") {
		throw new Error("the struct type has no size")
	}

	return size
}

// The VFS of this sqlite instance, registered on first use.
export function rangeVfs(sqlite3: Sqlite3Static): RangeVfs {
	const known = installed.get(sqlite3)

	if (known !== undefined) {
		return known
	}

	const { capi, wasm } = sqlite3
	const sources = new Map<string, RangeFileState>()
	const open = new Map<number, RangeFileState>()
	const io = new capi.sqlite3_io_methods()
	const vfs = new capi.sqlite3_vfs()
	const fileOf = (pFile: WasmPointer): RangeFileState | undefined => open.get(pFile)

	// The library's struct members are `$`-prefixed at runtime, whatever its typings name them.
	Reflect.set(io, "$iVersion", 1)
	io.installMethods({
		xClose: (pFile: WasmPointer): number => {
			open.delete(pFile)

			return 0
		},
		xRead: (pFile: WasmPointer, pDest: WasmPointer, n: number, offset: number | bigint): number => {
			const file = fileOf(pFile)

			if (file === undefined) {
				return capi.SQLITE_IOERR_READ
			}

			const destination = pDest
			const position = Number(offset)
			// Re-read on every call: the heap view goes stale when wasm memory grows.
			const heap = wasm.heap8u()
			const read = file.reader.read(heap, destination, n, position)

			if (read < 0) {
				file.failed = true

				return capi.SQLITE_IOERR_READ
			}

			file.bytesRead += read

			if (patchWalHeader(heap, destination, read, position)) {
				file.wal = true
			}

			if (read < n) {
				heap.fill(0, destination + read, destination + n)

				return capi.SQLITE_IOERR_SHORT_READ
			}

			return 0
		},
		xWrite: (): number => capi.SQLITE_READONLY,
		xTruncate: (): number => capi.SQLITE_READONLY,
		xSync: (): number => capi.SQLITE_READONLY,
		xFileSize: (pFile: WasmPointer, pSize: WasmPointer): number => {
			const file = fileOf(pFile)

			if (file === undefined) {
				return capi.SQLITE_IOERR_READ
			}

			wasm.poke64(pSize, BigInt(file.reader.length))

			return 0
		},
		xLock: (): number => 0,
		xUnlock: (): number => 0,
		xCheckReservedLock: (_pFile: WasmPointer, pOut: WasmPointer): number => {
			wasm.poke32(pOut, 0)

			return 0
		},
		xFileControl: (): number => capi.SQLITE_NOTFOUND,
		xSectorSize: (): number => 4096,
		xDeviceCharacteristics: (): number => capi.SQLITE_IOCAP_IMMUTABLE
	})

	vfs.$iVersion = 1
	vfs.$szOsFile = structSize(capi.sqlite3_file)
	vfs.$mxPathname = 512
	vfs.installMethods({
		xOpen: (_pVfs: WasmPointer, zName: WasmPointer, pFile: WasmPointer, flags: number, pOutFlags: WasmPointer): number => {
			const name = zName === 0 ? null : wasm.cstrToJs(zName)
			const source = name === null ? undefined : sources.get(name)

			// The main database only: no journal, WAL, temporary or sub-journal file is ever made or read.
			if (source === undefined || (flags & capi.SQLITE_OPEN_MAIN_DB) === 0) {
				return capi.SQLITE_CANTOPEN
			}

			open.set(pFile, source)

			const file = new capi.sqlite3_file(pFile)

			file.$pMethods = io.pointer
			file.dispose()
			wasm.poke32(pOutFlags, capi.SQLITE_OPEN_READONLY)

			return 0
		},
		xDelete: (): number => capi.SQLITE_READONLY,
		xAccess: (_pVfs: WasmPointer, _zName: WasmPointer, _flags: number, pOut: WasmPointer): number => {
			// Nothing beside the database exists: no -journal, -wal or -shm.
			wasm.poke32(pOut, 0)

			return 0
		},
		xFullPathname: (_pVfs: WasmPointer, zName: WasmPointer, nOut: number, pOut: WasmPointer): number =>
			wasm.cstrncpy(pOut, zName, nOut) < nOut ? 0 : capi.SQLITE_CANTOPEN,
		xRandomness: (_pVfs: WasmPointer, nOut: number, pOut: WasmPointer): number => {
			wasm.heap8u().set(crypto.getRandomValues(new Uint8Array(nOut)), pOut)

			return nOut
		},
		xSleep: (): number => 0,
		xCurrentTime: (_pVfs: WasmPointer, pOut: WasmPointer): number => {
			wasm.poke(pOut, 2440587.5 + Date.now() / 864e5, "double")

			return 0
		},
		xGetLastError: () => undefined
	})
	sqlite3.vfs.installVfs({ vfs: { struct: vfs, name: RANGE_VFS_NAME, methods: {} } })

	const registered: RangeVfs = {
		add: (name, reader) => {
			const state: RangeFileState = { reader, wal: false, bytesRead: 0, failed: false }

			sources.set(name, state)

			return state
		},
		remove: name => {
			sources.delete(name)
		}
	}

	installed.set(sqlite3, registered)

	return registered
}
