import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { OpenedEngine } from "../native/engine.ts"
import { type HostPort, startHost } from "../native/index.ts"
import type { FromNative } from "../shared/nativeProtocol.ts"
import { FakeTransferClient, fakeEngine, fakeSdk, sdkError, SPEED } from "./nativeFakes.ts"

// The host's message loop (native/index.ts) on an injected port: its addon, client and engine are controlled here.
const hoisted = vi.hoisted(() => ({
	addonFails: false,
	client: null as unknown,
	transfersClient: null as unknown,
	open: (() => new Promise(() => undefined)) as () => Promise<unknown>
}))

vi.mock("../native/addon.ts", async () => {
	const fakes = await import("./nativeFakes.ts")

	return {
		loadAddon: () => {
			if (hoisted.addonFails) {
				throw new Error("dlopen failed")
			}

			return { ...fakes.fakeSdk, ...fakes.fakeTransferSdk }
		}
	}
})
vi.mock("../native/client.ts", () => ({
	clientsFromSession: () => (hoisted.client === null ? null : { sync: hoisted.client, transfers: hoisted.transfersClient })
}))
vi.mock("../native/engine.ts", () => ({ openEngine: () => hoisted.open() }))

const SESSION = "session-blob-that-must-never-be-logged"
const TRANSFER = "0d3c6b1e-8f4a-4c2d-9b7e-5a1f3e2d4c6b"

function init(overrides: Record<string, unknown> = {}) {
	return {
		t: "init",
		addonPath: path.resolve("addon.node"),
		dir: path.resolve("user"),
		session: SESSION,
		logLevel: "Info",
		holdRemotes: [],
		macAddonPath: null,
		speed: SPEED,
		...overrides
	}
}

function setup() {
	const listeners: ((message: { data: unknown }) => void)[] = []
	const posts: FromNative[] = []
	const exit = vi.fn()
	const port: HostPort = {
		on: (_event, listener) => {
			listeners.push(listener)
		},
		postMessage: message => {
			posts.push(message)
		}
	}

	startHost(port, exit)

	return {
		posts,
		exit,
		send: (data: unknown) => {
			for (const listener of listeners) {
				listener({ data })
			}
		},
		replyTo: (id: number) => posts.find(message => message.t === "reply" && message.id === id),
		of: (t: FromNative["t"]) => posts.filter(message => message.t === t)
	}
}

let logged: string[]

beforeEach(() => {
	logged = []
	hoisted.addonFails = false
	hoisted.client = new FakeTransferClient()
	hoisted.transfersClient = new FakeTransferClient()
	hoisted.open = () => new Promise(() => undefined)

	for (const method of ["log", "error"] as const) {
		vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
			logged.push(args.map(String).join(" "))
		})
	}
})

afterEach(() => {
	vi.restoreAllMocks()
})

// A client with the speed setters newer addons have.
function withSetters<T extends object>(client: T) {
	return Object.assign(client, {
		setConcurrency: vi.fn(() => Promise.resolve()),
		setRequestRateLimit: vi.fn(() => Promise.resolve()),
		setFileIoMemoryBudget: vi.fn(() => Promise.resolve()),
		setBandwidthLimits: vi.fn(() => Promise.resolve())
	})
}

// An engine that opens with no pairs.
function opensEngine() {
	const fake = fakeEngine([])

	hoisted.open = () => Promise.resolve({ engine: fake.handle, reset: false } satisfies OpenedEngine)

	return fake
}

