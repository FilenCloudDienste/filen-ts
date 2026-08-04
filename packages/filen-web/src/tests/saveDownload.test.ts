import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { AnyFile, ZipItem } from "@filen/sdk-rs"
import { type SwSaveTarget } from "@/features/drive/lib/saveDownload"
import {
	SW_DOWNLOAD_PREFIX,
	SW_ERROR_NO_CLIENT,
	SW_MSG_INIT_CLIENT,
	SW_MSG_LOGOUT,
	SW_MSG_REGISTER_DOWNLOAD,
	SW_MSG_REGISTER_ZIP_DOWNLOAD
} from "@/lib/sw/protocol"

// saveDownload.ts keeps its SW-client-ready state in a module-level `let` (mirrors
// lib/sw/register.ts) — every test that touches the sw path needs its own module instance, so
// tests dynamically re-import after vi.resetModules() instead of relying on a single static import
// (same freshModule() pattern as lib/sw/register.test.ts). sdkApi is mocked module-wide up front;
// vi.mock is hoisted above imports regardless of where it's written.
const { toStringified } = vi.hoisted(() => ({ toStringified: vi.fn() }))

vi.mock("@/lib/sdk/client", () => ({ sdkApi: { toStringified } }))

async function freshModule() {
	vi.resetModules()
	return import("@/features/drive/lib/saveDownload")
}

// --- fake MessageChannel: two cross-linked ports, mirroring real browser delivery semantics ---
class FakeMessagePort {
	onmessage: ((event: { data: unknown }) => void) | null = null
	closed = false
	private peer: FakeMessagePort | null = null
	link(peer: FakeMessagePort): void {
		this.peer = peer
	}
	postMessage(data: unknown): void {
		this.peer?.onmessage?.({ data })
	}
	close(): void {
		this.closed = true
	}
}

const openChannels: FakeMessageChannel[] = []

class FakeMessageChannel {
	port1 = new FakeMessagePort()
	port2 = new FakeMessagePort()
	constructor() {
		this.port1.link(this.port2)
		this.port2.link(this.port1)
		openChannels.push(this)
	}
}

type SwReply = { ok: true } | { ok: false; error: string } | null

// A fake controlling service worker — postMessage(msg, [port2]) replies through the transferred
// port2 per a scripted `reply` callback, exactly mirroring sw.ts's own ack shape. A `null` reply is a
// worker that never acks at all.
function fakeServiceWorker(reply: (type: string, payload: Record<string, unknown>) => SwReply) {
	const calls: { type: string; payload: Record<string, unknown> }[] = []
	const postMessage = vi.fn((msg: { type: string } & Record<string, unknown>, transfer: [FakeMessagePort]) => {
		const { type, ...payload } = msg
		calls.push({ type, payload })
		const [port2] = transfer
		const ack = reply(type, payload)

		if (ack !== null) {
			port2.postMessage(ack)
		}
	})
	return { postMessage, calls }
}

function stubServiceWorkerReady(active: ReturnType<typeof fakeServiceWorker> | null): void {
	vi.stubGlobal("navigator", { serviceWorker: { ready: Promise.resolve({ active }), controller: active } })
}

// wipeSwClient targets navigator.serviceWorker.controller directly (never `.ready`, which would block
// forever with no worker) — this stubs that surface, plus `.ready` so a follow-up saveDownload can
// still re-init after the wipe cleared the memo.
function stubServiceWorkerController(controller: ReturnType<typeof fakeServiceWorker> | null): void {
	vi.stubGlobal("navigator", { serviceWorker: { controller, ready: Promise.resolve({ active: controller }) } })
}

function stubWindow(overrides: Record<string, unknown> = {}): { href: string } {
	const location = { href: "" }
	vi.stubGlobal("window", { location, ...overrides })
	return location
}

