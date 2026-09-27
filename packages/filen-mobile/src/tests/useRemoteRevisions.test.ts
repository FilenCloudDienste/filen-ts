// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, renderHook } from "@testing-library/react"
import { EventEmitter } from "eventemitter3"

const {
	emitter,
	confirm3,
	alertNormal,
	alertError,
	currentItem,
	setHasUnsavedEdits,
	findItemInDir,
	findFile,
	unlocked,
	getFileOptional,
	info
} = vi.hoisted(() => ({
	emitter: { current: null as EventEmitter | null },
	confirm3: vi.fn<() => Promise<"primary" | "destructive" | "cancel">>(),
	alertNormal: vi.fn(),
	alertError: vi.fn(),
	currentItem: { current: null as unknown },
	setHasUnsavedEdits: vi.fn(),
	findItemInDir: vi.fn(),
	findFile: vi.fn<(parentUuid: string, stableUuid: string) => Promise<unknown>>(),
	unlocked: { current: Promise.resolve() as Promise<void> },
	getFileOptional: vi.fn<(uuid: string) => Promise<unknown>>(),
	info: vi.fn<(options: { title: string; message: string }) => Promise<void>>(() => Promise.resolve())
}))

vi.mock("@/lib/events", () => ({
	default: {
		emit: (name: string, payload: unknown) => emitter.current?.emit(name, payload),
		subscribe: (name: string, listener: (payload: unknown) => void) => {
			emitter.current?.on(name, listener)

			return { remove: () => emitter.current?.off(name, listener) }
		}
	}
}))
vi.mock("@/lib/prompts", () => ({ default: { confirm3, info } }))
vi.mock("@/lib/alerts", () => ({ default: { normal: alertNormal, error: alertError } }))
vi.mock("@/lib/auth", () => ({
	default: { getSdkClients: () => Promise.resolve({ authedSdkClient: { findItemInDir, getFileOptional } }) }
}))
vi.mock("@/features/drive/queries/useDriveItems.query", () => ({ driveItemsQueryFindFileInNormalParent: findFile }))
vi.mock("@/lib/unlockedForeground", async () => {
	const real = await vi.importActual<typeof import("@/lib/unlockedForeground")>("@/lib/unlockedForeground")

	return {
		whenUnlockedForeground: () => unlocked.current,
		// The real toaster, waiting on this file's unlock instead of the app's.
		createUnlockedToaster: (show: (message: string) => void) => {
			const toaster = real.createUnlockedToaster(show)

			return {
				notify: (kind: string, message: string) => {
					void unlocked.current.then(() => toaster.notify(kind, message))
				},
				dispose: toaster.dispose
			}
		},
		// Alerts shown once this file's unlock resolves.
		createUnlockedNotices:
			(showAlert: (title: string, message: string) => Promise<void>) => (_kind: string, title: string, message: string) => {
				void unlocked.current.then(() => showAlert(title, message))
			}
	}
})
// Raw files here carry their parent as a plain uuid, "trash" for the trash.
vi.mock("@/lib/sdkUnwrap", () => ({
	unwrapParentUuid: (parent: string) => (parent === "trash" ? null : parent),
	isTrashParent: (parent: string) => parent === "trash",
	unwrapFileMeta: (file: unknown) => file,
	unwrappedFileIntoDriveItem: (file: unknown) => ({ type: "file", data: file })
}))
vi.mock("@/lib/logger", async () => await import("@/tests/mocks/logger"))
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock("@/components/drivePreview/gallery", () => ({
	galleryItemKey: (item: { data: { data: { uuid: string } } }) => item.data.data.uuid
}))
vi.mock("@/stores/useDrivePreview.store", () => ({
	default: { getState: () => ({ currentItem: currentItem.current, setHasUnsavedEdits }) }
}))

import useRemoteRevisions from "@/components/drivePreview/useRemoteRevisions"
import useSocketStore from "@/stores/useSocket.store"
import useAppStore from "@/stores/useApp.store"

