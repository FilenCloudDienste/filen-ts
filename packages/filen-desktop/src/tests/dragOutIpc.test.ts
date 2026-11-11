import { stringifyEnvelope } from "@filen/shared/session"
import { describe, expect, it, vi } from "vitest"
import { registerDragOutIpc } from "../main/dragOut/ipc.ts"
import type { DragOutService } from "../main/dragOut/service.ts"
import type { IpcEvent, IpcMain } from "../main/pages.ts"
import { CHANNELS, DRAG_CALLS, type DragCall, dragChannel } from "../shared/channels.ts"
import { dragFakes, dragImage, pngOf } from "./dragOutFakes.ts"
import { wasmFile } from "./nativeFakes.ts"

const APP = "filen://app/"
const UUID = "0d3c6b1e-8f4a-4c2d-9b7e-5a1f3e2d4c6b"
const ITEM = { kind: "file", ref: { variant: "AnyFile.File", value: stringifyEnvelope(wasmFile(UUID, 10n)) }, name: "a.txt", size: 10 }

function setup(service: DragOutService) {
	const handlers = new Map<string, (event: IpcEvent, ...args: unknown[]) => unknown>()
	const listeners = new Map<string, (event: IpcEvent, ...args: unknown[]) => void>()
	const ipc: IpcMain = {
		handle: (channel, listener) => {
			handlers.set(channel, listener)
		},
		on: (channel, listener) => {
			listeners.set(channel, listener)
		}
	}
	const event = (sender: number, url = APP): IpcEvent => ({
		senderFrame: { url },
		sender: { id: sender, send: vi.fn(), isDestroyed: () => false }
	})

	registerDragOutIpc(ipc, service, url => url?.startsWith(APP) === true)

	return {
		invoke: async (name: DragCall, from: IpcEvent, ...args: unknown[]) => {
			const handler = handlers.get(dragChannel(name))

			if (handler === undefined) {
				throw new Error(`no handler for ${name}`)
			}

			return await handler(from, ...args)
		},
		subscribe: (from: IpcEvent, on: unknown) => {
			listeners.get(CHANNELS.dragSubscribe)?.(from, on)
		},
		event
	}
}

function fakeService() {
	return {
		prepare: vi.fn(() => Promise.resolve({ id: UUID })),
		begin: vi.fn(() => Promise.resolve("dropped")),
		release: vi.fn(),
		subscribe: vi.fn()
	}
}

describe("drag ipc", () => {
	it("refuses an untrusted sender", async () => {
		const service = fakeService()
		const { invoke, subscribe, event } = setup(service as unknown as DragOutService)
		const evil = event(3, "https://evil.example/")

		for (const name of DRAG_CALLS) {
			await expect(invoke(name, evil)).rejects.toThrow("untrusted sender")
		}

		subscribe(evil, true)
		expect(service.subscribe).not.toHaveBeenCalled()
	})

	it("passes checked items and images to the service with the sender's page", async () => {
		const service = fakeService()
		const { invoke, subscribe, event } = setup(service as unknown as DragOutService)
		const image = dragImage()

		await invoke("prepare", event(3), { items: [ITEM] })
		await invoke("begin", event(3), { id: UUID, image })
		await invoke("release", event(3), UUID)
		subscribe(event(3), true)
		subscribe(event(3), "yes")

		expect(service.prepare).toHaveBeenCalledWith(expect.objectContaining({ id: 3 }), [ITEM])
		expect(service.begin).toHaveBeenCalledWith(expect.objectContaining({ id: 3 }), UUID, image)
		expect(service.release).toHaveBeenCalledWith(expect.objectContaining({ id: 3 }), UUID)
		expect(service.subscribe).toHaveBeenCalledOnce()
	})

	it("refuses a malformed request: no items, a local path, an unknown key, a non-uuid id", async () => {
		const service = fakeService()
		const { invoke, event } = setup(service as unknown as DragOutService)

		await expect(invoke("prepare", event(3), { items: [] })).rejects.toThrow("invalid drag payload")
		await expect(invoke("prepare", event(3), { items: [ITEM], path: "/etc" })).rejects.toThrow("invalid drag payload")
		await expect(invoke("prepare", event(3), { items: [{ ...ITEM, path: "/etc" }] })).rejects.toThrow("invalid drag payload")
		await expect(invoke("release", event(3), "../x")).rejects.toThrow("invalid drag payload")
		expect(service.prepare).not.toHaveBeenCalled()
		expect(service.release).not.toHaveBeenCalled()
	})

	it("refuses an oversized image", async () => {
		const service = fakeService()
		const { invoke, event } = setup(service as unknown as DragOutService)
		const big = new Uint8Array(2 * 1024 ** 2 + 1)

		big.set(pngOf(200, 40))

		for (const image of [
			{ ...dragImage(), png: big },
			{ ...dragImage(), width: 641 },
			{ ...dragImage(), height: 161 },
			{ ...dragImage(), scale: 3.5 },
			// A small file that unpacks into far more pixels than its size.
			{ ...dragImage(), png: pngOf(20_000, 20_000) },
			{ ...dragImage(), png: new Uint8Array([1, 2, 3]) },
			{ ...dragImage(), png: [1, 2, 3] }
		]) {
			await expect(invoke("begin", event(3), { id: UUID, image })).rejects.toThrow("invalid drag payload")
		}

		expect(service.begin).not.toHaveBeenCalled()
	})

	it("refuses an id it did not issue to that sender", async () => {
		const f = dragFakes("promise")
		const { invoke, event } = setup(f.service)
		const prepared = (await invoke("prepare", event(1), { items: [ITEM] })) as { id: string }

		expect(await invoke("begin", event(2), { id: prepared.id, image: dragImage() })).toBe("failed")
		expect(await invoke("begin", event(1), { id: UUID, image: dragImage() })).toBe("failed")
		expect(f.mac.begins).toEqual([])

		void invoke("begin", event(1), { id: prepared.id, image: dragImage() })
		expect(f.mac.begins).toHaveLength(1)
	})
})
