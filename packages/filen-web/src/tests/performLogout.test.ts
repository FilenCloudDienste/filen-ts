import { beforeEach, describe, expect, it, vi } from "vitest"
import type { LogoutDeps } from "@/lib/logout"

// Every teardown collaborator is worker- or DOM-backed; the phased wipe itself is runLogout's own test
// (logout.test.ts). What matters here is WHEN — and whether — performLogout reaches it.
//
// Each collaborator records its own name in `calls` before doing anything else, so the ORDER assertions
// below read one array instead of comparing invocation counters: the security property is that every
// plaintext producer is silenced BEFORE the wipe, not merely that each was called at some point.
const {
	calls,
	runLogout,
	notesCancel,
	chatsCancel,
	watchStateCancel,
	watchStateExecuteNow,
	cancelActiveTransfers,
	clearAllTyping,
	detachUnreadBadges,
	disposeAudioEngine,
	releaseImageEditWorker,
	resetConversationHistory,
	shutdownAssistant,
	withHistoryWritesHeld,
	socketStop,
	toastWarning,
	wipeThumbnailStore,
	wipeLinkThumbnailStore,
	wipeArtStore,
	wipeVideoIndexStore,
	resetVideoSession,
	officeSettingsReset,
	savedSignaturesReset,
	confirmMountsSignOut,
	wipeLegacyWebOnSignOut,
	writeSignOutPending,
	showSignOutOverlay,
	userDictionaryReset,
	resetPhotosLibrary,
	resetDotFilen,
	resetSocketReconnectState,
	releaseVideoEditWorkers,
	resetDriveKeyframes,
	resetFileKindVerdicts,
	discardListingPatches
} = vi.hoisted(() => {
	const calls: string[] = []
	const record =
		<T>(name: string, result: () => T) =>
		() => {
			calls.push(name)

			return result()
		}

	return {
		calls,
		runLogout: vi.fn<(deps: LogoutDeps) => Promise<void>>(record("runLogout", () => Promise.resolve())),
		notesCancel: vi.fn(record("notesSync.cancel", () => undefined)),
		chatsCancel: vi.fn(record("chatsSync.cancel", () => undefined)),
		watchStateCancel: vi.fn(record("watchState.cancel", () => undefined)),
		watchStateExecuteNow: vi.fn(record("watchState.executeNow", () => Promise.resolve())),
		cancelActiveTransfers: vi.fn(record("cancelActiveTransfers", () => undefined)),
		clearAllTyping: vi.fn(record("clearAllTyping", () => undefined)),
		detachUnreadBadges: vi.fn(record("detachUnreadBadges", () => undefined)),
		disposeAudioEngine: vi.fn(record("disposeAudioEngine", () => undefined)),
		releaseImageEditWorker: vi.fn(record("releaseImageEditWorker", () => undefined)),
		resetConversationHistory: vi.fn(record("resetConversationHistory", () => undefined)),
		shutdownAssistant: vi.fn(record("shutdownAssistant", () => undefined)),
		withHistoryWritesHeld: vi.fn((task: () => Promise<void>) => {
			calls.push("withHistoryWritesHeld")

			return task()
		}),
		socketStop: vi.fn(record("socketBridge.stop", () => Promise.resolve())),
		toastWarning: vi.fn(),
		wipeThumbnailStore: vi.fn(() => Promise.resolve()),
		wipeLinkThumbnailStore: vi.fn(() => Promise.resolve()),
		wipeArtStore: vi.fn(() => Promise.resolve()),
		wipeVideoIndexStore: vi.fn(() => Promise.resolve()),
		resetVideoSession: vi.fn(record("resetVideoSession", () => undefined)),
		officeSettingsReset: vi.fn(),
		savedSignaturesReset: vi.fn(),
		confirmMountsSignOut: vi.fn(() => Promise.resolve(true)),
		wipeLegacyWebOnSignOut: vi.fn(() => Promise.resolve()),
		// Node has no localStorage, so the real writer is a silent no-op: mocked to be seen.
		writeSignOutPending: vi.fn((pending: boolean) => {
			calls.push(`writeSignOutPending(${String(pending)})`)
		}),
		// The rest record, then call through to the real module (wired in each vi.mock below).
		showSignOutOverlay: vi.fn(record("showSignOutOverlay", () => undefined)),
		userDictionaryReset: vi.fn(record("userDictionary.reset", () => undefined)),
		resetPhotosLibrary: vi.fn(record("resetPhotosLibrary", () => undefined)),
		resetDotFilen: vi.fn(record("resetDotFilen", () => undefined)),
		resetSocketReconnectState: vi.fn(record("resetSocketReconnectState", () => undefined)),
		releaseVideoEditWorkers: vi.fn(record("releaseVideoEditWorkers", () => undefined)),
		resetDriveKeyframes: vi.fn(record("resetDriveKeyframes", () => undefined)),
		resetFileKindVerdicts: vi.fn(record("resetFileKindVerdicts", () => undefined)),
		discardListingPatches: vi.fn(record("discardListingPatches", () => undefined))
	}
})