function file(
	uuid: string,
	{ name = "notes.md", parent = "dir", stableUuid = "lineage" }: { name?: string; parent?: string; stableUuid?: string } = {}
): never {
	return { type: "file", data: { uuid, stableUuid, parent, decryptedMeta: { name } } } as never
}

// A background (or a dropped connection) and the socket coming back.
function socketReconnected(): void {
	act(() => {
		useSocketStore.getState().setState("disconnected")
		useSocketStore.getState().setState("connected")
	})
}

function galleryItem(uuid: string): never {
	return { type: "drive", data: file(uuid) } as never
}

function mount({
	hasEdits,
	parent = null,
	saveAsNewFile = () => Promise.resolve(null)
}: {
	hasEdits: boolean
	parent?: unknown
	saveAsNewFile?: (name: string) => Promise<unknown>
}) {
	const savingRef = { current: false }
	const updated = vi.fn()

	emitter.current?.on("driveItemUpdated", updated)
	currentItem.current = galleryItem("v1")

	const hook = renderHook(
		({ edits }: { edits: boolean }) =>
			useRemoteRevisions({
				item: galleryItem("v1"),
				itemToUse: file("v1"),
				resolveParent: () => Promise.resolve(parent as never),
				hasEdits: edits,
				savingRef,
				saveAsNewFile: saveAsNewFile as never
			}),
		{ initialProps: { edits: hasEdits } }
	)

	return { hook, savingRef, updated }
}

function deferred<T>() {
	let resolve: (value: T) => void = () => undefined
	const promise = new Promise<T>(r => {
		resolve = r
	})

	return { promise, resolve }
}

function emit(name: string, payload: unknown): void {
	act(() => {
		emitter.current?.emit(name, payload)
	})
}

async function flush(): Promise<void> {
	await act(async () => {
		await new Promise(resolve => setTimeout(resolve, 0))
	})
}

beforeEach(() => {
	emitter.current = new EventEmitter()
	vi.clearAllMocks()
	unlocked.current = Promise.resolve()
	useAppStore.setState({ biometricUnlocked: true })
	useSocketStore.setState({ state: "connected", connectedAt: 1 })
})

afterEach(() => {
	cleanup()
	emitter.current = null
})