function testFile(overrides: Partial<AnyFile> = {}): AnyFile {
	return {
		uuid: "file-uuid",
		meta: { type: "encrypted", data: "x" },
		parent: "parent-uuid",
		size: 1_024n,
		favorited: false,
		region: "de-1",
		bucket: "filen-1",
		timestamp: 0n,
		chunks: 1n,
		canMakeThumbnail: false,
		...overrides
	} as AnyFile
}

beforeEach(() => {
	vi.stubGlobal("MessageChannel", FakeMessageChannel)
	openChannels.length = 0
	toStringified.mockReset()
	toStringified.mockResolvedValue({ email: "user@filen.io" })
})

afterEach(() => {
	vi.unstubAllGlobals()
	vi.clearAllMocks()
})

describe("isFsaAvailable", () => {
	it("true when window.showSaveFilePicker is a function", async () => {
		stubWindow({ showSaveFilePicker: vi.fn() })
		const { isFsaAvailable } = await freshModule()

		expect(isFsaAvailable()).toBe(true)
	})

	it("false when window.showSaveFilePicker is absent", async () => {
		stubWindow()
		const { isFsaAvailable } = await freshModule()

		expect(isFsaAvailable()).toBe(false)
	})
})

describe("isPickerCancelled", () => {
	it("true for an AbortError-named rejection", async () => {
		const { isPickerCancelled } = await freshModule()

		expect(isPickerCancelled(new DOMException("aborted", "AbortError"))).toBe(true)
		expect(isPickerCancelled({ name: "AbortError" })).toBe(true)
	})

	it("false for any other error shape", async () => {
		const { isPickerCancelled } = await freshModule()

		expect(isPickerCancelled(new Error("disk full"))).toBe(false)
		expect(isPickerCancelled({ name: "NotAllowedError" })).toBe(false)
		expect(isPickerCancelled(null)).toBe(false)
		expect(isPickerCancelled("nope")).toBe(false)
	})
})

describe("saveDownload — FSA branch", () => {
	it("picks showSaveFilePicker -> createWritable and returns a fsa target", async () => {
		const writable = { fake: "writable" }
		const createWritable = vi.fn().mockResolvedValue(writable)
		const showSaveFilePicker = vi.fn().mockResolvedValue({ kind: "file", name: "report.pdf", createWritable })
		stubWindow({ showSaveFilePicker })

		const { saveDownload } = await freshModule()
		const target = await saveDownload("report.pdf")

		expect(showSaveFilePicker).toHaveBeenCalledWith({ suggestedName: "report.pdf" })
		expect(createWritable).toHaveBeenCalledTimes(1)
		expect(target).toEqual({ kind: "fsa", writable })
	})

	it("propagates a picker-cancel rejection (caller decides it's a clean no-op)", async () => {
		const showSaveFilePicker = vi.fn().mockRejectedValue(new DOMException("The user aborted a request.", "AbortError"))
		stubWindow({ showSaveFilePicker })

		const { saveDownload, isPickerCancelled } = await freshModule()

		await expect(saveDownload("report.pdf")).rejects.toSatisfy((e: unknown) => isPickerCancelled(e))
	})

	it("never touches the service worker on the FSA path", async () => {
		const createWritable = vi.fn().mockResolvedValue({})
		const showSaveFilePicker = vi.fn().mockResolvedValue({ createWritable })
		stubWindow({ showSaveFilePicker })
		stubServiceWorkerReady(fakeServiceWorker(() => ({ ok: true })))

		const { saveDownload } = await freshModule()
		await saveDownload("report.pdf")

		expect(toStringified).not.toHaveBeenCalled()
	})
})

