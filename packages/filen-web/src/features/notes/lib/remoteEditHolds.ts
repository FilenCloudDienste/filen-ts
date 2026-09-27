// Notes whose remote-edit dialog is open in some tab: the push loop must not send the local edits over
// the version the user is still deciding about. The dialog can be in a follower tab while the leader
// pushes, so the hold is a shared Web Lock per note: every tab sees it (LockManager.query), and it is
// released with the tab that took it, so a tab closed mid-dialog never stalls the note's sync.
const LOCK_PREFIX = "filen-web-notes-remote-edit:"

const releases = new Map<string, () => void>()

export function holdNoteForRemoteEdit(uuid: string): void {
	if (releases.has(uuid)) {
		return
	}

	let release = (): void => undefined
	const held = new Promise<void>(resolve => {
		release = resolve
	})

	releases.set(uuid, release)

	// Shared: several tabs may show the same note's dialog.
	void navigator.locks.request(`${LOCK_PREFIX}${uuid}`, { mode: "shared" }, () => held)
}

export function releaseNoteHold(uuid: string): void {
	releases.get(uuid)?.()
	releases.delete(uuid)
}

export function releaseAllNoteHolds(): void {
	for (const release of releases.values()) {
		release()
	}

	releases.clear()
}

// This tab's holds first: a lock just requested may not be listed by the query yet.
export async function heldNotes(): Promise<Set<string>> {
	const held = new Set(releases.keys())
	const snapshot = await navigator.locks.query()

	for (const lock of [...(snapshot.held ?? []), ...(snapshot.pending ?? [])]) {
		if (lock.name?.startsWith(LOCK_PREFIX) === true) {
			held.add(lock.name.slice(LOCK_PREFIX.length))
		}
	}

	return held
}
