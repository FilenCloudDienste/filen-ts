import { runLogout } from "@/lib/logout"
import { sync as notesSync } from "@/features/notes/lib/sync"
import { sync as chatsSync } from "@/features/chats/lib/sync"
import { clearAllTyping } from "@/features/chats/lib/typing"
import { detachUnreadBadges } from "@/features/chats/lib/messagesVersion"
import { resetDotFilen } from "@/lib/dotFilen"
import { resetPaletteRecent } from "@/features/palette/lib/paletteRun"
import { resetSocketReconnectState } from "@/features/chats/lib/socketHandlers"
import { socketBridge } from "@/lib/sdk/socket"
import { sdkApi } from "@/lib/sdk/client"
import { wipeSwClient } from "@/features/drive/lib/saveDownload"
import { wipeLegacyWebOnSignOut } from "@/lib/legacyWebMigration"
import { clearSession, broadcastAuth } from "@/lib/sdk/session"
import { kvClear } from "@/lib/storage/adapter"
import { keepKeymapsAcrossWipe } from "@/lib/keymap/storage"
import { wipeImageCaches } from "@/features/shell/lib/wipeImageCaches"
import { resetVideoSession } from "@/features/videos/lib/session"
import { resetDriveKeyframes } from "@/features/drive/lib/thumbGenerators"
import { resetFileKindVerdicts } from "@/features/drive/lib/fileKindVerdicts"
import { watchState } from "@/features/videos/lib/watchState"
import { userDictionary } from "@/features/spellcheck/lib/userDictionary"
import { resetOfficeSettings } from "@/features/office/lib/officeSettings"
import { resetSavedSignatures } from "@/features/pdf/fillSign/savedSignatures"
import { resetPhotosLibrary } from "@/features/photos/lib/library"
import { disposeAudioEngine } from "@/features/audio/lib/audioEngine"
import { cancelActiveTransfers } from "@/features/transfers/lib/control"
import { allowNextUnload } from "@/lib/unloadGuard"
import { clearPreviewCache } from "@/features/preview/lib/previewCache"
import { releaseAllPreviewWorkers } from "@/lib/workers/ownedWorker"
import { clearArchiveListings } from "@/features/archive/lib/listingCache"
import { releaseImageEditWorker } from "@/features/preview/imageEdit/renderClient"
import { releaseVideoEditWorkers } from "@/features/preview/videoEdit/client"
import { useDriveClipboardStore } from "@/features/drive/store/useDriveClipboardStore"
import { clearDirectoryTreeState } from "@/features/drive/store/useDirectoryTreeStore"
import { discardListingPatches } from "@/features/drive/queries/drive"
import { discardUploadClaims } from "@/features/drive/lib/uploadClaims"
import { resetConversationHistory, withHistoryWritesHeld } from "@/features/assistant/store/conversationHistory"
import { shutdownAssistant } from "@/features/assistant/store/assistantSession"
import { confirmDiscardUnsavedPreview, usePreviewUnsavedGuardStore } from "@/features/preview/store/usePreviewUnsavedGuard"
import { queryClient } from "@/queries/client"
import { toast } from "sonner"
import { i18n } from "@/lib/i18n"
import { writeSignOutPending } from "@/lib/signOutPending"
import { showSignOutOverlay } from "@/features/shell/lib/signOutOverlay"
import { confirmMountsSignOut } from "@/features/mounts/lib/mountsStore"

// Resolves once no unsaved preview buffer is left — the overlay dropping its dirty bit (discard, close,
// unmount). Immediate when nothing is dirty.
function awaitPreviewBufferReleased(): Promise<void> {
	if (!usePreviewUnsavedGuardStore.getState().dirty) {
		return Promise.resolve()
	}

	return new Promise(resolve => {
		const unsubscribe = usePreviewUnsavedGuardStore.subscribe(state => {
			if (!state.dirty) {
				unsubscribe()
				resolve()
			}
		})
	})
}

// The sign-out in flight. A second caller joins it rather than raising the prompts again and running a second
// teardown and wipe beside the first. Cleared when it ends without signing out; a sign-out that went through ends in
// a reload.
interface SignOutRun {
	readonly forced: boolean
	// Settles every prompt this run is parked at with "proceed": a caller nobody can answer for (the locked desktop
	// app) joined it.
	readonly discarded: Promise<true>
	discardRequested: boolean
	discard: () => void
	promise: Promise<boolean>
}