// Every step that must run before the wipe, in the order performLogout runs them.
const TEARDOWN_STEPS = [
	// Journaled watch progress gets its last upload while writes are still allowed.
	"watchState.executeNow",
	// A tab closed mid-wipe leaves the next boot this flag to finish the wipe with.
	"writeSignOutPending(true)",
	"showSignOutOverlay",
	// No assistant tool may read, navigate or play while the rest winds down.
	"shutdownAssistant",
	"notesSync.cancel",
	"chatsSync.cancel",
	"watchState.cancel",
	// kv-backed writers: a write landing after kv-clear would put this account's data back on disk.
	"userDictionary.reset",
	"resetPhotosLibrary",
	"cancelActiveTransfers",
	"resetDotFilen",
	"resetSocketReconnectState",
	"clearAllTyping",
	"detachUnreadBadges",
	"disposeAudioEngine",
	"releaseImageEditWorker",
	"releaseVideoEditWorkers",
	"resetVideoSession",
	"resetDriveKeyframes",
	"resetFileKindVerdicts",
	"resetConversationHistory",
	"socketBridge.stop",
	"discardListingPatches"
]

vi.mock("@/lib/logout", () => ({ runLogout }))
vi.mock("@/lib/legacyWebMigration", () => ({ wipeLegacyWebOnSignOut }))
vi.mock("@/features/notes/lib/sync", () => ({ sync: { cancel: notesCancel } }))
vi.mock("@/features/chats/lib/sync", () => ({ sync: { cancel: chatsCancel } }))
vi.mock("@/features/chats/lib/typing", () => ({ clearAllTyping }))
vi.mock("@/features/chats/lib/messagesVersion", () => ({ detachUnreadBadges }))
vi.mock("@/features/transfers/lib/control", () => ({ cancelActiveTransfers }))
vi.mock("@/lib/sdk/socket", () => ({ socketBridge: { stop: socketStop } }))
vi.mock("@/lib/sdk/client", () => ({ sdkApi: { logout: vi.fn() } }))
vi.mock("@/features/drive/lib/saveDownload", () => ({ wipeSwClient: vi.fn() }))
vi.mock("@/lib/sdk/session", () => ({ clearSession: vi.fn(), broadcastAuth: vi.fn() }))
vi.mock("@/lib/storage/adapter", () => ({
	kvClear: vi.fn(),
	kvGetJson: () => Promise.resolve(null),
	kvSetJson: () => Promise.resolve(),
	kvKeys: () => Promise.resolve([]),
	kvEntriesJson: () => Promise.resolve([]),
	kvEntriesJsonInSlices: () => Promise.resolve([]),
	kvDelete: () => Promise.resolve()
}))
vi.mock("@/features/drive/lib/thumbCache", () => ({ wipeThumbnailStore, readThumbnailBlob: vi.fn(), deleteThumbnail: vi.fn() }))
vi.mock("@/features/publicLinks/lib/thumbCache", () => ({ wipeLinkThumbnailStore }))
vi.mock("@/features/videos/lib/artStore", () => ({ wipeArtStore }))
vi.mock("@/features/videos/lib/indexStore", () => ({ wipeVideoIndexStore }))
vi.mock("@/features/videos/lib/session", () => ({ resetVideoSession }))
vi.mock("@/features/videos/lib/watchState", () => ({ watchState: { cancel: watchStateCancel, executeNow: watchStateExecuteNow } }))
vi.mock("@/features/audio/lib/audioEngine", () => ({ disposeAudioEngine }))
vi.mock("@/features/assistant/store/conversationHistory", () => ({ resetConversationHistory, withHistoryWritesHeld }))
vi.mock("@/features/assistant/store/assistantSession", () => ({ shutdownAssistant }))
vi.mock("@/features/preview/lib/rasterDecode", () => ({ transformHeicBytesOwned: vi.fn() }))
vi.mock("@/features/preview/imageEdit/renderClient", () => ({ releaseImageEditWorker }))
vi.mock("@/queries/client", () => ({ queryClient: { cancelQueries: vi.fn(), clear: vi.fn() } }))
vi.mock("sonner", () => ({ toast: { warning: toastWarning } }))
vi.mock("@/features/office/lib/officeSettings", () => ({ resetOfficeSettings: officeSettingsReset }))
vi.mock("@/features/pdf/fillSign/savedSignatures", () => ({ resetSavedSignatures: savedSignaturesReset }))
vi.mock("@/features/mounts/lib/mountsStore", () => ({ confirmMountsSignOut }))
vi.mock("@/lib/signOutPending", async importOriginal => ({
	...(await importOriginal<typeof import("@/lib/signOutPending")>()),
	writeSignOutPending
}))
vi.mock("@/features/shell/lib/signOutOverlay", async importOriginal => {
	const original = await importOriginal<typeof import("@/features/shell/lib/signOutOverlay")>()

	return {
		...original,
		showSignOutOverlay: () => {
			showSignOutOverlay()
			original.showSignOutOverlay()
		}
	}
})
vi.mock("@/features/spellcheck/lib/userDictionary", async importOriginal => {
	const original = await importOriginal<typeof import("@/features/spellcheck/lib/userDictionary")>()
	const reset = original.userDictionary.reset.bind(original.userDictionary)

	original.userDictionary.reset = () => {
		userDictionaryReset()
		reset()
	}

	return original
})
vi.mock("@/features/photos/lib/library", async importOriginal => {
	const original = await importOriginal<typeof import("@/features/photos/lib/library")>()

	return {
		...original,
		resetPhotosLibrary: () => {
			resetPhotosLibrary()
			original.resetPhotosLibrary()
		}
	}
})
vi.mock("@/lib/dotFilen", async importOriginal => {
	const original = await importOriginal<typeof import("@/lib/dotFilen")>()

	return {
		...original,
		resetDotFilen: () => {
			resetDotFilen()
			original.resetDotFilen()
		}
	}
})
vi.mock("@/features/chats/lib/socketHandlers", async importOriginal => {
	const original = await importOriginal<typeof import("@/features/chats/lib/socketHandlers")>()

	return {
		...original,
		resetSocketReconnectState: () => {
			resetSocketReconnectState()
			original.resetSocketReconnectState()
		}
	}
})
vi.mock("@/features/preview/videoEdit/client", async importOriginal => {
	const original = await importOriginal<typeof import("@/features/preview/videoEdit/client")>()

	return {
		...original,
		releaseVideoEditWorkers: () => {
			releaseVideoEditWorkers()
			original.releaseVideoEditWorkers()
		}
	}
})
vi.mock("@/features/drive/lib/thumbGenerators", async importOriginal => {
	const original = await importOriginal<typeof import("@/features/drive/lib/thumbGenerators")>()

	return {
		...original,
		resetDriveKeyframes: () => {
			resetDriveKeyframes()
			original.resetDriveKeyframes()
		}
	}
})
vi.mock("@/features/drive/lib/fileKindVerdicts", async importOriginal => {
	const original = await importOriginal<typeof import("@/features/drive/lib/fileKindVerdicts")>()

	return {
		...original,
		resetFileKindVerdicts: () => {
			resetFileKindVerdicts()
			original.resetFileKindVerdicts()
		}
	}
})
vi.mock("@/features/drive/queries/drive", async importOriginal => {
	const original = await importOriginal<typeof import("@/features/drive/queries/drive")>()

	return {
		...original,
		discardListingPatches: () => {
			discardListingPatches()
			original.discardListingPatches()
		}
	}
})