describe("saveDownload — sw branch (no FSA)", () => {
	it("inits the sw client and returns a sw target addressed at SW_DOWNLOAD_PREFIX", async () => {
		stubWindow()
		const sw = fakeServiceWorker(() => ({ ok: true }))
		stubServiceWorkerReady(sw)

		const { saveDownload } = await freshModule()
		const target = await saveDownload("report.pdf")

		expect(toStringified).toHaveBeenCalledTimes(1)
		expect(sw.calls).toEqual([{ type: SW_MSG_INIT_CLIENT, payload: { blob: { email: "user@filen.io" } } }])

		if (target.kind !== "sw") {
			throw new Error("expected a sw target")
		}

		expect(target.name).toBe("report.pdf")
		expect(target.url).toBe(`${SW_DOWNLOAD_PREFIX}${target.id}`)
	})

	it("memoizes the sw-client-ready handshake across multiple saveDownload calls", async () => {
		stubWindow()
		const sw = fakeServiceWorker(() => ({ ok: true }))
		stubServiceWorkerReady(sw)

		const { saveDownload } = await freshModule()
		await saveDownload("a.txt")
		await saveDownload("b.txt")

		expect(toStringified).toHaveBeenCalledTimes(1)
		expect(sw.calls).toHaveLength(1)
	})

	it("mints a distinct id per call", async () => {
		stubWindow()
		stubServiceWorkerReady(fakeServiceWorker(() => ({ ok: true })))

		const { saveDownload } = await freshModule()
		const a = await saveDownload("a.txt")
		const b = await saveDownload("b.txt")

		if (a.kind !== "sw" || b.kind !== "sw") {
			throw new Error("expected sw targets")
		}

		expect(a.id).not.toBe(b.id)
	})

	it("rejects when the sw init handshake fails, and does not poison future calls", async () => {
		stubWindow()
		let shouldFail = true
		const sw = fakeServiceWorker(type => (type === SW_MSG_INIT_CLIENT && shouldFail ? { ok: false, error: "boom" } : { ok: true }))
		stubServiceWorkerReady(sw)

		const { saveDownload } = await freshModule()

		await expect(saveDownload("a.txt")).rejects.toThrow("boom")

		shouldFail = false
		await expect(saveDownload("a.txt")).resolves.toMatchObject({ kind: "sw" })
		expect(toStringified).toHaveBeenCalledTimes(2) // first attempt failed, memo cleared, second retried
	})

	it("rejects when no service worker is active yet", async () => {
		stubWindow()
		stubServiceWorkerReady(null)

		const { saveDownload } = await freshModule()

		await expect(saveDownload("a.txt")).rejects.toThrow()
	})
})

describe("triggerSwDownload", () => {
	it("registers the file against the token, then navigates via a plain location assignment", async () => {
		const sw = fakeServiceWorker(() => ({ ok: true }))
		const location = stubWindow()
		stubServiceWorkerReady(sw)

		const { triggerSwDownload } = await freshModule()
		const file = testFile({ size: 2_048n })
		const save: SwSaveTarget = { kind: "sw", id: "abc-123", url: `${SW_DOWNLOAD_PREFIX}abc-123`, name: "report.pdf" }

		await triggerSwDownload(file, save)

		expect(sw.calls).toEqual([
			{ type: SW_MSG_INIT_CLIENT, payload: { blob: { email: "user@filen.io" } } },
			{ type: SW_MSG_REGISTER_DOWNLOAD, payload: { id: "abc-123", file, name: "report.pdf", size: 2_048 } }
		])
		expect(location.href).toBe(`${SW_DOWNLOAD_PREFIX}abc-123`)
	})

	it("does not navigate when registration fails", async () => {
		const sw = fakeServiceWorker(() => ({ ok: false, error: "no room" }))
		const location = stubWindow()
		stubServiceWorkerReady(sw)

		const { triggerSwDownload } = await freshModule()
		const save: SwSaveTarget = { kind: "sw", id: "abc-123", url: `${SW_DOWNLOAD_PREFIX}abc-123`, name: "report.pdf" }

		await expect(triggerSwDownload(testFile(), save)).rejects.toThrow("no room")
		expect(location.href).toBe("")
	})
})

