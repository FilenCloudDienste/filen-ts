import { extensionStart } from "./fileExtensions"

// How an open editor answers a newer version of what it edits, saved elsewhere: another device, another
// tab, another participant, or a version restore. Shared by the web and mobile editors; each maps its own
// item shapes onto these.

// A file version's identity: `uuid` names the version and rotates with every save, `stableUuid` names the
// file across all of them (the SDK's stableUUID; absent where the listing does not report one, as for
// shared-in and public-link files).
export interface RevisionIdentity {
	uuid: string
	stableUuid: string | undefined
}

// Whether `revision` is a newer version of what `displayed` shows. The version already shown is not
// newer: it is the editor's own save, or an event delivered twice. `previousUuid`, when the event names
// the version it replaced (a version restore), covers a file listed without a stable id.
export function isRevisionOf(displayed: RevisionIdentity, revision: RevisionIdentity & { previousUuid?: string | undefined }): boolean {
	if (revision.uuid === displayed.uuid) {
		return false
	}

	return (displayed.stableUuid !== undefined && displayed.stableUuid === revision.stableUuid) || revision.previousUuid === displayed.uuid
}

export type RevisionDecision =
	// Nothing to do: the user already chose to keep their version over this one.
	| { type: "ignore" }
	// The editor's own save is in flight, and the revision may be its echo: judged once the save settles.
	| { type: "hold" }
	// Unsaved edits would be lost: ask.
	| { type: "ask" }
	// Show the new version. `announce` for the one on screen, whose content changes under the user.
	| { type: "show"; announce: boolean }

export function decideRevision(args: {
	// Whether the revision is of what is on screen (a pager keeps others around, off screen).
	current: boolean
	dirty: boolean
	saving: boolean
	// The uuid of the revision the user last chose to keep their edits over.
	keptOver: string | undefined
	revisionUuid: string
}): RevisionDecision {
	if (!args.current) {
		return { type: "show", announce: false }
	}

	if (args.saving) {
		return { type: "hold" }
	}

	if (args.keptOver === args.revisionUuid) {
		return { type: "ignore" }
	}

	return args.dirty ? { type: "ask" } : { type: "show", announce: true }
}

// Sorts the revisions held while the editor's own save was in flight, once it settles. The socket
// delivers versions in the order the server made them, so the save's own echo splits them: those before
// it were replaced by the save (the user is told their save went over them; they stay in version history
// where versioning is on), those after it are newer than the save and are judged like any live revision.
// A failed save made nothing, so every held revision is still newer than what the editor shows. An echo
// that has not arrived yet means every held revision came before the save.
export function settleHeldRevisions<T>(
	held: readonly T[],
	savedUuid: string | null,
	uuidOf: (revision: T) => string
): { replaced: boolean; newer: T[] } {
	if (savedUuid === null) {
		return { replaced: false, newer: [...held] }
	}

	const echo = held.findIndex(revision => uuidOf(revision) === savedUuid)

	if (echo === -1) {
		return { replaced: held.length > 0, newer: [] }
	}

	return { replaced: echo > 0, newer: held.slice(echo + 1) }
}

// The time a conflicted copy is named after: "2026-09-27 14-03". No colons, which Windows rejects in a
// file name, so a copy synced down to a Windows machine keeps its name.
export function conflictCopyStamp(now: Date): string {
	const pad = (value: number) => String(value).padStart(2, "0")

	return `${String(now.getFullYear())}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}-${pad(now.getMinutes())}`
}

// "notes.md" → "notes (conflicted copy 2026-09-27 14-03).md", via the caller's localised `label`, then
// " 2", " 3"… after the time until `taken` says no. The extension keeps its case; a leading dot (a
// dotfile) or a trailing one is not an extension.
export async function conflictCopyName(
	name: string,
	now: Date,
	label: (args: { base: string; date: string; ext: string }) => string,
	taken: (candidate: string) => Promise<boolean>
): Promise<string> {
	const dot = extensionStart(name)
	const ext = dot === -1 ? "" : name.slice(dot)
	const base = dot === -1 ? name : name.slice(0, dot)
	const date = conflictCopyStamp(now)

	for (let attempt = 1; ; attempt++) {
		const candidate = label({ base, date: attempt === 1 ? date : `${date} ${String(attempt)}`, ext })

		if (!(await taken(candidate))) {
			return candidate
		}
	}
}

// What this client recently pushed as each item's content, by hash. A content edit comes back over the
// socket to every session of the account, the pushing one included, and the only way to tell a client's
// own push from the same account editing on another device is to recognise the content. Record before
// the push is sent: its echo can arrive before the push returns. A few per item: pushes a debounce apart
// can echo back after one another, and anything older has long had its echo. Per tab or device: each
// copy consumes the echoes it hears.
export class PushEchoes {
	private readonly pushes = new Map<string, string[]>()
	private readonly maxPerItem: number

	public constructor(maxPerItem = 8) {
		this.maxPerItem = maxPerItem
	}

	public remember(id: string, hash: string): void {
		const hashes = this.pushes.get(id) ?? []

		hashes.push(hash)
		this.pushes.set(id, hashes.slice(-this.maxPerItem))
	}

	// Consumes the match and every older push of the item: each push echoes once, in order, so content
	// pushed here earlier and saved again on another device (a revert) is that device's edit.
	public isOwn(id: string, hash: string): boolean {
		const hashes = this.pushes.get(id)
		const index = hashes?.indexOf(hash) ?? -1

		if (hashes === undefined || index === -1) {
			return false
		}

		if (index === hashes.length - 1) {
			this.pushes.delete(id)
		} else {
			this.pushes.set(id, hashes.slice(index + 1))
		}

		return true
	}

	// A write that failed: its content, should another device save the same, is that device's edit.
	public forget(id: string, hash: string): void {
		const hashes = this.pushes.get(id)
		const index = hashes?.lastIndexOf(hash) ?? -1

		if (hashes === undefined || index === -1) {
			return
		}

		const rest = hashes.filter((_, at) => at !== index)

		if (rest.length === 0) {
			this.pushes.delete(id)
		} else {
			this.pushes.set(id, rest)
		}
	}

	// Sign-out: nothing of the next account's is ours yet.
	public clear(): void {
		this.pushes.clear()
	}
}
