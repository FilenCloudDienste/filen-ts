import { beforeEach, describe, expect, it, vi } from "vitest"
import { SW_DOWNLOAD_PREFIX, SW_ERROR_NO_CLIENT, SW_MSG_INIT_CLIENT, SW_MSG_LOGOUT, SW_MSG_REGISTER_DOWNLOAD } from "@/lib/sw/protocol"

// sw.ts is a ServiceWorkerGlobalScope module: it registers its listeners on `self` at import and pulls
// the SW-hosted wasm SDK. Both are faked here — `self` captures the listeners, the SDK hands out fake
// Clients whose streams the test settles by hand — and each test imports a fresh copy of the module.

interface FakeClient {
	id: number
	free: ReturnType<typeof vi.fn>
	finishStream: () => void
}

const sdk = vi.hoisted(() => ({
	init: { current: (): Promise<void> => Promise.resolve() },
	clients: [] as FakeClient[]
}))

vi.mock("@filen/sdk-rs/service-worker/sdk-rs.js", () => ({
	default: () => sdk.init.current(),
	fromStringified: () => {
		let finish: () => void = () => undefined
		const streamDone = new Promise<void>(resolve => {
			finish = resolve
		})
		const client = {
			id: sdk.clients.length,
			free: vi.fn(),
			finishStream: () => {
				finish()
			},
			downloadFileToWriter: () => streamDone
		}

		sdk.clients.push(client)

		return client
	}
}))

type Listener = (event: unknown) => void

let listeners: Map<string, Listener>

async function loadSw(): Promise<void> {
	listeners = new Map()
	vi.stubGlobal("self", {
		location: { origin: "https://app.test" },
		addEventListener: (type: string, listener: Listener) => {
			listeners.set(type, listener)
		},
		skipWaiting: () => Promise.resolve(),
		clients: { claim: () => Promise.resolve() }
	})
	vi.resetModules()
	await import("@/sw/sw")
}

function message(data: unknown): Promise<unknown> {
	return new Promise(resolve => {
		listeners.get("message")?.({ data, ports: [{ postMessage: resolve }] })
	})
}

// Starts a streaming GET of a registered download and returns the promise its waitUntil keeps alive.
function streamDownload(id: string): Promise<unknown> {
	let pump: Promise<unknown> = Promise.resolve()

	listeners.get("fetch")?.({
		request: { url: `https://app.test${SW_DOWNLOAD_PREFIX}${id}`, method: "GET", mode: "cors", headers: new Headers() },
		respondWith: () => undefined,
		waitUntil: (p: Promise<unknown>) => {
			pump = p
		}
	})

	return pump
}

async function registerDownload(id: string): Promise<unknown> {
	return message({ type: SW_MSG_REGISTER_DOWNLOAD, id, file: {}, name: "a.bin", size: 10 })
}

beforeEach(async () => {
	sdk.clients.length = 0
	sdk.init.current = () => Promise.resolve()
	await loadSw()
})

describe("sw.ts Client lifecycle", () => {
	it("keeps a replaced Client alive until the stream borrowing it ends, then frees it", async () => {
		await message({ type: SW_MSG_INIT_CLIENT, blob: {} })
		await registerDownload("d1")

		const pump = streamDownload("d1")

		expect(await message({ type: SW_MSG_INIT_CLIENT, blob: {} })).toEqual({ ok: true })

		const [first, second] = sdk.clients

		expect(first?.free).not.toHaveBeenCalled()

		first?.finishStream()
		await pump

		expect(first?.free).toHaveBeenCalledTimes(1)
		expect(second?.free).not.toHaveBeenCalled()
	})

	it("frees a replaced Client straight away when no stream borrows it", async () => {
		await message({ type: SW_MSG_INIT_CLIENT, blob: {} })
		await message({ type: SW_MSG_INIT_CLIENT, blob: {} })

		expect(sdk.clients[0]?.free).toHaveBeenCalledTimes(1)
	})

	it("installs the new Client and still wipes on logout even when freeing the old one throws", async () => {
		await message({ type: SW_MSG_INIT_CLIENT, blob: {} })
		sdk.clients[0]?.free.mockImplementation(() => {
			throw new Error("attempted to take ownership of Rust value while it was borrowed")
		})

		expect(await message({ type: SW_MSG_INIT_CLIENT, blob: {} })).toEqual({ ok: true })

		sdk.clients[1]?.free.mockImplementation(() => {
			throw new Error("boom")
		})

		await registerDownload("d1")
		expect(await message({ type: SW_MSG_LOGOUT })).toEqual({ ok: true })
		expect(await registerDownload("d2")).toEqual({ ok: false, error: SW_ERROR_NO_CLIENT })
	})

	it("defers a logout's free of a streaming Client to the stream's end", async () => {
		await message({ type: SW_MSG_INIT_CLIENT, blob: {} })
		await registerDownload("d1")

		const pump = streamDownload("d1")

		await message({ type: SW_MSG_LOGOUT })

		const [client] = sdk.clients

		expect(client?.free).not.toHaveBeenCalled()

		client?.finishStream()
		await pump

		expect(client?.free).toHaveBeenCalledTimes(1)
	})

	it("never installs a session handed over before a logout that landed while the SDK was loading", async () => {
		let finishInit: () => void = () => undefined

		sdk.init.current = () =>
			new Promise<void>(resolve => {
				finishInit = resolve
			})

		const adopted = message({ type: SW_MSG_INIT_CLIENT, blob: {} })

		expect(await message({ type: SW_MSG_LOGOUT })).toEqual({ ok: true })

		finishInit()

		expect(await adopted).toMatchObject({ ok: false })
		expect(sdk.clients).toHaveLength(0)
		expect(await registerDownload("d1")).toEqual({ ok: false, error: SW_ERROR_NO_CLIENT })
	})
})