// A service worker is terminated whenever it goes idle and restarts with empty module globals — the
// session handed over once per tab is gone, while the page's handoff memo still says it isn't.
function fakeRestartableServiceWorker(): { sw: ReturnType<typeof fakeServiceWorker>; restart: () => void } {
	let hasClient = false
	const sw = fakeServiceWorker(type => {
		if (type === SW_MSG_INIT_CLIENT) {
			hasClient = true

			return { ok: true }
		}

		return hasClient ? { ok: true } : { ok: false, error: SW_ERROR_NO_CLIENT }
	})

	return {
		sw,
		restart: () => {
			hasClient = false
		}
	}
}

describe("registration against a restarted worker", () => {
	it("re-hands the session over and retries the registration once", async () => {
		const location = stubWindow()
		const { sw, restart } = fakeRestartableServiceWorker()
		stubServiceWorkerReady(sw)

		const { saveDownload, triggerSwDownload } = await freshModule()
		const save = await saveDownload("report.pdf")

		if (save.kind !== "sw") {
			throw new Error("expected a sw target")
		}

		restart()

		await triggerSwDownload(testFile(), save)

		expect(sw.calls.map(call => call.type)).toEqual([
			SW_MSG_INIT_CLIENT,
			SW_MSG_REGISTER_DOWNLOAD,
			SW_MSG_INIT_CLIENT,
			SW_MSG_REGISTER_DOWNLOAD
		])
		expect(toStringified).toHaveBeenCalledTimes(2)
		expect(location.href).toBe(save.url)
	})

	it("heals a zip registration the same way", async () => {
		const location = stubWindow()
		const { sw, restart } = fakeRestartableServiceWorker()
		stubServiceWorkerReady(sw)

		const { saveDownload, triggerSwZipDownload } = await freshModule()
		const save = await saveDownload("Filen.zip")

		if (save.kind !== "sw") {
			throw new Error("expected a sw target")
		}

		restart()

		await triggerSwZipDownload([testFile()], save)

		expect(sw.calls.filter(call => call.type === SW_MSG_REGISTER_ZIP_DOWNLOAD)).toHaveLength(2)
		expect(location.href).toBe(save.url)
	})

	it("hands the session over only once for concurrent registrations", async () => {
		stubWindow()
		const { sw, restart } = fakeRestartableServiceWorker()
		stubServiceWorkerReady(sw)

		const { saveDownload, triggerSwDownload, triggerSwZipDownload } = await freshModule()
		const first = await saveDownload("a.txt")
		const second = await saveDownload("b.txt")

		if (first.kind !== "sw" || second.kind !== "sw") {
			throw new Error("expected sw targets")
		}

		restart()

		await Promise.all([triggerSwDownload(testFile(), first), triggerSwZipDownload([testFile()], second)])

		// One handoff at boot + exactly one heal, never one per registration: each handoff frees the
		// worker's previous client, which a stream started in between would still be holding.
		expect(sw.calls.filter(call => call.type === SW_MSG_INIT_CLIENT)).toHaveLength(2)
		expect(toStringified).toHaveBeenCalledTimes(2)
	})

	it("never re-inits or retries on any other registration failure", async () => {
		stubWindow()
		const sw = fakeServiceWorker(type => (type === SW_MSG_INIT_CLIENT ? { ok: true } : { ok: false, error: "no room" }))
		stubServiceWorkerReady(sw)

		const { saveDownload, triggerSwDownload } = await freshModule()
		const save = await saveDownload("a.txt")

		if (save.kind !== "sw") {
			throw new Error("expected a sw target")
		}

		await expect(triggerSwDownload(testFile(), save)).rejects.toThrow("no room")

		expect(sw.calls.filter(call => call.type === SW_MSG_INIT_CLIENT)).toHaveLength(1)
		expect(sw.calls.filter(call => call.type === SW_MSG_REGISTER_DOWNLOAD)).toHaveLength(1)
	})
})

