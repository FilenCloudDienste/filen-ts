import { vi, describe, it, expect, beforeEach } from "vitest"

const h = vi.hoisted(() => ({
	push: vi.fn(),
	listeners: new Set<(data: unknown) => void>(),
	cacheItems: new Map<string, unknown>()
}))

vi.mock("@/lib/logger", async () => await import("@/tests/mocks/logger"))
vi.mock("uniffi-bindgen-react-native", async () => await import("@/tests/mocks/uniffiBindgenReactNative"))
vi.mock("react-native", async () => await import("@/tests/mocks/reactNative"))
vi.mock("@filen/sdk-rs", () => ({ AnyNormalDir_Tags: { Dir: "Dir", Root: "Root" } }))
vi.mock("@/lib/router", () => ({ router: { push: h.push } }))
vi.mock("@/lib/serializer", () => ({ serialize: (value: unknown) => JSON.stringify(value) }))
vi.mock("expo-crypto", () => ({ randomUUID: () => "session-1" }))
vi.mock("@/lib/cache", () => ({ default: { uuidToAnyDriveItem: h.cacheItems } }))
vi.mock("@/lib/auth", () => ({
	default: { getSdkClients: async () => ({ authedSdkClient: { root: () => ({ uuid: "root-uuid" }) } }) }
}))
vi.mock("@/lib/events", () => ({
	default: {
		subscribe: (_name: string, listener: (data: unknown) => void) => {
			h.listeners.add(listener)

			return { remove: () => h.listeners.delete(listener) }
		},
		emit: (_name: string, data: unknown) => {
			for (const listener of [...h.listeners]) {
				listener(data)
			}
		}
	}
}))
import { openDriveSelect, selectCopyDestination } from "@/features/drive/driveSelectSession"
import useDriveSelectStore from "@/features/drive/store/useDriveSelect.store"
import events from "@/lib/events"
import type { DriveItem } from "@/types"
import type { AnyNormalDir } from "@filen/sdk-rs"

const item = { type: "file", data: { uuid: "item-1" } } as unknown as DriveItem

beforeEach(() => {
	h.push.mockClear()
	h.listeners.clear()
	h.cacheItems.clear()
	useDriveSelectStore.setState({ sessions: {} })
})

describe("openDriveSelect", () => {
	it("keeps the items in the session store and puts only flags and the id in the route", () => {
		openDriveSelect({
			rootUuid: "root-uuid",
			options: { type: "single", files: false, directories: true, intention: "move", items: [item], id: "s" }
		})

		expect(useDriveSelectStore.getState().sessions["s"]?.items).toEqual([item])
		expect(useDriveSelectStore.getState().sessions["s"]?.itemUuids.has("item-1")).toBe(true)
		expect(h.push).toHaveBeenCalledExactlyOnceWith({
			pathname: "/driveSelect/[uuid]",
			params: {
				uuid: "root-uuid",
				selectOptions: JSON.stringify({ type: "single", files: false, directories: true, intention: "move", id: "s" })
			}
		})
	})

	it("the preselection rides the session too, not the route", () => {
		openDriveSelect({
			rootUuid: "root-uuid",
			options: { type: "single", files: false, directories: true, intention: "select", items: [], initiallySelected: [item], id: "p" }
		})

		expect(useDriveSelectStore.getState().sessions["p"]?.initiallySelected).toEqual([item])
		expect(h.push.mock.calls[0]?.[0].params.selectOptions).not.toContain("item-1")
	})

	it("closing a session drops its items; closing an unknown one changes nothing", () => {
		useDriveSelectStore.getState().openSession("s", [item])

		const before = useDriveSelectStore.getState()

		useDriveSelectStore.getState().closeSession("other")

		expect(useDriveSelectStore.getState()).toBe(before)

		useDriveSelectStore.getState().closeSession("s")

		expect(useDriveSelectStore.getState().sessions).toEqual({})
	})
})

describe("selectCopyDestination", () => {
	async function opened(): Promise<void> {
		await vi.waitFor(() => expect(h.push).toHaveBeenCalledOnce())
	}

	it("opens a copy session over the items at the drive root", async () => {
		void selectCopyDestination([item], "Drive")

		await opened()

		expect(JSON.parse(h.push.mock.calls[0]?.[0].params.selectOptions)).toEqual({
			type: "single",
			files: false,
			directories: true,
			intention: "copy",
			id: "session-1"
		})
		expect(useDriveSelectStore.getState().sessions["session-1"]?.items).toEqual([item])
	})

	it("resolves with the directory 'Copy here' was tapped in", async () => {
		const picked = selectCopyDestination([item], "Drive")

		await opened()

		h.cacheItems.set("dest-uuid", { data: { decryptedMeta: { name: "Holiday" } } })

		const dir = { tag: "Dir", inner: [{ uuid: "dest-uuid" }] } as unknown as AnyNormalDir

		events.emit("driveSelect", { id: "session-1", cancelled: false, selectedItems: [{ type: "root", data: dir }] })

		await expect(picked).resolves.toEqual({ destinationDir: dir, destination: { uuid: "dest-uuid", name: "Holiday" } })
	})

	it("the drive root is the null destination", async () => {
		const picked = selectCopyDestination([item], "Drive")

		await opened()

		const root = { tag: "Root", inner: [{ uuid: "root-uuid" }] } as unknown as AnyNormalDir

		events.emit("driveSelect", { id: "session-1", cancelled: false, selectedItems: [{ type: "root", data: root }] })

		await expect(picked).resolves.toEqual({ destinationDir: root, destination: { uuid: null, name: "Drive" } })
	})

	it("a dismissed picker resolves null, and a later event for the same session is ignored", async () => {
		const picked = selectCopyDestination([item], "Drive")

		await opened()

		events.emit("driveSelect", { id: "session-1", cancelled: true })

		await expect(picked).resolves.toBeNull()
		expect(h.listeners.size).toBe(0)
	})
})