describe("useRemoteRevisions", () => {
	it("follows a newer version of a clean file, and says so", async () => {
		const { updated } = mount({ hasEdits: false })

		act(() => {
			emitter.current?.emit("driveFileRevised", { item: file("v2") })
		})
		await flush()

		expect(updated).toHaveBeenCalledWith({ previousUuid: "v1", item: file("v2") })
		expect(alertNormal).toHaveBeenCalledWith("remote_change_updated")
	})

	it("asks over unsaved edits, and Keep mine keeps them without asking about that version again", async () => {
		confirm3.mockResolvedValue("cancel")

		const { updated } = mount({ hasEdits: true })

		act(() => {
			emitter.current?.emit("driveFileRevised", { item: file("v2") })
		})
		await flush()

		expect(confirm3).toHaveBeenCalledTimes(1)
		expect(updated).not.toHaveBeenCalled()

		act(() => {
			emitter.current?.emit("driveFileRevised", { item: file("v2") })
		})
		await flush()

		expect(confirm3).toHaveBeenCalledTimes(1)
	})

	it("Load theirs follows the newer version", async () => {
		confirm3.mockResolvedValue("destructive")

		const { updated } = mount({ hasEdits: true })

		act(() => {
			emitter.current?.emit("driveFileRevised", { item: file("v2") })
		})
		await flush()

		expect(updated).toHaveBeenCalledWith({ previousUuid: "v1", item: file("v2") })
	})

	it("never asks about this editor's own save, even when its echo arrives mid-upload", () => {
		const { hook, savingRef, updated } = mount({ hasEdits: true })

		savingRef.current = true

		act(() => {
			emitter.current?.emit("driveFileRevised", { item: file("mine") })
		})

		act(() => {
			hook.result.current.saveSettled(file("mine"))
		})

		expect(confirm3).not.toHaveBeenCalled()
		expect(updated).not.toHaveBeenCalled()
		expect(alertNormal).not.toHaveBeenCalled()
	})

	it("reports a version its save went over, and follows one saved after it", async () => {
		const { hook, savingRef, updated } = mount({ hasEdits: true })

		savingRef.current = true

		act(() => {
			emitter.current?.emit("driveFileRevised", { item: file("theirs") })
			emitter.current?.emit("driveFileRevised", { item: file("mine") })
			emitter.current?.emit("driveFileRevised", { item: file("later") })
		})

		act(() => {
			hook.result.current.saveSettled(file("mine"))
		})
		await flush()

		expect(info).toHaveBeenCalledWith({ title: "remote_change_save_replaced_title", message: "remote_change_save_replaced" })
		expect(updated).toHaveBeenCalledWith({ previousUuid: "mine", item: file("later") })
		expect(confirm3).not.toHaveBeenCalled()
	})

	it("asks over unsaved edits when the file is trashed elsewhere, and Discard drops it from the gallery", async () => {
		confirm3.mockResolvedValue("destructive")

		const removed = vi.fn(() => {
			// The unsaved-changes guard runs on the pop this removal can cause: nothing is unsaved by then.
			expect(setHasUnsavedEdits).toHaveBeenCalledWith(false)
		})

		emitter.current?.on("driveItemRemoved", removed)
		mount({ hasEdits: true })

		act(() => {
			emitter.current?.emit("driveFileGone", { uuid: "v1" })
		})
		await flush()

		expect(removed).toHaveBeenCalledWith({ uuid: "v1" })
	})

	it("holds a deletion that arrives while the editor's own save uploads, and asks only if the save made nothing", async () => {
		confirm3.mockResolvedValue("cancel")

		const { hook, savingRef } = mount({ hasEdits: true })

		savingRef.current = true
		emit("driveFileGone", { uuid: "v1" })
		await flush()

		expect(confirm3).not.toHaveBeenCalled()

		act(() => {
			hook.result.current.saveSettled(null)
		})
		await flush()

		expect(confirm3).toHaveBeenCalledTimes(1)
	})

	it("drops a deletion held over a save that landed: the save made the file anew", async () => {
		const { hook, savingRef } = mount({ hasEdits: true })

		savingRef.current = true
		emit("driveFileGone", { uuid: "v1" })

		act(() => {
			hook.result.current.saveSettled(file("mine"))
		})
		await flush()

		expect(confirm3).not.toHaveBeenCalled()
	})

	it("uploads a copy in the save's slot, and asks nothing more until it lands", async () => {
		confirm3.mockResolvedValue("primary")
		findItemInDir.mockResolvedValue(undefined)

		const copy = deferred<unknown>()
		const saveAsNewFile = vi.fn(() => copy.promise)
		const { savingRef, updated } = mount({ hasEdits: true, parent: {}, saveAsNewFile })

		emit("driveFileRevised", { item: file("v2") })
		await flush()

		expect(saveAsNewFile).toHaveBeenCalledTimes(1)
		expect(savingRef.current).toBe(true)

		emit("driveFileRevised", { item: file("v3") })
		emit("driveFileGone", { uuid: "v1" })
		await flush()

		expect(confirm3).toHaveBeenCalledTimes(1)

		copy.resolve(file("copy"))
		await flush()

		expect(savingRef.current).toBe(false)
		// The newest version, not the one asked about.
		expect(updated).toHaveBeenCalledTimes(1)
		expect(updated).toHaveBeenCalledWith({ previousUuid: "v1", item: file("v3") })
		expect(confirm3).toHaveBeenCalledTimes(1)
	})

	it("never uploads a copy while the editor's own save is uploading", async () => {
		const answer = deferred<"primary">()

		confirm3.mockReturnValue(answer.promise)

		const saveAsNewFile = vi.fn(() => Promise.resolve(null))
		const { savingRef, updated } = mount({ hasEdits: true, parent: {}, saveAsNewFile })

		emit("driveFileRevised", { item: file("v2") })

		savingRef.current = true
		answer.resolve("primary")
		await flush()

		expect(saveAsNewFile).not.toHaveBeenCalled()
		expect(updated).not.toHaveBeenCalled()
	})

	it("Load theirs follows the newest version that arrived while the prompt was open", async () => {
		const answer = deferred<"destructive">()

		confirm3.mockReturnValue(answer.promise)

		const { updated } = mount({ hasEdits: true })

		emit("driveFileRevised", { item: file("v2") })
		emit("driveFileRevised", { item: file("v3") })
		answer.resolve("destructive")
		await flush()

		expect(confirm3).toHaveBeenCalledTimes(1)
		expect(updated).toHaveBeenCalledTimes(1)
		expect(updated).toHaveBeenCalledWith({ previousUuid: "v1", item: file("v3") })
	})

	it("Keep mine asks again about a newer version that arrived while the prompt was open", async () => {
		const first = deferred<"cancel">()

		confirm3.mockReturnValueOnce(first.promise).mockResolvedValueOnce("cancel")

		mount({ hasEdits: true })

		emit("driveFileRevised", { item: file("v2") })
		emit("driveFileRevised", { item: file("v3") })
		first.resolve("cancel")
		await flush()

		expect(confirm3).toHaveBeenCalledTimes(2)
	})

	it("asks about a deletion that arrived while a revision prompt was open, once Keep mine is answered", async () => {
		const first = deferred<"cancel">()

		confirm3.mockReturnValueOnce(first.promise).mockResolvedValueOnce("cancel")

		mount({ hasEdits: true })

		emit("driveFileRevised", { item: file("v2") })
		emit("driveFileGone", { uuid: "v1" })
		first.resolve("cancel")
		await flush()

		expect(confirm3).toHaveBeenCalledTimes(2)
		expect(confirm3).toHaveBeenLastCalledWith(expect.objectContaining({ title: "remote_deleted_title" }))
	})

	it("ignores an answer given after the preview closed", async () => {
		const answer = deferred<"destructive">()

		confirm3.mockReturnValue(answer.promise)

		const { hook, updated } = mount({ hasEdits: true })

		emit("driveFileRevised", { item: file("v2") })
		hook.unmount()
		answer.resolve("destructive")
		await flush()

		expect(updated).not.toHaveBeenCalled()
	})

	it("announces a version saved after this editor's own save, which the gallery now shows", async () => {
		const { hook, savingRef, updated } = mount({ hasEdits: true })

		savingRef.current = true
		emit("driveFileRevised", { item: file("mine") })
		emit("driveFileRevised", { item: file("later") })

		// applySaved made the saved version the gallery's current item.
		currentItem.current = galleryItem("mine")

		act(() => {
			hook.result.current.saveSettled(file("mine"))
		})
		await flush()

		expect(updated).toHaveBeenCalledWith({ previousUuid: "mine", item: file("later") })
		expect(alertNormal).toHaveBeenCalledWith("remote_change_updated")
	})

	it("fails a copy with no directory to name it in, instead of searching for a free name forever", async () => {
		confirm3.mockResolvedValue("primary")

		const saveAsNewFile = vi.fn(() => Promise.resolve(null))
		const { updated } = mount({ hasEdits: true, parent: null, saveAsNewFile })

		emit("driveFileRevised", { item: file("v2") })
		await flush()

		expect(saveAsNewFile).not.toHaveBeenCalled()
		expect(alertError).toHaveBeenCalledTimes(1)
		expect(updated).not.toHaveBeenCalled()
	})
	it("asks about a deletion of the version its open prompt asks about, once Keep mine is answered", async () => {
		const first = deferred<"cancel">()

		confirm3.mockReturnValueOnce(first.promise).mockResolvedValueOnce("cancel")

		mount({ hasEdits: true })

		emit("driveFileRevised", { item: file("v2") })
		// Trashing the file now names its newest version, not the one on screen.
		emit("driveFileGone", { uuid: "v2" })
		first.resolve("cancel")
		await flush()

		expect(confirm3).toHaveBeenCalledTimes(2)
		expect(confirm3).toHaveBeenLastCalledWith(expect.objectContaining({ title: "remote_deleted_title" }))
	})

	it("asks about a deletion of a version kept over", async () => {
		confirm3.mockResolvedValue("cancel")

		mount({ hasEdits: true })

		emit("driveFileRevised", { item: file("v2") })
		await flush()
		emit("driveFileGone", { uuid: "v2" })
		await flush()

		expect(confirm3).toHaveBeenCalledTimes(2)
		expect(confirm3).toHaveBeenLastCalledWith(expect.objectContaining({ title: "remote_deleted_title" }))
	})

	it("a deletion while clean is asked about once edits begin, before a save could recreate the file", async () => {
		confirm3.mockResolvedValue("cancel")

		const { hook } = mount({ hasEdits: false })

		emit("driveFileGone", { uuid: "v1" })
		await flush()

		expect(confirm3).not.toHaveBeenCalled()

		hook.rerender({ edits: true })
		await flush()

		expect(confirm3).toHaveBeenCalledTimes(1)
		expect(confirm3).toHaveBeenLastCalledWith(expect.objectContaining({ title: "remote_deleted_title" }))
	})

	it("after a socket gap, follows a newer version found in the file's directory, with one listing read", async () => {
		findFile.mockResolvedValue({ lineage: file("v2"), sameName: undefined })

		const { updated } = mount({ hasEdits: false })

		socketReconnected()
		await flush()

		expect(findFile).toHaveBeenCalledTimes(1)
		expect(findFile).toHaveBeenCalledWith("dir", "lineage", "notes.md")
		expect(getFileOptional).not.toHaveBeenCalled()
		expect(updated).toHaveBeenCalledWith({ previousUuid: "v1", item: file("v2") })
		expect(alertNormal).toHaveBeenCalledWith("remote_change_updated")
	})

	it("after a socket gap, asks over unsaved edits about a newer version", async () => {
		findFile.mockResolvedValue({ lineage: file("v2"), sameName: undefined })
		confirm3.mockResolvedValue("cancel")

		mount({ hasEdits: true })

		socketReconnected()
		await flush()

		expect(confirm3).toHaveBeenCalledWith(expect.objectContaining({ title: "remote_change_title" }))
	})

	it("after a socket gap, follows a rename", async () => {
		findFile.mockResolvedValue({ lineage: file("v1", { name: "renamed.md" }), sameName: undefined })

		const { updated } = mount({ hasEdits: true })

		socketReconnected()
		await flush()

		expect(updated).toHaveBeenCalledWith({ previousUuid: "v1", item: file("v1", { name: "renamed.md" }) })
		expect(confirm3).not.toHaveBeenCalled()
	})

	it("after a socket gap, asks over unsaved edits when the file was trashed", async () => {
		findFile.mockResolvedValue({ lineage: undefined, sameName: undefined })
		getFileOptional.mockResolvedValue((file("v1", { parent: "trash" }) as { data: unknown }).data)
		confirm3.mockResolvedValue("cancel")

		mount({ hasEdits: true })

		socketReconnected()
		await flush()

		expect(getFileOptional).toHaveBeenCalledWith("v1")
		expect(confirm3).toHaveBeenCalledWith(expect.objectContaining({ title: "remote_deleted_title" }))
	})

	it("after a socket gap, follows a move to another directory", async () => {
		findFile.mockResolvedValue({ lineage: undefined, sameName: undefined })
		getFileOptional.mockResolvedValue((file("v1", { parent: "elsewhere" }) as { data: unknown }).data)

		const { updated } = mount({ hasEdits: true })

		socketReconnected()
		await flush()

		expect(updated).toHaveBeenCalledWith({ previousUuid: "v1", item: file("v1", { parent: "elsewhere" }) })
		expect(confirm3).not.toHaveBeenCalled()
	})

	it("after a socket gap, drops a listing read that a revision event overtook", async () => {
		const listing = deferred<unknown>()

		findFile.mockReturnValue(listing.promise)

		const { updated } = mount({ hasEdits: false })

		socketReconnected()
		emit("driveFileRevised", { item: file("v3") })
		listing.resolve({ lineage: file("v2"), sameName: undefined })
		await flush()

		expect(updated).toHaveBeenCalledTimes(1)
		expect(updated).toHaveBeenCalledWith({ previousUuid: "v1", item: file("v3") })
	})

	it("after a socket gap, reads nothing for a file off screen or mid-save", async () => {
		const { savingRef } = mount({ hasEdits: true })

		savingRef.current = true
		socketReconnected()
		savingRef.current = false
		currentItem.current = galleryItem("elsewhere")
		socketReconnected()
		await flush()

		expect(findFile).not.toHaveBeenCalled()
	})

	it("asks only once the app is unlocked and in front, and toasts no earlier", async () => {
		const unlock = deferred<undefined>()

		unlocked.current = unlock.promise
		confirm3.mockResolvedValue("cancel")

		mount({ hasEdits: true })
		emit("driveFileRevised", { item: file("v2") })
		await flush()

		expect(confirm3).not.toHaveBeenCalled()

		unlock.resolve(undefined)
		await flush()

		expect(confirm3).toHaveBeenCalledTimes(1)
	})

	it("a clean editor follows at once, and says so once unlocked", async () => {
		const unlock = deferred<undefined>()

		unlocked.current = unlock.promise

		const { updated } = mount({ hasEdits: false })

		emit("driveFileRevised", { item: file("v2") })
		await flush()

		expect(updated).toHaveBeenCalledTimes(1)
		expect(alertNormal).not.toHaveBeenCalled()

		unlock.resolve(undefined)
		await flush()

		expect(alertNormal).toHaveBeenCalledWith("remote_change_updated")
	})

	it("forgets a deletion while clean once the file is restored from the trash", async () => {
		const { hook } = mount({ hasEdits: false })

		emit("driveFileGone", { uuid: "v1" })
		emit("driveFileRestored", { uuid: "v1" })
		hook.rerender({ edits: true })
		await flush()

		expect(confirm3).not.toHaveBeenCalled()
	})

	it("drops a deletion prompt still waiting for the unlock once the file is restored", async () => {
		const unlock = deferred<undefined>()

		unlocked.current = unlock.promise

		mount({ hasEdits: true })
		emit("driveFileGone", { uuid: "v1" })
		await flush()
		emit("driveFileRestored", { uuid: "v1" })
		unlock.resolve(undefined)
		await flush()

		expect(confirm3).not.toHaveBeenCalled()
	})

	it("after a socket gap, treats a file replaced under its name as gone", async () => {
		findFile.mockResolvedValue({ lineage: undefined, sameName: file("r1", { stableUuid: "else" }) })
		// The replaced version is archived where it was: nothing but the listing tells it apart.
		getFileOptional.mockResolvedValue((file("v1") as { data: unknown }).data)
		confirm3.mockResolvedValue("cancel")

		mount({ hasEdits: true })

		socketReconnected()
		await flush()

		expect(confirm3).toHaveBeenCalledWith(expect.objectContaining({ title: "remote_replaced_title" }))
	})

	it("keeps only the latest toast waiting for the unlock", async () => {
		const unlock = deferred<undefined>()

		unlocked.current = unlock.promise

		mount({ hasEdits: false })

		emit("driveFileRevised", { item: file("v2") })
		emit("driveFileRevised", { item: file("v3") })
		unlock.resolve(undefined)
		await flush()

		expect(alertNormal).toHaveBeenCalledTimes(1)
	})

	it("drops a toast waiting for the unlock once the editor is gone", async () => {
		const unlock = deferred<undefined>()

		unlocked.current = unlock.promise

		const first = mount({ hasEdits: false })

		emit("driveFileRevised", { item: file("v2") })
		emit("driveFileRevised", { item: file("v3") })
		first.hook.unmount()
		unlock.resolve(undefined)
		await flush()

		expect(alertNormal).not.toHaveBeenCalled()
	})

	it("says so when the editor's own save landed on another lineage, and follows it", async () => {
		const { hook, savingRef } = mount({ hasEdits: true })

		savingRef.current = true
		// Another file took its name while the save uploaded: the save became a version of that file.
		emit("driveFileGone", { uuid: "v1", reason: "replaced" })

		act(() => {
			hook.result.current.saveSettled(file("theirs-v2", { stableUuid: "their-lineage" }))
		})
		await flush()

		expect(info).toHaveBeenCalledWith({
			title: "remote_change_saved_elsewhere_title",
			message: "remote_change_saved_over_replacement"
		})
		expect(confirm3).not.toHaveBeenCalled()
	})

	it("says nothing more when the save stayed on its lineage", async () => {
		const { hook, savingRef } = mount({ hasEdits: true })

		savingRef.current = true

		act(() => {
			hook.result.current.saveSettled(file("mine"))
		})
		await flush()

		expect(alertNormal).not.toHaveBeenCalled()
	})

	// Production's order (previewText/previewPdf save()): the save slot is released, then the save settles.
	it("runs a socket-gap re-check the editor's own save got in the way of, once the save settles", async () => {
		findFile.mockResolvedValue({ lineage: file("mine"), sameName: undefined })

		const { hook, savingRef } = mount({ hasEdits: true })

		savingRef.current = true
		socketReconnected()
		await flush()

		expect(findFile).not.toHaveBeenCalled()

		savingRef.current = false
		// applySaved made the saved version the gallery's current item.
		currentItem.current = galleryItem("mine")

		act(() => {
			hook.result.current.saveSettled(file("mine"))
		})
		await flush()

		expect(findFile).toHaveBeenCalledTimes(1)
	})

	it("never takes a file moved elsewhere for one replaced under its name", async () => {
		findFile.mockResolvedValue({ lineage: undefined, sameName: file("r1", { stableUuid: "else" }) })
		// The version kept over now sits in another directory.
		getFileOptional.mockResolvedValue((file("v2", { parent: "elsewhere" }) as { data: unknown }).data)
		confirm3.mockResolvedValue("cancel")

		mount({ hasEdits: true })

		emit("driveFileRevised", { item: file("v2") })
		await flush()

		confirm3.mockClear()
		socketReconnected()
		await flush()

		expect(getFileOptional).toHaveBeenCalledWith("v2")
		expect(confirm3).not.toHaveBeenCalled()
	})

	describe("before the editor's own save", () => {
		it("with no gap since the last check, saves over the file on screen without a read", async () => {
			const { hook } = mount({ hasEdits: true })
			let target: unknown = null

			await act(async () => {
				target = await hook.result.current.beforeSave()
			})

			expect(target).toEqual(file("v1"))
			expect(findFile).not.toHaveBeenCalled()
		})

		it("after a gap not yet checked, asks about a version saved meanwhile before uploading, sharing the reconnect's one read", async () => {
			const listing = deferred<unknown>()

			findFile.mockReturnValue(listing.promise)
			confirm3.mockResolvedValue("cancel")

			const { hook } = mount({ hasEdits: true })

			socketReconnected()

			let target: unknown = "unset"
			let saving: Promise<void> = Promise.resolve()

			act(() => {
				saving = hook.result.current.beforeSave().then(result => {
					target = result
				})
			})

			listing.resolve({ lineage: file("theirs"), sameName: undefined })
			await act(async () => {
				await saving
			})
			await flush()

			expect(findFile).toHaveBeenCalledTimes(1)
			expect(target).toBeNull()
			expect(confirm3).toHaveBeenCalledWith(expect.objectContaining({ title: "remote_change_title" }))

			// Kept mine: the gap is covered, and the next save goes ahead without another read.
			let again: unknown = null

			await act(async () => {
				again = await hook.result.current.beforeSave()
			})

			expect(again).toEqual(file("v1"))
			expect(findFile).toHaveBeenCalledTimes(1)
		})

		it("while the socket is still down, checks first, and follows a rename made meanwhile", async () => {
			findFile.mockResolvedValue({ lineage: file("v1", { name: "renamed.md" }), sameName: undefined })

			const { hook, updated } = mount({ hasEdits: true })

			act(() => {
				useSocketStore.getState().setState("disconnected")
			})

			let target: unknown = null

			await act(async () => {
				target = await hook.result.current.beforeSave()
			})

			expect(target).toEqual(file("v1", { name: "renamed.md" }))
			expect(updated).toHaveBeenCalledWith({ previousUuid: "v1", item: file("v1", { name: "renamed.md" }) })
		})

		it("saves over a version the edits were kept over in the directory it moved to, without showing it", async () => {
			findFile.mockResolvedValue({ lineage: undefined, sameName: undefined })
			getFileOptional.mockResolvedValue((file("v2", { parent: "elsewhere" }) as { data: unknown }).data)
			confirm3.mockResolvedValue("cancel")

			const { hook, updated } = mount({ hasEdits: true })

			emit("driveFileRevised", { item: file("v2") })
			await flush()
			updated.mockClear()

			act(() => {
				useSocketStore.getState().setState("disconnected")
			})

			let target: unknown = null

			await act(async () => {
				target = await hook.result.current.beforeSave()
			})

			expect(target).toEqual(file("v2", { parent: "elsewhere" }))
			expect(updated).not.toHaveBeenCalled()
		})

		it("uploads nothing when the check cannot be made", async () => {
			findFile.mockRejectedValue(new Error("offline"))

			const { hook } = mount({ hasEdits: true })

			act(() => {
				useSocketStore.getState().setState("disconnected")
			})

			let target: unknown = "unset"

			await act(async () => {
				target = await hook.result.current.beforeSave()
			})

			expect(target).toBeNull()
			expect(alertError).toHaveBeenCalledTimes(1)
		})
	})

	it("explains a save made after a deletion it was not told about as a new file", async () => {
		const { hook, savingRef } = mount({ hasEdits: true })

		savingRef.current = true
		emit("driveFileGone", { uuid: "v1", reason: "trashed" })
		savingRef.current = false

		act(() => {
			hook.result.current.saveSettled(file("new", { stableUuid: "new-lineage" }))
		})
		await flush()

		expect(info).toHaveBeenCalledWith({ title: "remote_change_saved_elsewhere_title", message: "remote_change_saved_after_deletion" })
	})

	it("explains a save made after a move elsewhere as a new file where the file was", async () => {
		const { hook, savingRef } = mount({ hasEdits: true })

		savingRef.current = true
		emit("driveItemUpdated", { previousUuid: "v1", item: file("v1", { parent: "elsewhere" }) })
		savingRef.current = false

		act(() => {
			hook.result.current.saveSettled(file("new", { stableUuid: "new-lineage" }))
		})
		await flush()

		expect(info).toHaveBeenCalledWith({ title: "remote_change_saved_elsewhere_title", message: "remote_change_saved_after_move" })
	})

	it("says nothing of a save after a deletion the user was already asked about", async () => {
		confirm3.mockResolvedValue("cancel")

		const { hook } = mount({ hasEdits: true })

		emit("driveFileGone", { uuid: "v1", reason: "trashed" })
		await flush()

		expect(confirm3).toHaveBeenCalledTimes(1)

		act(() => {
			hook.result.current.saveSettled(file("new", { stableUuid: "new-lineage" }))
		})
		await flush()

		expect(info).not.toHaveBeenCalled()
	})

	it("runs a check a copy's upload held back once the copy lands", async () => {
		const answer = deferred<"primary">()

		confirm3.mockReturnValueOnce(answer.promise).mockResolvedValue("cancel")
		findItemInDir.mockResolvedValue(undefined)

		const copy = deferred<unknown>()
		const saveAsNewFile = vi.fn(() => copy.promise)
		const { savingRef } = mount({ hasEdits: true, parent: {}, saveAsNewFile })

		emit("driveFileGone", { uuid: "v1", reason: "trashed" })
		answer.resolve("primary")
		await flush()

		expect(savingRef.current).toBe(true)

		// A reconnect while the copy uploads: its check waits for the copy, as for a save.
		findFile.mockResolvedValue({ lineage: file("v1"), sameName: undefined })
		socketReconnected()
		await flush()

		expect(findFile).not.toHaveBeenCalled()

		copy.resolve(null)
		await flush()

		expect(savingRef.current).toBe(false)
		// Not left waiting for the next save: checked now.
		expect(findFile).toHaveBeenCalledTimes(1)
	})
})
