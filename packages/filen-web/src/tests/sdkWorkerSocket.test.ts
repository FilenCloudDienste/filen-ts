import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Remote } from "comlink"
import type { SocketEvent, StringifiedClient } from "@filen/sdk-rs"
import type { SdkWorkerApi } from "@/workers/sdk.worker"

// The worker's realtime socket listener against a stand-in client: one listener at a time, freed whenever the client
// it belongs to goes (another client made live, a sign-out), and every event handed on to the page's callback.
const { exposed, makeClient } = vi.hoisted(() => {
	function makeClient() {
		const handles: { free: ReturnType<typeof vi.fn> }[] = []
		let listener: ((event: SocketEvent) => void) | null = null

		return {
			handles,
			emit: (event: SocketEvent) => listener?.(event),
			addEventListener: vi.fn((next: (event: SocketEvent) => void) => {
				const handle = { free: vi.fn() }

				listener = next
				handles.push(handle)

				return Promise.resolve(handle)
			}),
			waitForLockReleases: vi.fn(() => Promise.resolve()),
			free: vi.fn()
		}
	}

	return { exposed: new Map<"api", unknown>(), makeClient }
})

let nextClient = makeClient()

vi.mock("@filen/sdk-rs", () => ({
	default: vi.fn(),
	initThreadPool: vi.fn(),
	UnauthClient: { from_config: () => ({ free: vi.fn(), fromStringified: () => nextClient }) }
}))

vi.mock("comlink", () => ({
	expose: (api: unknown) => {
		exposed.set("api", api)
	},
	proxy: (value: unknown) => value,
	transfer: (value: unknown) => value
}))

await import("@/workers/sdk.worker")

const api = exposed.get("api") as Remote<SdkWorkerApi>
const BLOB = {} as StringifiedClient

beforeEach(() => {
	nextClient = makeClient()
})

afterEach(async () => {
	await api.logout()
})

describe("sdk worker socket listener", () => {
	it("frees the earlier listener when the socket is subscribed again", async () => {
		const client = nextClient
		await api.injectClient(BLOB)

		await api.subscribeToSocket(vi.fn())
		await api.subscribeToSocket(vi.fn())

		const [first, second] = client.handles

		expect(client.handles).toHaveLength(2)
		expect(first?.free).toHaveBeenCalledOnce()
		expect(second?.free).not.toHaveBeenCalled()
	})

	it("frees the outgoing client's listener once when another client is made live", async () => {
		const outgoing = nextClient
		await api.injectClient(BLOB)
		await api.subscribeToSocket(vi.fn())

		nextClient = makeClient()
		await api.injectClient(BLOB)

		expect(outgoing.handles).toHaveLength(1)
		expect(outgoing.handles[0]?.free).toHaveBeenCalledOnce()

		// Not again once the page unsubscribes: the handle went with its client.
		await api.unsubscribeFromSocket()

		expect(outgoing.handles[0]?.free).toHaveBeenCalledOnce()
	})

	it("frees the listener once on sign-out", async () => {
		const client = nextClient
		await api.injectClient(BLOB)
		await api.subscribeToSocket(vi.fn())

		await api.logout()

		expect(client.handles).toHaveLength(1)
		expect(client.handles[0]?.free).toHaveBeenCalledOnce()

		await api.unsubscribeFromSocket()

		expect(client.handles[0]?.free).toHaveBeenCalledOnce()
	})

	it("hands every event on to the page, the reconnect and drive events included", async () => {
		const client = nextClient
		const onEvent = vi.fn()
		await api.injectClient(BLOB)
		await api.subscribeToSocket(onEvent)

		const events = [
			{ type: "drive", driveMessageId: 1n, inner: { type: "fileTrash", uuid: "00000001-0000-4000-8000-000000000000" } },
			{ type: "reconnecting" },
			{ type: "authSuccess" },
			{ type: "authFailed" }
		] as SocketEvent[]

		for (const event of events) client.emit(event)

		expect(onEvent.mock.calls).toEqual(events.map(event => [event]))
	})
})
