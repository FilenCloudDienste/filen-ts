import { create } from "zustand"

// The overlay's unsaved-buffer bit, hoisted out of component state so the sign-out path — a plain lib
// function, not a component — can ask about it and, if it is set, wait for the user's answer BEFORE
// runLogout's wipe touches anything. This is the ONE definition of "a preview has unsaved edits":
// previewOverlay reads `dirty` straight off this store rather than keeping a second copy in useState.
// Single-instance by construction: PreviewOverlay has five render sites (the drive and photos dialog
// hosts, and three chat embed sites), and only one can ever hold an editable buffer — the drive/photos
// hosts are mutually exclusive, while every chat site mounts an external source or the "links" variant,
// neither of which is ever editable. So one flag needs no per-overlay keying.
export interface PreviewUnsavedGuardStore {
	dirty: boolean
	// Set only while a sign-out is waiting on the user; the overlay renders its existing
	// unsaved-changes prompt off this and settles `resolve` exactly once.
	logoutRequest: { resolve: (discard: boolean) => void } | null
	setDirty: (dirty: boolean) => void
	setLogoutRequest: (request: { resolve: (discard: boolean) => void } | null) => void
	// Buffer gone (overlay unmounted, or its slot vanished under it): drop the flag and answer any
	// waiting sign-out with "nothing to lose".
	clear: () => void
}

export const usePreviewUnsavedGuardStore = create<PreviewUnsavedGuardStore>((set, get) => ({
	dirty: false,
	logoutRequest: null,
	setDirty(dirty) {
		set({ dirty })
	},
	setLogoutRequest(request) {
		set({ logoutRequest: request })
	},
	clear() {
		// An overlay that unmounted while a sign-out waited has no buffer left to protect; leaving that
		// promise unsettled would hang the sign-out forever.
		get().logoutRequest?.resolve(true)
		set({ dirty: false, logoutRequest: null })
	}
}))

// Stable module-scope setter — this is what the overlay hands down as `onDirtyChange`, so the prop
// costs no selector and keeps one identity for the editor's own [dirty, onDirtyChange] effect.
export function setPreviewDirty(dirty: boolean): void {
	usePreviewUnsavedGuardStore.getState().setDirty(dirty)
}

// Coalesces two concurrent asks (the account menu and a socket force-logout) onto one prompt and one
// answer, so neither can strand a promise the other settled.
let inFlight: Promise<boolean> | null = null

// Awaited by performLogout before ANY teardown runs. `true` = proceed (nothing dirty, or the user
// chose to discard); `false` = the user cancelled and the session must stay fully intact.
export async function confirmDiscardUnsavedPreview(): Promise<boolean> {
	if (!usePreviewUnsavedGuardStore.getState().dirty) {
		return true
	}

	inFlight ??= new Promise<boolean>(resolve => {
		usePreviewUnsavedGuardStore.getState().setLogoutRequest({ resolve })
	}).finally(() => {
		inFlight = null
	})

	return await inFlight
}

export default usePreviewUnsavedGuardStore