import type { CachedListing } from "@/features/archive/lib/listingCache"

// performLogout is single-flight at module scope, and a sign-out that went through keeps its latch (a reload follows),
// so every test gets fresh copies of it and of the real modules it shares state with.
async function loadModules() {
	vi.resetModules()

	return {
		...(await import("@/lib/storage/adapter")),
		...(await import("@/features/drive/lib/saveDownload")),
		...(await import("@/features/preview/store/usePreviewUnsavedGuard")),
		...(await import("@/features/shell/lib/performLogout")),
		...(await import("@/lib/unloadGuard")),
		...(await import("@/features/drive/store/useDriveClipboardStore")),
		...(await import("@/features/drive/store/useDirectoryTreeStore")),
		...(await import("@/features/preview/lib/previewCache")),
		...(await import("@/lib/workers/previewDisposers")),
		...(await import("@/features/archive/lib/listingCache")),
		...(await import("@/features/archive/lib/entryStore"))
	}
}

let modules: Awaited<ReturnType<typeof loadModules>>

// Stands in for the overlay's unsaved-changes prompt: waits for the request the guard armed, then
// answers it the way a Cancel click does.
async function declinePrompt(): Promise<void> {
	await vi.waitFor(() => {
		expect(modules.usePreviewUnsavedGuardStore.getState().logoutRequest).not.toBeNull()
	})

	const request = modules.usePreviewUnsavedGuardStore.getState().logoutRequest

	request?.resolve(false)
	modules.usePreviewUnsavedGuardStore.getState().setLogoutRequest(null)
}