describe("sendToSw", () => {
	it("closes the message port once the worker acks", async () => {
		stubWindow()
		stubServiceWorkerReady(fakeServiceWorker(() => ({ ok: true })))

		const { saveDownload } = await freshModule()
		await saveDownload("a.txt")

		expect(openChannels).toHaveLength(1)
		expect(openChannels.every(channel => channel.port1.closed)).toBe(true)
	})

	it("rejects instead of pending forever when the worker never acks", async () => {
		vi.useFakeTimers()

		try {
			stubWindow()
			stubServiceWorkerReady(fakeServiceWorker(() => null))

			const { saveDownload } = await freshModule()
			const pending = expect(saveDownload("a.txt")).rejects.toThrow("service worker did not respond")

			await vi.advanceTimersByTimeAsync(20_000)
			await pending

			expect(openChannels.every(channel => channel.port1.closed)).toBe(true)
		} finally {
			vi.useRealTimers()
		}
	})
})

describe("wipeSwClient", () => {
	it("posts SW_MSG_LOGOUT to the controlling worker so no key material survives sign-out", async () => {
		stubWindow()
		const sw = fakeServiceWorker(() => ({ ok: true }))
		stubServiceWorkerController(sw)

		const { wipeSwClient } = await freshModule()
		await wipeSwClient()

		expect(sw.calls).toEqual([{ type: SW_MSG_LOGOUT, payload: {} }])
	})

	it("never lets a failed or missing ack wedge sign-out", async () => {
		stubWindow()
		stubServiceWorkerController(fakeServiceWorker(() => ({ ok: false, error: "worker is gone" })))

		const { wipeSwClient } = await freshModule()

		await expect(wipeSwClient()).resolves.toBeUndefined()
	})

	it("is a no-op when no worker controls the page (never blocks logout)", async () => {
		stubWindow()
		stubServiceWorkerController(null)

		const { wipeSwClient } = await freshModule()

		await expect(wipeSwClient()).resolves.toBeUndefined()
	})

	it("clears the client-ready memo so the next sign-in re-inits a fresh sw client", async () => {
		stubWindow()
		const sw = fakeServiceWorker(() => ({ ok: true }))
		stubServiceWorkerController(sw)

		const { saveDownload, wipeSwClient } = await freshModule()

		await saveDownload("a.txt")
		expect(toStringified).toHaveBeenCalledTimes(1)

		await wipeSwClient()

		await saveDownload("b.txt")
		expect(toStringified).toHaveBeenCalledTimes(2)
	})
})

describe("triggerSwZipDownload", () => {
	it("registers the items against the token (no size), then navigates via a plain location assignment", async () => {
		const sw = fakeServiceWorker(() => ({ ok: true }))
		const location = stubWindow()
		stubServiceWorkerReady(sw)

		const { triggerSwZipDownload } = await freshModule()
		const items: ZipItem[] = [testFile({ size: 2_048n }), testFile({ size: 512n })]
		const save: SwSaveTarget = { kind: "sw", id: "abc-123", url: `${SW_DOWNLOAD_PREFIX}abc-123`, name: "Filen.zip" }

		await triggerSwZipDownload(items, save)

		expect(sw.calls).toEqual([
			{ type: SW_MSG_INIT_CLIENT, payload: { blob: { email: "user@filen.io" } } },
			{ type: SW_MSG_REGISTER_ZIP_DOWNLOAD, payload: { id: "abc-123", items, name: "Filen.zip" } }
		])
		expect(location.href).toBe(`${SW_DOWNLOAD_PREFIX}abc-123`)
	})

	it("does not navigate when registration fails", async () => {
		const sw = fakeServiceWorker(() => ({ ok: false, error: "no room" }))
		const location = stubWindow()
		stubServiceWorkerReady(sw)

		const { triggerSwZipDownload } = await freshModule()
		const save: SwSaveTarget = { kind: "sw", id: "abc-123", url: `${SW_DOWNLOAD_PREFIX}abc-123`, name: "Filen.zip" }

		await expect(triggerSwZipDownload([testFile()], save)).rejects.toThrow("no room")
		expect(location.href).toBe("")
	})
})
