// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook } from "@testing-library/react"
import { QueryClient } from "@tanstack/react-query"
import type { File, FileMeta, UuidStr } from "@filen/sdk-rs"

const { toast, runPreviewSave, nameExistsInDirectory } = vi.hoisted(() => ({
	toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
	runPreviewSave: vi.fn(),
	nameExistsInDirectory: vi.fn(() => Promise.resolve(false))
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
	normalizeParentUuid: (parent: string) => parent
}))

const { usePreviewRemoteChanges } = await import("@/features/preview/hooks/usePreviewRemoteChanges")
const { narrowItem } = await import("@/features/drive/lib/item")
const { emitPreviewFileMetaChanged, emitPreviewFileRevised, emitPreviewItemMoved, emitPreviewItemRemoved } =
	await import("@/features/preview/lib/previewReconcile")
const { setPreviewDirty, usePreviewUnsavedGuardStore } = await import("@/features/preview/store/usePreviewUnsavedGuard")

type DriveItem = ReturnType<typeof narrowItem>

function testUuid(label: string): UuidStr {
	return `${label}-0000-0000-0000-000000000000` as UuidStr
}

function meta(name: string): FileMeta {
	return { type: "decoded", data: { name, mime: "text/plain", modified: 0n, size: 1n, key: "k", version: 2 } }
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

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve: (value: T) => void = () => undefined
	const promise = new Promise<T>(r => {
		resolve = r
	})

	return { promise, resolve }
}

function setup(items = [file("a"), file("b", { stableUUID: "other" as File["stableUUID"] })], index = 0) {
	const savedRef = { current: new Map<string, DriveItem>() as ReadonlyMap<string, DriveItem> }
	const commitSaved = vi.fn((frozenUuid: string, item: DriveItem) => {
		savedRef.current = new Map(savedRef.current).set(frozenUuid, item)
	})
	const contentRef = { current: "mine" as string | null }
	const onItemRemoved = vi.fn()
	const hook = renderHook(
		(props: { items: DriveItem[]; index: number }) =>
			usePreviewRemoteChanges({
				variant: "drive",
				items: props.items.map(item => ({ type: "drive" as const, item })),
				index: props.index,
				savedRef,
				commitSaved,
				contentRef,
				onItemRemoved
			}),
		{ initialProps: { items, index } }
	)

	return { hook, savedRef, commitSaved, onItemRemoved }
}

beforeEach(() => {
	vi.clearAllMocks()
	usePreviewUnsavedGuardStore.getState().clear()
	setPreviewDirty(true)
})

describe("usePreviewRemoteChanges", () => {
	it("saving mine as a new file follows the newest revision that arrived during the upload", async () => {
		const { hook, commitSaved } = setup()
		const upload = deferred<{ status: "success"; item: DriveItem }>()

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
})