async function settleMicrotasks(): Promise<void> {
	for (let i = 0; i < 5; i++) {
		await Promise.resolve()
	}
}

beforeEach(async () => {
	vi.clearAllMocks()
	calls.length = 0
	modules = await loadModules()
	modules.usePreviewUnsavedGuardStore.setState({ dirty: false, logoutRequest: null })
})

function performLogout(...args: Parameters<typeof modules.performLogout>): ReturnType<typeof modules.performLogout> {
	return modules.performLogout(...args)
}

describe("performLogout", () => {
	it("runs the wipe straight away when no preview buffer is dirty", async () => {
		await expect(performLogout()).resolves.toBe(true)
		expect(runLogout).toHaveBeenCalledTimes(1)
	})

	it("wipes kv only while holding the assistant history's write lock", async () => {
		await performLogout()
		calls.length = 0
		await runLogout.mock.calls[0]?.[0].kvClear()

		expect(calls).toEqual(["withHistoryWritesHeld"])
		expect(modules.kvClear).toHaveBeenCalledTimes(1)
	})

	it("hands the wipe every OPFS cache: drive and public link thumbnails, Videos artwork and the Videos index", async () => {
		await performLogout()
		await runLogout.mock.calls[0]?.[0].wipeThumbnails()

		expect(wipeThumbnailStore).toHaveBeenCalledTimes(1)
		expect(wipeLinkThumbnailStore).toHaveBeenCalledTimes(1)
		expect(wipeArtStore).toHaveBeenCalledTimes(1)
		expect(wipeVideoIndexStore).toHaveBeenCalledTimes(1)
	})

	it("hands the wipe the previous web app's leftovers, so its session cannot be imported again", async () => {
		await performLogout()
		await runLogout.mock.calls[0]?.[0].wipeLegacyWeb()

		expect(wipeLegacyWebOnSignOut).toHaveBeenCalledTimes(1)
	})

	it("still wipes the drive thumbnails and reports the failure when the artwork wipe fails", async () => {
		wipeArtStore.mockRejectedValueOnce(new Error("entry locked"))
		await performLogout()

		await expect(runLogout.mock.calls[0]?.[0].wipeThumbnails()).rejects.toThrow("entry locked")
		expect(wipeThumbnailStore).toHaveBeenCalledTimes(1)
	})

	it("a user-initiated sign-out is genuinely cancelled at the unsaved-changes prompt", async () => {
		modules.usePreviewUnsavedGuardStore.setState({ dirty: true })

		const result = performLogout()

		await declinePrompt()

		await expect(result).resolves.toBe(false)
		expect(runLogout).not.toHaveBeenCalled()
		expect(toastWarning).not.toHaveBeenCalled()
	})

	// The session is already revoked server-side, so declining can only buy time to copy the buffer out.
	it("a FORCED sign-out is only delayed by the prompt, never cancelled", async () => {
		modules.usePreviewUnsavedGuardStore.setState({ dirty: true })

		const result = performLogout({ forced: true })

		await declinePrompt()
		await settleMicrotasks()

		expect(runLogout).not.toHaveBeenCalled()
		expect(toastWarning).toHaveBeenCalledTimes(1)

		// The buffer is released (the preview was closed / unmounted) — the deferred wipe completes.
		modules.usePreviewUnsavedGuardStore.getState().clear()

		await expect(result).resolves.toBe(true)
		expect(runLogout).toHaveBeenCalledTimes(1)
	})

	// Behind the desktop lock nobody can answer the prompt.
	it("a sign-out that discards unsaved work never asks", async () => {
		modules.usePreviewUnsavedGuardStore.setState({ dirty: true })

		await expect(performLogout({ forced: true, discardUnsaved: true })).resolves.toBe(true)
		expect(modules.usePreviewUnsavedGuardStore.getState().logoutRequest).toBeNull()
		expect(toastWarning).not.toHaveBeenCalled()
		expect(runLogout).toHaveBeenCalledTimes(1)
	})

	it("drops every decrypted preview buffer held for pager revisits", async () => {
		await modules.loadPreviewBytes("authed", "file-uuid", 3, () => Promise.resolve(new Uint8Array([1, 2, 3])))
		expect(modules.getPreviewBytes("authed", "file-uuid")).toBeDefined()

		await expect(performLogout()).resolves.toBe(true)

		expect(modules.getPreviewBytes("authed", "file-uuid")).toBeUndefined()
	})

	it("closes whatever a preview still holds through its registered disposers", async () => {
		const dispose = vi.fn()

		modules.registerPreviewDisposer("served port", dispose)
		await expect(performLogout()).resolves.toBe(true)

		expect(dispose).toHaveBeenCalledTimes(1)
	})

	it("drops every archive listing an open preview holds, and every one its browsers dispose after", async () => {
		const cache = modules.createListingCache()
		const listing: CachedListing = {
			store: modules.createEntryStore(),
			summary: {
				format: { type: "zip" },
				password: "right",
				totals: { entries: 1, dirs: 0, files: 1, bytes: 1, skipped: 0, bytesSkipped: 0 },
				undelivered: 0,
				duplicates: null,
				unaccountedBytes: 0,
				verifying: false,
				verifyWaiting: false,
				verifyError: null
			},
			password: "secret",
			lastDirPath: "",
			costAccepted: false,
			entries: 1
		}

		cache.open()
		cache.put("archive-uuid", listing)

		await expect(performLogout()).resolves.toBe(true)

		expect(cache.get("archive-uuid")).toBeUndefined()

		cache.put("archive-uuid", listing)

		expect(cache.get("archive-uuid")).toBeUndefined()
	})

	it("forgets the document settings and saved PDF signatures, which are this account's", async () => {
		await performLogout()

		expect(officeSettingsReset).toHaveBeenCalledTimes(1)
		expect(savedSignaturesReset).toHaveBeenCalledTimes(1)
	})

	it("empties the drive clipboard, whose items belong to this account", async () => {
		modules.useDriveClipboardStore.getState().set({ mode: "cut", items: [] })

		await expect(performLogout()).resolves.toBe(true)

		expect(modules.useDriveClipboardStore.getState().entry).toBeNull()
	})

	it("forgets the sidebar tree's expanded directories, which are this account's", async () => {
		modules.useDirectoryTreeStore.getState().toggle("dir-1", "root")

		await expect(performLogout()).resolves.toBe(true)

		expect(modules.useDirectoryTreeStore.getState().open).toEqual({})
	})

	// Desktop: the shell asks to wait for the network drive's pending uploads; waiting cancels the sign-out.
	it("a sign-out the user waits on at the drive's pending-uploads prompt tears nothing down", async () => {
		confirmMountsSignOut.mockResolvedValueOnce(false)

		await expect(performLogout()).resolves.toBe(false)
		expect(calls).toEqual([])
		expect(runLogout).not.toHaveBeenCalled()
	})

	it("a forced sign-out never asks about the drive's pending uploads", async () => {
		await expect(performLogout({ forced: true })).resolves.toBe(true)
		await expect(performLogout({ forced: true, discardUnsaved: true })).resolves.toBe(true)
		expect(confirmMountsSignOut).not.toHaveBeenCalled()
	})

	it("a forced sign-out with a clean buffer never shows the pending notice", async () => {
		await expect(performLogout({ forced: true })).resolves.toBe(true)
		expect(toastWarning).not.toHaveBeenCalled()
		expect(runLogout).toHaveBeenCalledTimes(1)
	})
})

