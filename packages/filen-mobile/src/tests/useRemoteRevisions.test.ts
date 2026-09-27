// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook } from "@testing-library/react"
import { EventEmitter } from "eventemitter3"

const { emitter, confirm3, alertNormal, alertError, currentItem } = vi.hoisted(() => ({
	emitter: { current: null as EventEmitter | null },
	confirm3: vi.fn<() => Promise<"primary" | "destructive" | "cancel">>(),
	alertNormal: vi.fn(),
	alertError: vi.fn(),
	currentItem: { current: null as unknown }
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
vi.mock("@/lib/auth", () => ({ default: { getSdkClients: vi.fn() } }))
vi.mock("@/lib/logger", async () => await import("@/tests/mocks/logger"))
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock("@/components/drivePreview/gallery", () => ({
	galleryItemKey: (item: { data: { data: { uuid: string } } }) => item.data.data.uuid
}))
vi.mock("@/stores/useDrivePreview.store", () => ({ default: { getState: () => ({ currentItem: currentItem.current }) } }))

import useRemoteRevisions from "@/components/drivePreview/useRemoteRevisions"

function file(uuid: string): never {
	return { type: "file", data: { uuid, stableUuid: "lineage", decryptedMeta: { name: "notes.md" } } } as never
}

function galleryItem(uuid: string): never {
	return { type: "drive", data: file(uuid) } as never
}

function mount({ hasEdits }: { hasEdits: boolean }) {
	const savingRef = { current: false }
	const updated = vi.fn()

	emitter.current?.on("driveItemUpdated", updated)
	currentItem.current = galleryItem("v1")

	const hook = renderHook(() =>
		useRemoteRevisions({
			item: galleryItem("v1"),
			itemToUse: file("v1"),
			parent: null,
			hasEdits,
			savingRef,
			saveAsNewFile: () => Promise.resolve(null)
		})
	)

	return { hook, savingRef, updated }
}

async function flush(): Promise<void> {
	await act(async () => {
		await new Promise(resolve => setTimeout(resolve, 0))
	})
}

beforeEach(() => {
	emitter.current = new EventEmitter()
	vi.clearAllMocks()
})

afterEach(() => {
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

		const removed = vi.fn()

		emitter.current?.on("driveItemRemoved", removed)
		mount({ hasEdits: true })

		act(() => {
			emitter.current?.emit("driveFileGone", { uuid: "v1" })
		})
		await flush()

		expect(removed).toHaveBeenCalledWith({ uuid: "v1" })
	})
})