let current: SignOutRun | null = null

// Kick both outboxes now rather than waiting on the notes debounce / the chats retry cadence — the
// sign-out confirm calls this as it opens, so anything still queued gets the dialog's dwell to reach the
// server before the teardown below destroys it. Must never run after cancel(): a post-abort pass is the
// straggler flush the wipe order exists to prevent.
export function flushOutboxes(): void {
	notesSync.executeNow()
	chatsSync.executeNow()
	void watchState.executeNow()
}

export interface PerformLogoutOptions {
	// The server has already revoked this session (a password change on another device). The
	// unsaved-preview prompt may then only DELAY the wipe — one chance to copy the text out — never veto
	// it: declining defers the teardown until the buffer is released instead of cancelling it, so a
	// server-dead session can't keep decrypted local state alive indefinitely.
	forced?: boolean
	// Nobody can answer the unsaved-preview prompt (the desktop app is locked and its PIN forgotten): a dirty buffer
	// is dropped with everything else.
	discardUnsaved?: boolean
}

// The single unified sign-out both surfaces drive through: the account menu (user-initiated) and the
// realtime socket's password-changed force-logout — one teardown path, mirroring mobile's lone
// auth.logout(). @/lib/logout stays free of any worker-constructing import so its own node test can
// import it (see runLogout's own note); the real collaborators are wired here instead, at the component
// layer, and injected into runLogout's phased wipe. Resolves `false` — with nothing torn down — only
// when a NON-forced sign-out was declined at the network drive's pending-uploads prompt or the unsaved-preview prompt
// below.
//
// Single-flight: a call while one runs joins it, except that a `discardUnsaved` call first settles whatever prompt the
// running one is parked at, and a forced call behind a user-initiated one runs again if the user cancelled that one —
// the user's Cancel never vetoes a revoked session's sign-out.
export function performLogout(options?: PerformLogoutOptions): Promise<boolean> {
	if (current !== null) {
		if (options?.discardUnsaved === true) {
			current.discard()

			return current.promise
		}

		if (options?.forced === true && !current.forced) {
			return current.promise.then(
				signedOut => signedOut || performLogout(options),
				() => performLogout(options)
			)
		}

		return current.promise
	}

	const discarded = Promise.withResolvers<true>()
	const run: SignOutRun = {
		forced: options?.forced === true || options?.discardUnsaved === true,
		discarded: discarded.promise,
		discardRequested: options?.discardUnsaved === true,
		discard: () => {
			run.discardRequested = true
			discarded.resolve(true)
			// An open unsaved-changes prompt is answered with "discard", which also closes it.
			usePreviewUnsavedGuardStore.getState().logoutRequest?.resolve(true)
			usePreviewUnsavedGuardStore.getState().setLogoutRequest(null)
		},
		promise: Promise.resolve(false)
	}

	current = run
	run.promise = signOut(run).then(
		signedOut => {
			if (!signedOut) {
				current = null
			}

			return signedOut
		},
		(error: unknown) => {
			current = null

			throw error
		}
	)

	return run.promise
}