// ★ SECURITY: the pre-wipe teardown steps exist so no plaintext producer can outlive the wipe —
// an outbox flush, a typing timer or a live socket that fires AFTER kv-clear resurrects this account's
// decrypted queue on disk. That the steps run, run once, and run BEFORE runLogout is the property; the
// wipe itself is runLogout's own test.
describe("performLogout — pre-wipe teardown", () => {
	it("silences every plaintext producer exactly once, all of them before the wipe", async () => {
		await expect(performLogout()).resolves.toBe(true)

		expect(calls).toEqual([...TEARDOWN_STEPS, "runLogout"])

		for (const step of [
			shutdownAssistant,
			notesCancel,
			chatsCancel,
			cancelActiveTransfers,
			clearAllTyping,
			detachUnreadBadges,
			disposeAudioEngine,
			releaseImageEditWorker,
			socketStop,
			writeSignOutPending,
			showSignOutOverlay,
			userDictionaryReset,
			resetPhotosLibrary,
			resetDotFilen,
			resetSocketReconnectState,
			releaseVideoEditWorkers,
			resetDriveKeyframes,
			resetFileKindVerdicts,
			discardListingPatches
		]) {
			expect(step).toHaveBeenCalledTimes(1)
		}
	})

	it("hands the wipe the flag's clearing and the service worker's own wipe", async () => {
		await expect(performLogout()).resolves.toBe(true)

		const deps = runLogout.mock.calls[0]?.[0]

		calls.length = 0
		deps?.wipesLanded()

		expect(calls).toEqual(["writeSignOutPending(false)"])
		expect(deps?.wipeServiceWorker).toBe(modules.wipeSwClient)
	})

	it("lets its own reload past the leave-page prompt that guards running transfers", async () => {
		const reload = vi.fn()

		vi.stubGlobal("location", { reload })

		await expect(performLogout()).resolves.toBe(true)

		runLogout.mock.calls[0]?.[0].reload()

		expect(reload).toHaveBeenCalledTimes(1)
		expect(modules.consumeUnloadAllowance()).toBe(true)
	})

	it("a declined user-initiated sign-out leaves the session completely intact", async () => {
		modules.usePreviewUnsavedGuardStore.setState({ dirty: true })

		const result = performLogout()

		await declinePrompt()

		await expect(result).resolves.toBe(false)
		expect(calls).toEqual([])
	})

	it("a declined FORCED sign-out defers the teardown until the buffer is released, then runs all of it", async () => {
		modules.usePreviewUnsavedGuardStore.setState({ dirty: true })

		const result = performLogout({ forced: true })

		await declinePrompt()
		await settleMicrotasks()

		// Still waiting on the buffer: nothing may be torn down yet, or the user loses the text the
		// pending notice just promised them a chance to copy.
		expect(calls).toEqual([])

		modules.usePreviewUnsavedGuardStore.getState().clear()

		await expect(result).resolves.toBe(true)
		expect(calls).toEqual([...TEARDOWN_STEPS, "runLogout"])
	})
})

