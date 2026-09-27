// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, renderHook } from "@testing-library/react"
import { EventEmitter } from "eventemitter3"

const { emitter, confirm3, alertNormal, alertError, currentItem, setHasUnsavedEdits, findItemInDir, readListing, getFileOptional } =
	vi.hoisted(() => ({
		emitter: { current: null as EventEmitter | null },
		confirm3: vi.fn<() => Promise<"primary" | "destructive" | "cancel">>(),
		alertNormal: vi.fn(),
		alertError: vi.fn(),
		currentItem: { current: null as unknown },
		setHasUnsavedEdits: vi.fn(),
		findItemInDir: vi.fn(),
		readListing: vi.fn<(parentUuid: string) => Promise<unknown[]>>(),
		getFileOptional: vi.fn<(uuid: string) => Promise<unknown>>()
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
vi.mock("@/lib/prompts", () => ({ default: { confirm3 } }))
vi.mock("@/lib/alerts", () => ({ default: { normal: alertNormal, error: alertError } }))
vi.mock("@/lib/auth", () => ({
	default: { getSdkClients: () => Promise.resolve({ authedSdkClient: { findItemInDir, getFileOptional } }) }
}))
vi.mock("@/features/drive/queries/useDriveItems.query", () => ({ driveItemsQueryReadForNormalParent: readListing }))
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
				parent: parent as never,
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
	useSocketStore.setState({ state: "connected", connectedAt: 1 })
})

afterEach(() => {
	cleanup()
	emitter.current = null
})

describe("useRemoteRevisions", () => {
	it("follows a newer version of a clean file, and says so", () => {
		const { updated } = mount({ hasEdits: false })

		act(() => {
			emitter.current?.emit("driveFileRevised", { item: file("v2") })
		})

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

	it("reports a version its save went over, and follows one saved after it", () => {
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

		expect(alertNormal).toHaveBeenCalledWith("remote_change_save_replaced")
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

	it("announces a version saved after this editor's own save, which the gallery now shows", () => {
		const { hook, savingRef, updated } = mount({ hasEdits: true })

		savingRef.current = true
		emit("driveFileRevised", { item: file("mine") })
		emit("driveFileRevised", { item: file("later") })

		// applySaved made the saved version the gallery's current item.
		currentItem.current = galleryItem("mine")

		act(() => {
			hook.result.current.saveSettled(file("mine"))
		})

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
		readListing.mockResolvedValue([file("other-file", { name: "other.md", stableUuid: "other" }), file("v2")])

		const { updated } = mount({ hasEdits: false })

		socketReconnected()
		await flush()

		expect(readListing).toHaveBeenCalledTimes(1)
		expect(readListing).toHaveBeenCalledWith("dir")
		expect(getFileOptional).not.toHaveBeenCalled()
		expect(updated).toHaveBeenCalledWith({ previousUuid: "v1", item: file("v2") })
		expect(alertNormal).toHaveBeenCalledWith("remote_change_updated")
	})

	it("after a socket gap, asks over unsaved edits about a newer version", async () => {
		readListing.mockResolvedValue([file("v2")])
		confirm3.mockResolvedValue("cancel")

		mount({ hasEdits: true })

		socketReconnected()
		await flush()

		expect(confirm3).toHaveBeenCalledWith(expect.objectContaining({ title: "remote_change_title" }))
	})

	it("after a socket gap, follows a rename", async () => {
		readListing.mockResolvedValue([file("v1", { name: "renamed.md" })])

		const { updated } = mount({ hasEdits: true })

		socketReconnected()
		await flush()

		expect(updated).toHaveBeenCalledWith({ previousUuid: "v1", item: file("v1", { name: "renamed.md" }) })
		expect(confirm3).not.toHaveBeenCalled()
	})

	it("after a socket gap, asks over unsaved edits when the file was trashed", async () => {
		readListing.mockResolvedValue([])
		getFileOptional.mockResolvedValue((file("v1", { parent: "trash" }) as { data: unknown }).data)
		confirm3.mockResolvedValue("cancel")

		mount({ hasEdits: true })

		socketReconnected()
		await flush()

		expect(getFileOptional).toHaveBeenCalledWith("v1")
		expect(confirm3).toHaveBeenCalledWith(expect.objectContaining({ title: "remote_deleted_title" }))
	})

	it("after a socket gap, follows a move to another directory", async () => {
		readListing.mockResolvedValue([])
		getFileOptional.mockResolvedValue((file("v1", { parent: "elsewhere" }) as { data: unknown }).data)

		const { updated } = mount({ hasEdits: true })

		socketReconnected()
		await flush()

		expect(updated).toHaveBeenCalledWith({ previousUuid: "v1", item: file("v1", { parent: "elsewhere" }) })
		expect(confirm3).not.toHaveBeenCalled()
	})

	it("after a socket gap, drops a listing read that a revision event overtook", async () => {
		const listing = deferred<unknown[]>()

		readListing.mockReturnValue(listing.promise)

		const { updated } = mount({ hasEdits: false })

		socketReconnected()
		emit("driveFileRevised", { item: file("v3") })
		listing.resolve([file("v2")])
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

		expect(readListing).not.toHaveBeenCalled()
	})
})
