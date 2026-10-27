// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook } from "@testing-library/react"
import { QueryClient } from "@tanstack/react-query"
import type { File, FileMeta, SharingRole } from "@filen/sdk-rs"
import type { DriveVariant } from "@/features/drive/lib/preferences"
import { testUuid } from "@/tests/support/uuid"
import type { PresentationSaveEdits } from "@/features/drive/lib/previewSave.logic"

const { toast, runPreviewSave, nameExistsInDirectory, listings, cachedListings } = vi.hoisted(() => ({
	toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
	runPreviewSave: vi.fn(),
	nameExistsInDirectory: vi.fn(() => Promise.resolve(false)),
	// Whether the listings were read this session (else restored from disk).
	listings: { current: true },
	// The cached listings, by `${variant}:${uuid}`.
	cachedListings: new Map<string, unknown[]>()
}))

vi.mock("sonner", () => ({ toast }))
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock("@/lib/i18n", () => ({ i18n: { t: (key: string) => key } }))
vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))
vi.mock("@/lib/sdk/client", () => ({ sdkApi: { nameExistsInDirectory, uploadFileBytes: vi.fn() } }))
vi.mock("@/features/drive/lib/previewSave.logic", () => ({ runPreviewSave }))
vi.mock("@/features/drive/lib/actions", () => ({ currentRootUuid: () => "root" }))
vi.mock("@/features/drive/queries/drive", () => ({
	driveListingQueryOptions: vi.fn(),
	driveListingQueryUpdate: vi.fn(),
	listingRowsVerified: () => listings.current,
	cachedListing: (variant: string, uuid: string | null) => cachedListings.get(`${variant}:${uuid ?? ""}`),
	normalizeParentUuid: (parent: string) => parent
}))

const { usePreviewRemoteChanges } = await import("@/features/preview/hooks/usePreviewRemoteChanges")
const { narrowItem } = await import("@/features/drive/lib/item")
const { emitPreviewFileMetaChanged, emitPreviewFileRevised, emitPreviewItemMoved, emitPreviewItemRemoved } =
	await import("@/features/preview/lib/previewReconcile")
const { setPreviewDirty, usePreviewUnsavedGuardStore } = await import("@/features/preview/store/usePreviewUnsavedGuard")
const { emitPreviewItemRestored, emitPreviewResync, subscribePreviewReconcile } = await import("@/features/preview/lib/previewReconcile")
const { driveListingQueryOptions } = await import("@/features/drive/queries/drive")
const { clearPreviewCache, getPreviewBytes } = await import("@/features/preview/lib/previewCache")

type DriveItem = ReturnType<typeof narrowItem>

function meta(name: string): FileMeta {
	return { type: "decoded", data: { name, mime: "text/plain", modified: 0n, size: 1n, key: "k", version: 2 } }
}

// A file of a shared directory, as the shared listings hold it.
function sharedFile(label: string, overrides: Partial<File> = {}): DriveItem {
	const owned = file(label, overrides)

	if (owned.type !== "file") {
		throw new Error("not a file")
	}

	return narrowItem({ ...owned.data, sharingRole: { type: "sharer" } as unknown as SharingRole })
}

function file(label: string, overrides: Partial<File> = {}): DriveItem {
	return narrowItem({
		uuid: testUuid(label),
		stableUUID: "lineage" as File["stableUUID"],
		parent: testUuid("parent"),
		size: 1n,
		favorited: false,
		region: "de-1",
		bucket: "filen-1",
		timestamp: 0n,
		chunks: 1n,
		canMakeThumbnail: false,
		meta: meta("notes.txt"),
		...overrides
	})
}

function nameOf(item: DriveItem | undefined): string | undefined {
	return item?.type === "file" && item.data.meta.type === "decoded" ? item.data.meta.data.name : undefined
}

function setup(
	items = [file("a"), file("b", { stableUUID: "other" as File["stableUUID"] })],
	index = 0,
	readEdits?: () => Promise<Uint8Array | PresentationSaveEdits | null>,
	variant: DriveVariant = "drive"
) {
	const savedRef = { current: new Map<string, DriveItem>() as ReadonlyMap<string, DriveItem> }
	const commitSaved = vi.fn((frozenUuid: string, item: DriveItem) => {
		savedRef.current = new Map(savedRef.current).set(frozenUuid, item)
	})
	const contentRef = { current: (() => "mine") as (() => string) | null }
	const onItemRemoved = vi.fn()
	const hook = renderHook(
		(props: { items: DriveItem[]; index: number }) =>
			usePreviewRemoteChanges({
				variant,
				items: props.items,
				index: props.index,
				savedRef,
				commitSaved,
				contentRef,
				readEdits:
					readEdits ??
					(() => {
						const text = contentRef.current?.()

						return Promise.resolve(text === undefined ? null : new TextEncoder().encode(text))
					}),
				onItemRemoved
			}),
		{ initialProps: { items, index } }
	)

	return { hook, savedRef, commitSaved, onItemRemoved }
}

