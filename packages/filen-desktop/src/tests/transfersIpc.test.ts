import path from "node:path"
import { stringifyEnvelope } from "@filen/shared/session"
import { describe, expect, it, vi } from "vitest"
import type { IpcEvent, IpcMain } from "../main/pages.ts"
import { registerTransfersIpc } from "../main/transfers/ipc.ts"
import type { TransfersService } from "../main/transfers/service.ts"
import { CHANNELS, TRANSFERS_CALLS, type TransfersCall, transfersChannel } from "../shared/channels.ts"
import { wasmDir, wasmFile } from "./nativeFakes.ts"

const APP = "filen://app/"
const ID = "0d3c6b1e-8f4a-4c2d-9b7e-5a1f3e2d4c6b"
const FILE_REF = { variant: "AnyFile.File", value: stringifyEnvelope(wasmFile(ID, 10n)) }
const PARENT = { uuid: ID, ref: { variant: "AnyNormalDir.Dir", value: stringifyEnvelope(wasmDir(ID)) } }
const ITEM = { kind: "file", ref: FILE_REF, name: "a.txt", size: 10 }

function setup(senderUrl = APP) {
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
	const ok = () => Promise.resolve({ ok: true, value: null })
	const service = {
		startDownload: vi.fn(ok),
		startUpload: vi.fn(ok),
		pickUpload: vi.fn(ok),
		cancel: vi.fn(),
		setPaused: vi.fn(),
		reveal: vi.fn(ok),
		open: vi.fn(ok),
		chooseDownloadDirectory: vi.fn(() => Promise.resolve({ status: "canceled" })),
		subscribe: vi.fn()
	}
	const event: IpcEvent = {
		senderFrame: { url: senderUrl },
		sender: { id: 3, send: vi.fn(), isDestroyed: () => false }
	}

	registerTransfersIpc(ipc, service as unknown as TransfersService, url => url?.startsWith(APP) === true)

	return {
		service,
		invoke: async (name: TransfersCall, ...args: unknown[]) => {
			const handler = handlers.get(transfersChannel(name))

			if (handler === undefined) {
				throw new Error(`no handler for ${name}`)
			}

			return await handler(event, ...args)
		},
		subscribe: (on: unknown) => {
			listeners.get(CHANNELS.transfersSubscribe)?.(event, on)
		}
	}
}

describe("transfers ipc", () => {
	it("every call rejects an untrusted sender", async () => {
		const { invoke, service, subscribe } = setup("https://evil.example/")

		for (const name of TRANSFERS_CALLS) {
			await expect(invoke(name)).rejects.toThrow("untrusted sender")
		}

		subscribe(true)
		expect(service.subscribe).not.toHaveBeenCalled()
	})

	it("download passes checked items to the service as a page download to the prefs destination", async () => {
		const { invoke, service } = setup()

		await invoke("download", [ITEM])
		await invoke("download", [ITEM], { ask: true })

		expect(service.startDownload.mock.calls).toEqual([
			[{ items: [ITEM], destination: { kind: "prefs" }, origin: "page", revealable: true }],
			[{ items: [ITEM], destination: { kind: "prefs", ask: true }, origin: "page", revealable: true }]
		])
	})

	it("download refuses items past the limits", async () => {
		const { invoke, service } = setup()
		const refused = "invalid transfers payload"

		await expect(
			invoke(
				"download",
				Array.from({ length: 10_001 }, () => ITEM)
			)
		).rejects.toThrow(refused)
		await expect(invoke("download", [{ ...ITEM, name: "x".repeat(1025) }])).rejects.toThrow(refused)
		await expect(invoke("download", [{ ...ITEM, name: "" }])).rejects.toThrow(refused)
		await expect(invoke("download", [{ ...ITEM, size: -1 }])).rejects.toThrow(refused)
		await expect(invoke("download", [{ ...ITEM, size: 1.5 }])).rejects.toThrow(refused)
		await expect(invoke("download", [{ ...ITEM, ref: { variant: "File", value: "{}" } }])).rejects.toThrow(refused)
		await expect(invoke("download", [{ ...ITEM, ref: { ...FILE_REF, value: "x".repeat(8193) } }])).rejects.toThrow(refused)
		await expect(
			invoke(
				"download",
				Array.from({ length: 2100 }, () => ({ ...ITEM, ref: { ...FILE_REF, value: "x".repeat(8192) } }))
			)
		).rejects.toThrow(refused)
		await expect(invoke("download", [])).rejects.toThrow(refused)
		await expect(invoke("download", [ITEM], { ask: true, extra: 1 })).rejects.toThrow(refused)
		expect(service.startDownload).not.toHaveBeenCalled()
	})

	it("upload takes absolute paths only", async () => {
		const { invoke, service } = setup()
		const file = path.resolve("b.txt")

		await invoke("upload", [file], PARENT)
		expect(service.startUpload).toHaveBeenCalledWith({ paths: [file], parent: PARENT, origin: "page" })

		await expect(invoke("upload", ["relative/b.txt"], PARENT)).rejects.toThrow("invalid transfers payload")
		await expect(invoke("upload", [`${file}\0`], PARENT)).rejects.toThrow("invalid transfers payload")
		await expect(
			invoke(
				"upload",
				Array.from({ length: 10_001 }, () => file),
				PARENT
			)
		).rejects.toThrow("invalid transfers payload")
		await expect(invoke("upload", [file], { uuid: "x", ref: PARENT.ref })).rejects.toThrow("invalid transfers payload")
	})

	it("cancel and setPaused take uuids", async () => {
		const { invoke, service } = setup()

		await invoke("cancel", [ID])
		await invoke("setPaused", [ID], true)

		expect(service.cancel).toHaveBeenCalledWith([ID])
		expect(service.setPaused).toHaveBeenCalledWith([ID], true)
		await expect(invoke("cancel", ["not-a-uuid"])).rejects.toThrow("invalid transfers payload")
		await expect(invoke("setPaused", [ID], "yes")).rejects.toThrow("invalid transfers payload")
	})

	it("pickUpload, reveal, open and chooseDownloadDirectory reach the service", async () => {
		const { invoke, service } = setup()

		await invoke("pickUpload", "directory", PARENT)
		await invoke("reveal", ID)
		await invoke("open", ID)
		await invoke("chooseDownloadDirectory")

		expect(service.pickUpload).toHaveBeenCalledWith("directory", PARENT)
		expect(service.reveal).toHaveBeenCalledWith(ID)
		expect(service.open).toHaveBeenCalledWith(ID)
		expect(service.chooseDownloadDirectory).toHaveBeenCalledOnce()
		await expect(invoke("pickUpload", "folder", PARENT)).rejects.toThrow("invalid transfers payload")
		await expect(invoke("chooseDownloadDirectory", "/tmp")).rejects.toThrow("invalid transfers payload")
	})

	it("subscribe takes a boolean from a trusted page", () => {
		const { service, subscribe } = setup()

		subscribe("yes")
		subscribe(true)

		expect(service.subscribe).toHaveBeenCalledOnce()
		expect(service.subscribe).toHaveBeenCalledWith(expect.objectContaining({ id: 3 }), true)
	})
})