async function signOut(run: SignOutRun): Promise<boolean> {
	// Desktop: with uploads still in the network drive's cache, the shell asks to wait or to sign out anyway (they then
	// finish at this user's next sign-in). Only a user-initiated sign-out asks; a revoked session cannot upload anyway.
	if (!run.forced && !(await Promise.race([confirmMountsSignOut(), run.discarded]))) {
		return false
	}

	// A dirty preview buffer lives only in memory: the wipe + reload below destroys it with no recovery,
	// so the user answers BEFORE anything is torn down. Cancel leaves a user-initiated sign-out's session
	// completely intact — nothing has run at this point.
	if (!run.discardRequested && !(await Promise.race([confirmDiscardUnsavedPreview(), run.discarded]))) {
		if (!run.forced) {
			return false
		}

		// Says what the generic prompt cannot: the sign-out is not cancelled, only waiting. Persistent —
		// it stays until the wipe's own reload takes the page.
		toast.warning(i18n.t("auth:logoutForcedPending"), { duration: Infinity })

		await Promise.race([awaitPreviewBufferReleased(), run.discarded])
	}

	// Watch progress journaled locally gets its last upload (the one the confirm started, joined here; at most 30 s)
	// before the sign-out flag stops every write.
	await watchState.executeNow()

	// Nothing below can be cancelled any more. The flag lets the next boot finish a wipe this tab does not
	// live to complete (see signOutPending.ts); the overlay covers the wait, which the thumbnail wipe can
	// stretch to seconds.
	writeSignOutPending(true)
	showSignOutOverlay()

	// The assistant first: a running turn's tools would otherwise keep reading (refilling the caches about to
	// be cleared) and playing through the teardown below.
	shutdownAssistant()

	// Notes + chats sync cancel BEFORE the wipe: abort each outbox loop and suppress any further disk
	// write so a late flush can never resurrect this account's plaintext queue after kv-clear lands.
	// Whatever is still queued dies here, so the confirm that leads to this warns about it
	// (useUnsyncedWork) instead of promising it syncs back on the next sign-in.
	notesSync.cancel()
	chatsSync.cancel()
	// Videos watch state likewise: its upload aborts, and the progress it kept in localStorage (which the kv wipe
	// doesn't reach) goes now.
	watchState.cancel()
	// The spelling dictionary's words leave with the account (the spellchecker hears the empty list).
	userDictionary.reset()
	// The document settings likewise, and the saved PDF signatures.
	resetOfficeSettings()
	resetSavedSignatures()
	// The Photos directories likewise.
	resetPhotosLibrary()
	// Uploads, downloads and copies abort before the worker drops its client; the confirm that leads
	// here warned about them (useHasActiveTransfers).
	cancelActiveTransfers()
	// The memoized `.filen` directories name directories the next account cannot write to, and the chat
	// reconnect latch would make the next account's first authSuccess read as a recovery.
	resetDotFilen()
	resetSocketReconnectState()
	// Stop every typing watchdog + wipe the typing store so no timer fires into the cleared session.
	clearAllTyping()
	// A chat write landing after the wipe must not render the rail, which would read its queries back in.
	detachUnreadBadges()
	// Stop playback, revoke the live blob URL, tear down the media element and clear the queue so no
	// audio from this account survives into the next session.
	disposeAudioEngine()
	// Decrypted preview buffers and archive listings (entry names, passwords) held for pager revisits, the image
	// editor's render worker with the picture it was editing, and the video editor's preview worker. The preview registry
	// terminates every other preview worker at once, busy ones included (the raster decoders whose heaps hold this
	// account's decoded photos, the remux worker), and closes whatever else a preview still holds (the ports it serves).
	clearPreviewCache()
	releaseAllPreviewWorkers()
	clearArchiveListings()
	releaseImageEditWorker()
	releaseVideoEditWorkers()
	// Videos probes, artwork and frames held for this account, and the frame worker's heap; the drive's own
	// keyframe thumbnail services and the file-kind verdicts read from content.
	resetVideoSession()
	resetDriveKeyframes()
	resetFileKindVerdicts()
	// The drive clipboard's items and the sidebar tree's expanded directories belong to this account.
	useDriveClipboardStore.getState().clear()
	clearDirectoryTreeState()
	// The command palette's recent rows name this account's items.
	resetPaletteRecent()
	// The assistant's saved conversations: a save still waiting out its delay must not land after the wipe.
	resetConversationHistory()
	// Tear the realtime socket down before the client is released — unsubscribeFromSocket needs the live
	// client. Fire-and-forget: the worker also frees the listener in releaseClient as a backstop.
	void socketBridge.stop()
	// Drive listing creates still queued, and patches kept for listing reads under way.
	discardListingPatches()
	discardUploadClaims()

	await runLogout({
		cancelQueries: () => queryClient.cancelQueries(),
		clearQueryCache: () => {
			queryClient.clear()
		},
		sdkLogout: () => sdkApi.logout(),
		clearSession,
		// A conversation write already past its checks, in any tab, lands before the wipe, never after it. Each
		// account's keyboard shortcuts survive it (keyed by account, so the next account never inherits them).
		kvClear: () => withHistoryWritesHeld(() => keepKeymapsAcrossWipe(kvClear)),
		wipeThumbnails: wipeImageCaches,
		wipeServiceWorker: wipeSwClient,
		wipeLegacyWeb: wipeLegacyWebOnSignOut,
		wipesLanded: () => {
			writeSignOutPending(false)
		},
		broadcast: () => {
			broadcastAuth("logout")
		},
		reload: () => {
			// The transfers were cancelled above; a row still settling must not hold the reload.
			allowNextUnload()
			location.reload()
		}
	})

	return true
}
