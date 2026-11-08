import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Remote } from "comlink"
import type { LockEvent, LockId, StringifiedClient } from "@filen/sdk-rs"
import type { SdkWorkerApi } from "@/workers/sdk.worker"

// The worker's lock bridge against a stand-in client: the listener reaches every client made live, releases go to
// the live client, and a sign-out waits on the releases in flight, bounded, before freeing the client.
const { exposed, makeClient } = vi.hoisted(() => {
	function makeClient() {
		let listener: ((event: LockEvent) => void) | null = null

		return {
			emit: (event: LockEvent) => listener?.(event),
			setLockListener: vi.fn((next: (event: LockEvent) => void) => {
				listener = next

				return Promise.resolve()
			}),
			releaseLocks: vi.fn((_locks: LockId[]) => Promise.resolve()),
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
const LOCK: LockId = { uuid: "00000001-0000-4000-8000-000000000000", resource: "notes" }

beforeEach(() => {
	nextClient = makeClient()
})

afterEach(async () => {
	vi.useRealTimers()
	await api.logout()
})

describe("sdk worker locks", () => {
	it("forwards the lock events of every client made live", async () => {
		const sink = vi.fn()
		await api.setLockSink(sink)

		const first = nextClient
		await api.injectClient(BLOB)
		first.emit({ kind: "owed", lock: LOCK })

		nextClient = makeClient()
		const second = nextClient
		await api.injectClient(BLOB)
		second.emit({ kind: "settled", lock: LOCK })

		expect(first.setLockListener).toHaveBeenCalledOnce()
		expect(second.setLockListener).toHaveBeenCalledOnce()
		expect(sink.mock.calls).toEqual([[{ kind: "owed", lock: LOCK }], [{ kind: "settled", lock: LOCK }]])
	})

	it("releases inherited locks on the live client", async () => {
		await api.injectClient(BLOB)

		await api.releaseLocks([LOCK])

		expect(nextClient.releaseLocks).toHaveBeenCalledWith([LOCK])
	})

	it("waits for the lock releases on sign-out before freeing the client", async () => {
		const client = nextClient
		await api.injectClient(BLOB)
		let settle: () => void = () => undefined
		client.waitForLockReleases.mockImplementationOnce(
			() =>
				new Promise<void>(resolve => {
					settle = resolve
				})
		)
		vi.useFakeTimers()

		const loggedOut = api.logout()
		await vi.advanceTimersByTimeAsync(1_000)

		expect(await api.hasClient()).toBe(false)
		expect(client.free).not.toHaveBeenCalled()

		settle()
		await loggedOut
		await vi.runAllTimersAsync()

		expect(client.free).toHaveBeenCalledOnce()
	})

	it("goes on with the sign-out when the releases do not finish in time", async () => {
		const client = nextClient
		await api.injectClient(BLOB)
		client.waitForLockReleases.mockImplementationOnce(() => new Promise<void>(() => undefined))
		vi.useFakeTimers()

		const loggedOut = api.logout()
		await vi.advanceTimersByTimeAsync(3_000)
		await loggedOut
		await vi.runAllTimersAsync()

		expect(client.free).toHaveBeenCalledOnce()
	})
})
