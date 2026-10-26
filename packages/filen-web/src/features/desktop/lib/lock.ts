import { create } from "zustand"
import type { DesktopLockStatus } from "@filen/shared/desktop"
import { desktopBridge } from "@/lib/desktop"
import { log } from "@/lib/log"
import { performLogout } from "@/features/shell/lib/performLogout"

interface DesktopLockState {
	// null until main answered; always null in a browser.
	status: DesktopLockStatus | null
	// The app's content has been shown once (unlocked at least once): from then on a lock covers it instead of
	// unmounting it, so unsaved work survives.
	revealed: boolean
	// A forgotten-PIN sign-out is under way: the cover stays up until its reload, whatever main reports.
	signingOut: boolean
}

// This page's mirror of the desktop shell's app lock; main owns the PIN, the backoff and the locked state.
export const useDesktopLock = create<DesktopLockState>(() => ({ status: null, revealed: false, signingOut: false }))

// The page cannot tell why main did not answer, so it treats the PIN as unreadable: locked, with a retry and a
// sign-out, never open.
const UNANSWERED: DesktopLockStatus = { enabled: true, locked: true, unreadable: true, retryAt: null }

function apply(status: DesktopLockStatus): void {
	useDesktopLock.setState(state => ({ status, revealed: state.revealed || (!status.locked && !state.signingOut) }))
}

let watching = false

// Reads the status (main reads an unreadable PIN again on each read) and, the first time, follows main's changes.
export async function refreshDesktopLock(): Promise<void> {
	const bridge = desktopBridge()

	if (bridge === undefined) {
		return
	}

	if (!watching) {
		watching = true
		bridge.lock.onChanged(apply)
	}

	try {
		apply(await bridge.lock.status())
	} catch (error) {
		log.error("desktop", "app lock status could not be read", error)
		apply(UNANSWERED)
	}
}

export function isDesktopLocked(): boolean {
	const { status, signingOut } = useDesktopLock.getState()

	return signingOut || status?.locked === true
}

// A forgotten PIN: main drops the session and the PIN, then this page signs out like any sign-out, without the
// unsaved-preview prompt nobody could answer behind the lock. Rejects, with everything still in place, when main
// cannot remove the session.
export async function signOutFromLock(): Promise<void> {
	const bridge = desktopBridge()

	if (bridge === undefined) {
		return
	}

	useDesktopLock.setState({ signingOut: true })

	try {
		await bridge.lock.reset()
	} catch (error) {
		useDesktopLock.setState({ signingOut: false })

		throw error
	}

	await performLogout({ forced: true, discardUnsaved: true })
}