// The listing a lookup reads, counting the reads and naming the listings read.
function serveListing(listing: DriveItem[]): { reads: () => number; read: string[] } {
	let reads = 0
	const read: string[] = []

	vi.mocked(driveListingQueryOptions).mockImplementation(
		(variant, uuid) =>
			({
				queryKey: ["drive", "listing", { variant, uuid }],
				queryFn: () => {
					reads++
					read.push(`${variant}:${uuid ?? ""}`)

					return Promise.resolve(listing)
				}
			}) as unknown as ReturnType<typeof driveListingQueryOptions>
	)

	return { reads: () => reads, read }
}

async function flush(): Promise<void> {
	await act(async () => {
		for (let i = 0; i < 5; i++) {
			await new Promise(resolve => setTimeout(resolve, 0))
		}
	})
}

beforeEach(() => {
	vi.clearAllMocks()
	listings.current = true
	cachedListings.clear()
	usePreviewUnsavedGuardStore.getState().clear()
	setPreviewDirty(true)
})

describe("usePreviewRemoteChanges", () => {
	it("saving mine as a new file follows the newest revision that arrived during the upload", async () => {
		const { hook, commitSaved } = setup()
		const upload = Promise.withResolvers<{ status: "success"; item: DriveItem }>()

		runPreviewSave.mockReturnValueOnce(upload.promise)

		act(() => {
			emitPreviewFileRevised({ item: file("a1") })
		})

		expect(hook.result.current.prompt).toMatchObject({ kind: "revised", theirs: { data: { uuid: testUuid("a1") } } })

		let saving: Promise<void> = Promise.resolve()

		act(() => {
			saving = hook.result.current.saveMineAsNewFile()
		})

		await act(async () => {
			await Promise.resolve()
			emitPreviewFileRevised({ item: file("a2") })
		})

		await act(async () => {
			upload.resolve({ status: "success", item: file("copy", { stableUUID: "copy" as File["stableUUID"] }) })
			await saving
		})

		expect(commitSaved.mock.lastCall?.[0]).toBe(testUuid("a"))
		expect(commitSaved.mock.lastCall?.[1].data.uuid).toBe(testUuid("a2"))
		expect(hook.result.current.prompt).toBeNull()
	})

	it("never asks about the user's own trash of the file on screen", () => {
		const { hook } = setup()

		hook.result.current.expectOwnChange(testUuid("a"), "remove")

		act(() => {
			emitPreviewItemRemoved(testUuid("a"))
		})

		expect(hook.result.current.prompt).toBeNull()
	})

	it("still asks about a trash made elsewhere while a move of its own is only expected", () => {
		const { hook } = setup()

		hook.result.current.expectOwnChange(testUuid("a"), "move")

		act(() => {
			emitPreviewItemRemoved(testUuid("a"))
		})

		expect(hook.result.current.prompt).toEqual({ kind: "deleted", frozenUuid: testUuid("a") })
	})

	it("drops a prompt whose slot left the pager instead of showing it over the next file", () => {
		const { hook } = setup()

		act(() => {
			emitPreviewItemRemoved(testUuid("a"))
		})

		expect(hook.result.current.prompt).not.toBeNull()

		hook.rerender({ items: [file("b", { stableUUID: "other" as File["stableUUID"] })], index: 0 })

		expect(hook.result.current.prompt).toBeNull()
	})

	it("follows the user's own move without announcing it, and announces one made elsewhere", () => {
		const { hook, commitSaved } = setup()

		hook.result.current.expectOwnChange(testUuid("a"), "move")

		act(() => {
			emitPreviewItemMoved(file("a", { parent: testUuid("elsewhere") }))
		})

		expect(commitSaved).toHaveBeenCalledTimes(1)
		expect(toast).not.toHaveBeenCalled()

		act(() => {
			emitPreviewItemMoved(file("a", { parent: testUuid("third") }))
		})

		expect(toast).toHaveBeenCalledWith("preview:previewMovedElsewhere")
	})

	it("shows the user's own version restore of a clean file unannounced", () => {
		setPreviewDirty(false)
		const { hook, commitSaved } = setup()

		hook.result.current.expectOwnChange(testUuid("a"), "restore")

		act(() => {
			emitPreviewFileRevised({ item: file("a-restored"), previousUuid: testUuid("a") })
		})

		expect(commitSaved.mock.lastCall?.[0]).toBe(testUuid("a"))
		expect(commitSaved.mock.lastCall?.[1].data.uuid).toBe(testUuid("a-restored"))
		expect(toast).not.toHaveBeenCalled()
	})

	it("carries a rename into a slot shown through an override, so a later save keeps the file's new name", () => {
		const { savedRef, commitSaved } = setup()

		commitSaved(testUuid("a"), file("a1"))
		commitSaved.mockClear()

		act(() => {
			emitPreviewFileMetaChanged(testUuid("a1"), meta("renamed.txt"))
		})

		expect(commitSaved).toHaveBeenCalledTimes(1)
		expect(nameOf(savedRef.current.get(testUuid("a")))).toBe("renamed.txt")
	})

	it("holds a trash made elsewhere during its own save, and asks about it only once the save failed", () => {
		const { hook, onItemRemoved } = setup()

		hook.result.current.saveStarted()

		act(() => {
			emitPreviewItemRemoved(testUuid("a"))
		})

		expect(hook.result.current.prompt).toBeNull()

		act(() => {
			hook.result.current.saveSettled(null)
		})

		expect(hook.result.current.prompt).toEqual({ kind: "deleted", frozenUuid: testUuid("a") })
		expect(onItemRemoved).not.toHaveBeenCalled()
	})

	it("drops a trash held during its own save once the save landed: the slot shows the saved file", () => {
		const { hook, commitSaved, onItemRemoved } = setup()

		hook.result.current.saveStarted()

		act(() => {
			emitPreviewItemRemoved(testUuid("a"))
		})

		act(() => {
			commitSaved(testUuid("a"), file("a1"))
			setPreviewDirty(false)
			hook.result.current.saveSettled(file("a1"))
		})

		expect(hook.result.current.prompt).toBeNull()
		expect(onItemRemoved).not.toHaveBeenCalled()
	})

	it("forgets a held trash when the file is restored before the save settles", () => {
		const { hook } = setup()

		hook.result.current.saveStarted()

		act(() => {
			emitPreviewItemRemoved(testUuid("a"))
			emitPreviewItemRestored(testUuid("a"))
			hook.result.current.saveSettled(null)
		})

		expect(hook.result.current.prompt).toBeNull()
	})

	it("shows a newer version saved elsewhere once a spreadsheet reports its saved edits clean", () => {
		const { hook, commitSaved } = setup()

		hook.result.current.saveStarted()

		act(() => {
			emitPreviewFileRevised({ item: file("a1") })
			emitPreviewFileRevised({ item: file("a2") })
		})

		// The save made a1; a2 came after it. The spreadsheet has not reported its dirty bit yet.
		act(() => {
			commitSaved(testUuid("a"), file("a1"))
			hook.result.current.saveSettled(file("a1"))
		})

		expect(hook.result.current.prompt).toMatchObject({ kind: "revised", afterSave: true, theirs: { data: { uuid: testUuid("a2") } } })

		act(() => {
			setPreviewDirty(false)
		})

		expect(hook.result.current.prompt).toBeNull()
		expect(commitSaved.mock.lastCall?.[1].data.uuid).toBe(testUuid("a2"))
		expect(toast).toHaveBeenCalledWith("preview:previewUpdatedElsewhere")
	})

	it("loading theirs does not also show them through the clean-after-save path", () => {
		const { hook, commitSaved } = setup()

		hook.result.current.saveStarted()

		act(() => {
			emitPreviewFileRevised({ item: file("a1") })
			emitPreviewFileRevised({ item: file("a2") })
			commitSaved(testUuid("a"), file("a1"))
			hook.result.current.saveSettled(file("a1"))
		})
		expect(hook.result.current.prompt).toMatchObject({ kind: "revised", afterSave: true })
		commitSaved.mockClear()

		act(() => {
			hook.result.current.loadTheirs()
		})

		expect(commitSaved).toHaveBeenCalledTimes(1)
		expect(toast).not.toHaveBeenCalledWith("preview:previewUpdatedElsewhere")
	})

	it("uploads a new file once however often it is asked while the first upload runs", async () => {
		const { hook } = setup()
		const upload = Promise.withResolvers<{ status: "success"; item: DriveItem }>()

		runPreviewSave.mockReturnValue(upload.promise)

		act(() => {
			emitPreviewItemRemoved(testUuid("a"))
		})

		let first: Promise<void> = Promise.resolve()

		act(() => {
			first = hook.result.current.saveMineAsNewFile()
			void hook.result.current.saveMineAsNewFile()
		})

		await act(async () => {
			upload.resolve({ status: "success", item: file("copy", { stableUUID: "copy" as File["stableUUID"] }) })
			await first
		})

		expect(runPreviewSave).toHaveBeenCalledTimes(1)
	})

	it("after a reconnect, applies a rename made meanwhile to the pager", async () => {
		const events: string[] = []
		const unsubscribe = subscribePreviewReconcile(event => {
			events.push(event.type)
		})

		serveListing([file("a", { meta: meta("renamed.txt") })])
		setup()

		act(() => {
			emitPreviewResync()
		})
		await flush()

		expect(events).toContain("fileMeta")
		unsubscribe()
	})

	it("after a reconnect, asks about a file no longer in its directory", async () => {
		serveListing([])
		const { hook } = setup()

		act(() => {
			emitPreviewResync()
		})
		await flush()

		expect(hook.result.current.prompt).toEqual({ kind: "deleted", frozenUuid: testUuid("a") })
	})

	it("after a reconnect, drops a clean slot no longer in its directory from the pager", async () => {
		setPreviewDirty(false)
		serveListing([])
		const { onItemRemoved } = setup()

		act(() => {
			emitPreviewResync()
		})
		await flush()

		expect(onItemRemoved).toHaveBeenCalledWith(testUuid("a"))
	})

	it("looks a slot up once per reconnect, an off-screen one when it comes on screen", async () => {
		setPreviewDirty(false)
		const b = file("b", { stableUUID: "other" as File["stableUUID"] })
		const listing = serveListing([file("a"), file("b2", { stableUUID: "other" as File["stableUUID"] })])
		const { hook, commitSaved } = setup([file("a"), b])

		act(() => {
			emitPreviewResync()
		})
		await flush()

		expect(listing.reads()).toBe(1)
		expect(commitSaved).not.toHaveBeenCalled()

		hook.rerender({ items: [file("a"), b], index: 1 })
		await flush()

		expect(listing.reads()).toBe(2)
		expect(commitSaved.mock.lastCall?.[0]).toBe(testUuid("b"))
		expect(commitSaved.mock.lastCall?.[1].data.uuid).toBe(testUuid("b2"))

		hook.rerender({ items: [file("a"), b], index: 0 })
		hook.rerender({ items: [file("a"), b], index: 1 })
		await flush()

		expect(listing.reads()).toBe(2)
	})

	it("looks up a slot opened from a listing restored from disk, showing the version saved since", async () => {
		setPreviewDirty(false)
		listings.current = false

		// The file was saved again (by this user before a reload, or elsewhere): the restored row names the
		// version before.
		const listing = serveListing([file("a2"), file("b", { stableUUID: "other" as File["stableUUID"] })])
		const { hook, commitSaved } = setup()

		await flush()

		expect(listing.reads()).toBe(1)
		expect(commitSaved.mock.lastCall?.[0]).toBe(testUuid("a"))
		expect(commitSaved.mock.lastCall?.[1].data.uuid).toBe(testUuid("a2"))

		// Once per slot until a reconnect.
		hook.rerender({ items: [file("a"), file("b", { stableUUID: "other" as File["stableUUID"] })], index: 0 })
		await flush()

		expect(listing.reads()).toBe(1)
	})

	it("shows this tab's own save from before a reload unannounced, and one made elsewhere announced", async () => {
		const { recordOwnSave } = await import("@/features/preview/lib/ownSaves")

		setPreviewDirty(false)
		listings.current = false
		recordOwnSave(testUuid("a2"))
		serveListing([file("a2")])

		const own = setup()

		await flush()

		expect(own.commitSaved.mock.lastCall?.[1].data.uuid).toBe(testUuid("a2"))
		expect(toast).not.toHaveBeenCalledWith("preview:previewUpdatedElsewhere")
		own.hook.unmount()

		serveListing([file("a3")])

		const elsewhere = setup()

		await flush()

		expect(elsewhere.commitSaved.mock.lastCall?.[1].data.uuid).toBe(testUuid("a3"))
		expect(toast).toHaveBeenCalledWith("preview:previewUpdatedElsewhere")
	})

	it("asks before showing a newer version over unsaved edits made in a slot from a restored listing", async () => {
		listings.current = false
		serveListing([file("a2")])

		const { hook, commitSaved } = setup()

		await flush()

		expect(hook.result.current.prompt?.kind).toBe("revised")
		expect(commitSaved).not.toHaveBeenCalled()
	})

	it("looks up a slot opened from a restored recents listing in that listing, once, showing the version saved since", async () => {
		setPreviewDirty(false)
		listings.current = false
		cachedListings.set("recents:", [file("a"), file("b", { stableUUID: "other" as File["stableUUID"] })])

		const listing = serveListing([file("a2"), file("b", { stableUUID: "other" as File["stableUUID"] })])
		const { hook, commitSaved } = setup(undefined, undefined, undefined, "recents")

		await flush()

		expect(listing.read).toEqual(["recents:"])
		expect(commitSaved.mock.lastCall?.[0]).toBe(testUuid("a"))
		expect(commitSaved.mock.lastCall?.[1].data.uuid).toBe(testUuid("a2"))

		// Not again for the slot, nor after a reconnect: the listing rereads on every mount and focus.
		act(() => {
			emitPreviewResync()
		})
		hook.rerender({ items: [file("a"), file("b", { stableUUID: "other" as File["stableUUID"] })], index: 0 })
		await flush()

		expect(listing.reads()).toBe(1)
	})

	it("keeps a slot from a restored favorites listing its fresh read no longer holds", async () => {
		setPreviewDirty(false)
		listings.current = false
		cachedListings.set("favorites:", [file("a")])
		serveListing([])

		const { onItemRemoved, commitSaved } = setup(undefined, undefined, undefined, "favorites")

		await flush()

		expect(onItemRemoved).not.toHaveBeenCalled()
		expect(commitSaved).not.toHaveBeenCalled()
	})

	it("looks up a file of a restored shared directory listing in it, showing the version saved since", async () => {
		setPreviewDirty(false)
		listings.current = false
		cachedListings.set(`sharedOut:${testUuid("parent")}`, [sharedFile("a")])

		const listing = serveListing([sharedFile("a2")])
		const { commitSaved } = setup([sharedFile("a")], 0, undefined, "sharedOut")

		await flush()

		expect(listing.read).toEqual([`sharedOut:${testUuid("parent")}`])
		expect(commitSaved.mock.lastCall?.[1].data.uuid).toBe(testUuid("a2"))
	})

	it("looks up a file shared on its own in the restored shared root listing", async () => {
		setPreviewDirty(false)
		listings.current = false
		cachedListings.set("sharedIn:", [sharedFile("a", { meta: meta("old.txt") })])

		const events: string[] = []
		const unsubscribe = subscribePreviewReconcile(event => {
			events.push(event.type)
		})
		const listing = serveListing([sharedFile("a")])

		setup([sharedFile("a", { meta: meta("old.txt") })], 0, undefined, "sharedIn")

		await flush()

		expect(listing.read).toEqual(["sharedIn:"])
		// Renamed since.
		expect(events).toContain("fileMeta")
		unsubscribe()
	})

	it("never looks up a slot of a variant whose listing was read this session, or that its listing does not hold", async () => {
		cachedListings.set("links:", [file("other")])

		const listing = serveListing([file("a2")])

		listings.current = true
		setup(undefined, undefined, undefined, "recents").hook.unmount()
		// A chat's link opens with the links variant, its file in no listing.
		listings.current = false
		setup(undefined, undefined, undefined, "links")
		await flush()

		expect(listing.reads()).toBe(0)
	})

	it("reopens on a file saved anew from its own upload, not a download of it", async () => {
		clearPreviewCache()
		// A spreadsheet's bytes: jsdom's TextEncoder returns another realm's Uint8Array, which the cache
		// refuses.
		const { hook, commitSaved } = setup(undefined, undefined, () => Promise.resolve(Uint8Array.of(1, 2, 3)))
		const saved = file("new", { stableUUID: "new" as File["stableUUID"] })

		runPreviewSave.mockResolvedValueOnce({ status: "success", item: saved })

		act(() => {
			emitPreviewItemRemoved(testUuid("a"))
		})

		await act(async () => {
			await hook.result.current.saveMineAsNewFile()
		})

		expect(commitSaved.mock.lastCall?.[1].data.uuid).toBe(testUuid("new"))
		expect(getPreviewBytes("authed", testUuid("new"))).toEqual(Uint8Array.of(1, 2, 3))
	})

	it("keeps no copy of a conflicted copy the preview does not go on to show", async () => {
		clearPreviewCache()
		const { hook } = setup()

		runPreviewSave.mockResolvedValueOnce({ status: "success", item: file("copy", { stableUUID: "copy" as File["stableUUID"] }) })

		act(() => {
			emitPreviewFileRevised({ item: file("a1") })
		})

		await act(async () => {
			await hook.result.current.saveMineAsNewFile()
		})

		expect(getPreviewBytes("authed", testUuid("copy"))).toBeUndefined()
	})

	// A deck's edits are a save its session streams to the upload: its copy goes over the port, never as bytes.
	function deckEdits(
		announced: boolean,
		result: "written" | "unchanged"
	): PresentationSaveEdits & { closed: () => boolean; commits: () => number } {
		let closed = false
		let commits = 0

		return {
			kind: "port",
			port: { close: () => (closed = true) } as unknown as MessagePort,
			announced: Promise.resolve(announced),
			result: Promise.resolve(result === "written" ? { kind: "written", bytes: 3, revision: 2, notices: [] } : { kind: "unchanged" }),
			commit: () => {
				commits++

				return Promise.resolve({ dirty: false })
			},
			closed: () => closed,
			commits: () => commits
		}
	}

	it("keeps a deck's edits as a conflicted copy uploaded from its session's port, without moving the session onto it", async () => {
		clearPreviewCache()
		const edits = deckEdits(true, "written")
		const { hook, commitSaved } = setup(undefined, undefined, () => Promise.resolve(edits))
		const theirs = file("a1")

		runPreviewSave.mockResolvedValueOnce({ status: "success", item: file("copy", { stableUUID: "copy" as File["stableUUID"] }) })

		act(() => {
			emitPreviewFileRevised({ item: theirs })
		})

		await act(async () => {
			await hook.result.current.saveMineAsNewFile()
		})

		expect(runPreviewSave.mock.lastCall?.[1]).toMatchObject({
			content: { port: edits.port },
			asNewFile: expect.stringContaining("a") as unknown
		})
		expect(edits.commits()).toBe(0)
		expect(commitSaved.mock.lastCall?.[1].data.uuid).toBe(testUuid("a1"))
		expect(getPreviewBytes("authed", testUuid("copy"))).toBeUndefined()
		expect(toast.success).toHaveBeenCalled()
	})

	it("opens no upload for a deck whose session has nothing to write, and says the copy failed", async () => {
		const edits = deckEdits(false, "unchanged")
		const { hook } = setup(undefined, undefined, () => Promise.resolve(edits))

		act(() => {
			emitPreviewFileRevised({ item: file("a1") })
		})

		await act(async () => {
			await hook.result.current.saveMineAsNewFile()
		})

		expect(runPreviewSave).not.toHaveBeenCalled()
		expect(edits.closed()).toBe(true)
		expect(toast.error).toHaveBeenCalledWith("previewSaveAsNewFileFailed")
	})

	it("drops a deleted file kept on screen from the pager once the user steps away from it", () => {
		const { hook, onItemRemoved } = setup()

		act(() => {
			emitPreviewItemRemoved(testUuid("a"))
		})
		act(() => {
			hook.result.current.keepMine()
		})

		expect(onItemRemoved).not.toHaveBeenCalled()

		// Stepping away asks first, and a discard clears the edits with the step.
		act(() => {
			setPreviewDirty(false)
			hook.rerender({ items: [file("a"), file("b", { stableUUID: "other" as File["stableUUID"] })], index: 1 })
		})

		expect(onItemRemoved).toHaveBeenCalledExactlyOnceWith(testUuid("a"))
	})

	it("keeps a deleted file kept on screen through an undo back to clean, and forgets it once restored", () => {
		const b = file("b", { stableUUID: "other" as File["stableUUID"] })
		const { hook, onItemRemoved } = setup()

		act(() => {
			emitPreviewItemRemoved(testUuid("a"))
		})
		act(() => {
			hook.result.current.keepMine()
		})
		// An undo back to the saved content reports clean; the slot, and its redo history, stay.
		act(() => {
			setPreviewDirty(false)
		})

		expect(onItemRemoved).not.toHaveBeenCalled()

		act(() => {
			emitPreviewItemRestored(testUuid("a"))
		})
		act(() => {
			hook.rerender({ items: [file("a"), b], index: 1 })
		})

		expect(onItemRemoved).not.toHaveBeenCalled()
	})
})
