import { tooLarge } from "../presentation/refusal"
import { DEFAULT_PPT_BUDGETS, malformed, recordAt, RT, u16, u32, type PptBudgets } from "./records"

// The persist object directory of a PowerPoint Document stream ([MS-PPT] §2.1.2, §2.3.2–§2.3.6, §3.2–§3.3): the
// Current User stream names the newest UserEditAtom; each edit's PersistDirectoryAtom maps persist ids to stream
// offsets, and the chain of edits (offsetLastEdit) is walked to the first one, a newer edit's entry winning per id.
// The stream is never scanned record by record: incremental saves leave dead records a linear walk derails on.

// §2.3.2 headerToken.
export const ENCRYPTED_TOKEN = 0xf3d1c4df

export interface CurrentUser {
	readonly headerToken: number
	readonly offsetToCurrentEdit: number
}

export interface UserEdit {
	readonly offset: number
	readonly lastSlideIdRef: number
	readonly offsetLastEdit: number
	readonly offsetPersistDirectory: number
	readonly docPersistIdRef: number
	// 0 when the field is absent (§2.3.3: recLen 0x1C).
	readonly encryptSessionPersistIdRef: number
}

export interface PersistDirectory {
	// Persist id → offset of the persist object in the stream.
	readonly offsets: ReadonlyMap<number, number>
	// The newest edit first.
	readonly edits: readonly UserEdit[]
	readonly current: UserEdit
}

// §2.3.2 CurrentUserAtom, the only record of the Current User stream.
export function readCurrentUser(stream: Uint8Array): CurrentUser {
	const record = recordAt(stream, 0)

	if (record.type !== RT.currentUserAtom || record.end - record.start < 12) malformed("the Current User stream holds no CurrentUserAtom")

	return { headerToken: u32(stream, record.start + 4), offsetToCurrentEdit: u32(stream, record.start + 8) }
}

function readUserEdit(stream: Uint8Array, offset: number): UserEdit {
	const record = recordAt(stream, offset)

	if (record.type !== RT.userEditAtom || record.end - record.start < 0x1c) malformed(`no UserEditAtom at ${String(offset)}`)

	const at = record.start

	return {
		offset,
		lastSlideIdRef: u32(stream, at),
		offsetLastEdit: u32(stream, at + 8),
		offsetPersistDirectory: u32(stream, at + 12),
		docPersistIdRef: u32(stream, at + 16),
		encryptSessionPersistIdRef: record.end - record.start >= 0x20 ? u32(stream, at + 28) : 0
	}
}

// §2.3.4–§2.3.6: entries of (persistId:20, cPersist:12) and cPersist offsets. Returns the entries read so far across
// the chain: the budget counts every entry walked, not distinct ids, so edits repeating one directory stay bounded.
function readDirectory(stream: Uint8Array, offset: number, into: Map<number, number>, budgets: PptBudgets, read: number): number {
	const record = recordAt(stream, offset)

	if (record.type !== RT.persistDirectoryAtom) malformed(`no PersistDirectoryAtom at ${String(offset)}`)

	for (let at = record.start; at + 4 <= record.end;) {
		const entry = u32(stream, at)
		const first = entry & 0xfffff
		const count = entry >>> 20

		at += 4

		if (at + 4 * count > record.end) malformed("a PersistDirectoryEntry runs past its atom")

		read += count

		if (read > budgets.persistIds) tooLarge("ppt persist ids", budgets.persistIds)

		for (let k = 0; k < count; k++) into.set(first + k, u32(stream, at + 4 * k))

		at += 4 * count
	}

	return read
}

// The directory as the newest edit sees it.
export function readPersistDirectory(stream: Uint8Array, user: CurrentUser, budgets: PptBudgets = DEFAULT_PPT_BUDGETS): PersistDirectory {
	const edits: UserEdit[] = []
	const seen = new Set<number>()

	for (let offset = user.offsetToCurrentEdit; ;) {
		if (seen.has(offset)) malformed("the UserEditAtom chain loops")
		if (edits.length >= budgets.userEdits) tooLarge("ppt user edits", budgets.userEdits)

		seen.add(offset)

		const edit = readUserEdit(stream, offset)

		edits.push(edit)

		if (edit.offsetLastEdit === 0) break

		offset = edit.offsetLastEdit
	}

	// A directory several edits name holds the same entries each time, so only its newest use counts: applying it
	// there gives what re-applying it at every use gives.
	const directories = new Set<number>()
	const newest: UserEdit[] = []

	for (const edit of edits) {
		if (directories.has(edit.offsetPersistDirectory)) continue

		directories.add(edit.offsetPersistDirectory)
		newest.push(edit)
	}

	const offsets = new Map<number, number>()
	let read = 0

	// Oldest first, so a newer edit's offset replaces an older one (§3.3 step 8).
	for (let k = newest.length - 1; k >= 0; k--) {
		const edit = newest[k]

		if (edit !== undefined) read = readDirectory(stream, edit.offsetPersistDirectory, offsets, budgets, read)
	}

	const current = edits[0]

	if (current === undefined) malformed("no UserEditAtom")

	return { offsets, edits, current }
}

// The record header of a persist object, read from the (possibly still encrypted) stream: callers decrypt first.
export function persistOffset(directory: PersistDirectory, id: number): number | undefined {
	return directory.offsets.get(id)
}

// Whether the newest edit names an encryption session ([MS-PPT] §2.3.7: it MUST in an encrypted file).
export function isEncryptedEdit(directory: PersistDirectory): boolean {
	return directory.current.encryptSessionPersistIdRef !== 0 && directory.offsets.has(directory.current.encryptSessionPersistIdRef)
}

// The two-byte record type at `offset` (the record headers of an encrypted stream are encrypted too).
export function typeAt(stream: Uint8Array, offset: number): number {
	return u16(stream, offset + 2)
}