// One sign-out at a time: a second caller must neither raise the prompts again nor run a second teardown and wipe.
describe("performLogout — single flight", () => {
	it("a second forced sign-out joins the one parked on the buffer: one prompt, one notice, one teardown", async () => {
		modules.usePreviewUnsavedGuardStore.setState({ dirty: true })

		const first = performLogout({ forced: true })

		await declinePrompt()
		await settleMicrotasks()

		const second = performLogout({ forced: true })

		await settleMicrotasks()

		expect(modules.usePreviewUnsavedGuardStore.getState().logoutRequest).toBeNull()
		expect(toastWarning).toHaveBeenCalledTimes(1)

		modules.usePreviewUnsavedGuardStore.getState().clear()

		await expect(first).resolves.toBe(true)
		await expect(second).resolves.toBe(true)
		expect(runLogout).toHaveBeenCalledTimes(1)
		expect(calls).toEqual([...TEARDOWN_STEPS, "runLogout"])
	})

	// The locked desktop app: nobody can answer, so joining a parked sign-out must not wait on the buffer.
	it("a sign-out that discards unsaved work completes one parked on the buffer", async () => {
		modules.usePreviewUnsavedGuardStore.setState({ dirty: true })

		const parked = performLogout({ forced: true })

		await declinePrompt()
		await settleMicrotasks()

		await expect(performLogout({ forced: true, discardUnsaved: true })).resolves.toBe(true)
		await expect(parked).resolves.toBe(true)
		expect(runLogout).toHaveBeenCalledTimes(1)
	})

	it("a sign-out that discards unsaved work answers an open unsaved-changes prompt", async () => {
		modules.usePreviewUnsavedGuardStore.setState({ dirty: true })

		const asking = performLogout()

		await vi.waitFor(() => {
			expect(modules.usePreviewUnsavedGuardStore.getState().logoutRequest).not.toBeNull()
		})

		await expect(performLogout({ forced: true, discardUnsaved: true })).resolves.toBe(true)
		await expect(asking).resolves.toBe(true)
		expect(modules.usePreviewUnsavedGuardStore.getState().logoutRequest).toBeNull()
		expect(runLogout).toHaveBeenCalledTimes(1)
	})

	// The user's Cancel on their own sign-out never vetoes a revoked session's.
	it("a forced sign-out behind a user-initiated one still signs out after the user cancels", async () => {
		const answer = Promise.withResolvers<boolean>()

		confirmMountsSignOut.mockReturnValueOnce(answer.promise)

		const asking = performLogout()
		const forced = performLogout({ forced: true })

		await settleMicrotasks()

		expect(runLogout).not.toHaveBeenCalled()

		answer.resolve(false)

		await expect(asking).resolves.toBe(false)
		await expect(forced).resolves.toBe(true)
		expect(confirmMountsSignOut).toHaveBeenCalledTimes(1)
		expect(runLogout).toHaveBeenCalledTimes(1)
	})

	it("a declined sign-out does not keep the next one from running", async () => {
		modules.usePreviewUnsavedGuardStore.setState({ dirty: true })

		const declined = performLogout()

		await declinePrompt()
		await expect(declined).resolves.toBe(false)

		modules.usePreviewUnsavedGuardStore.setState({ dirty: false })

		await expect(performLogout()).resolves.toBe(true)
		expect(runLogout).toHaveBeenCalledTimes(1)
	})
})