describe("native host", () => {
	it("drops a malformed message, logging only a fixed line, never what it carried", () => {
		const host = setup()

		host.send({ t: "init", session: SESSION })

		expect(logged).toEqual(["rejected a malformed message"])
		expect(host.posts).toEqual([])
	})

	it("answers a malformed call with an id with invalid call", () => {
		const host = setup()

		host.send({ t: "call", id: 4, op: "listPairs", args: { session: SESSION, extra: 1 } })
		host.send({ t: "call", id: 5, op: "noSuchOp", args: {} })

		expect(host.posts).toEqual([
			{ t: "reply", id: 4, ok: false, error: { code: "unknown", message: "invalid call" } },
			{ t: "reply", id: 5, ok: false, error: { code: "unknown", message: "invalid call" } }
		])
		expect(logged.join("\n")).not.toContain(SESSION)
	})

	it("answers sync and mounts calls before ready with hostUnavailable", async () => {
		const host = setup()

		host.send(init())
		host.send({ t: "call", id: 1, op: "listPairs", args: {} })

		await vi.waitFor(() => {
			expect(host.replyTo(1)).toEqual({ t: "reply", id: 1, ok: false, error: { code: "hostUnavailable" } })
		})
	})

	it("posts fatal addonLoad when the addon does not load", async () => {
		hoisted.addonFails = true

		const host = setup()

		host.send(init())

		await vi.waitFor(() => {
			expect(host.of("fatal")).toEqual([{ t: "fatal", reason: "addonLoad" }])
		})
	})

	it("posts fatal session when the session builds no client", async () => {
		hoisted.client = null

		const host = setup()

		host.send(init())

		await vi.waitFor(() => {
			expect(host.of("fatal")).toEqual([{ t: "fatal", reason: "session" }])
		})
	})

	it("applies a speed change to the client it is for, through its setters, and only what changed", async () => {
		const sync = withSetters(new FakeTransferClient())
		const transfers = withSetters(new FakeTransferClient())

		hoisted.client = sync
		hoisted.transfersClient = transfers

		const host = setup()

		host.send(init())
		host.send({ t: "speed", speed: { ...SPEED, transfers: { preset: "maximum", uploadKbps: 8, downloadKbps: 2000 } } })
		await vi.waitFor(() => {
			expect(transfers.setBandwidthLimits).toHaveBeenCalled()
		})

		expect(transfers.setConcurrency).toHaveBeenCalledWith(160)
		expect(transfers.setRequestRateLimit).toHaveBeenCalledWith(640)
		expect(transfers.setFileIoMemoryBudget).toHaveBeenCalledWith(BigInt(128 * 1_048_604))
		expect(transfers.setBandwidthLimits).toHaveBeenCalledWith(16, 2000)
		expect(sync.setConcurrency).not.toHaveBeenCalled()
		expect(sync.setBandwidthLimits).not.toHaveBeenCalled()
	})

	it("ignores a speed change before init, and drops a malformed one", () => {
		const host = setup()

		host.send({ t: "speed", speed: SPEED })
		host.send({ t: "speed", speed: { ...SPEED, sync: { preset: "turbo", uploadKbps: 0, downloadKbps: 0 } } })

		expect(host.posts).toEqual([])
		expect(logged).toEqual(["rejected a malformed message"])
	})

	it("ignores a second init", async () => {
		const open = vi.fn(() => new Promise(() => undefined))

		hoisted.open = open

		const host = setup()

		host.send(init())
		host.send(init())
		await vi.waitFor(() => {
			expect(open).toHaveBeenCalled()
		})
		await new Promise(resolve => setImmediate(resolve))

		expect(open).toHaveBeenCalledOnce()
	})

	it("posts authRevoked once after the server rejects the session, then answers unauthenticated", async () => {
		const fake = opensEngine()
		const host = setup()

		host.send(init())
		await vi.waitFor(() => {
			expect(host.of("ready")).toHaveLength(1)
		})

		fake.engine.listPairs.mockRejectedValue(sdkError(fakeSdk.ErrorKind.Unauthenticated))
		host.send({ t: "call", id: 1, op: "listPairs", args: {} })
		await vi.waitFor(() => {
			expect(host.replyTo(1)).toEqual({ t: "reply", id: 1, ok: false, error: { code: "unauthenticated" } })
		})

		const engineCalls = fake.engine.listPairs.mock.calls.length

		host.send({ t: "call", id: 2, op: "listPairs", args: {} })
		host.send({ t: "call", id: 3, op: "transfersCancel", args: { ids: [TRANSFER] } })
		await vi.waitFor(() => {
			expect(host.replyTo(3)).toBeDefined()
		})

		expect(host.replyTo(2)).toEqual({ t: "reply", id: 2, ok: false, error: { code: "unauthenticated" } })
		expect(host.replyTo(3)).toEqual({ t: "reply", id: 3, ok: false, error: { code: "unauthenticated" } })
		expect(fake.engine.listPairs.mock.calls.length).toBe(engineCalls)
		expect(host.of("authRevoked")).toHaveLength(1)
	})

	it("shuts down once: one stopped, one exit(0), and transfer calls answer hostUnavailable after", async () => {
		const fake = opensEngine()
		const host = setup()

		host.send(init())
		await vi.waitFor(() => {
			expect(host.of("ready")).toHaveLength(1)
		})

		host.send({ t: "shutdown" })
		host.send({ t: "shutdown" })
		host.send({ t: "call", id: 1, op: "transfersCancel", args: { ids: [TRANSFER] } })
		await vi.waitFor(() => {
			expect(host.exit).toHaveBeenCalled()
		})
		await new Promise(resolve => setImmediate(resolve))

		expect(host.of("stopped")).toHaveLength(1)
		expect(host.exit).toHaveBeenCalledOnce()
		expect(host.exit).toHaveBeenCalledWith(0)
		expect(fake.engine.close).toHaveBeenCalledOnce()
		expect(host.replyTo(1)).toEqual({ t: "reply", id: 1, ok: false, error: { code: "hostUnavailable" } })
	})
})
