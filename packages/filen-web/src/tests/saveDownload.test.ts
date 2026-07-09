import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { AnyFile, ZipItem } from "@filen/sdk-rs"
import { type SwSaveTarget } from "@/features/drive/lib/saveDownload"
import { SW_DOWNLOAD_PREFIX, SW_MSG_INIT_CLIENT, SW_MSG_REGISTER_DOWNLOAD, SW_MSG_REGISTER_ZIP_DOWNLOAD } from "@/lib/sw/protocol"

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
	private peer: FakeMessagePort | null = null
	link(peer: FakeMessagePort): void {
		this.peer = peer
	}
	postMessage(data: unknown): void {
		this.peer?.onmessage?.({ data })
	}
}

class FakeMessageChannel {
	port1 = new FakeMessagePort()
	port2 = new FakeMessagePort()
	constructor() {
		this.port1.link(this.port2)
		this.port2.link(this.port1)
	}
}

type SwReply = { ok: true } | { ok: false; error: string }

// A fake controlling service worker — postMessage(msg, [port2]) replies through the transferred
// port2 per a scripted `reply` callback, exactly mirroring sw.ts's own ack shape.
function fakeServiceWorker(reply: (type: string, payload: Record<string, unknown>) => SwReply) {
	const calls: { type: string; payload: Record<string, unknown> }[] = []
	const postMessage = vi.fn((msg: { type: string } & Record<string, unknown>, transfer: [FakeMessagePort]) => {
		const { type, ...payload } = msg
		calls.push({ type, payload })
		const [port2] = transfer
		port2.postMessage(reply(type, payload))
	})
	return { postMessage, calls }
}

function stubServiceWorkerReady(active: ReturnType<typeof fakeServiceWorker> | null): void {
	vi.stubGlobal("navigator", { serviceWorker: { ready: Promise.resolve({ active }) } })
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

		expect(sw.calls).toEqual([{ type: SW_MSG_REGISTER_DOWNLOAD, payload: { id: "abc-123", file, name: "report.pdf", size: 2_048 } }])
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

describe("triggerSwZipDownload", () => {
	it("registers the items against the token (no size), then navigates via a plain location assignment", async () => {
		const sw = fakeServiceWorker(() => ({ ok: true }))
		const location = stubWindow()
		stubServiceWorkerReady(sw)

		const { triggerSwZipDownload } = await freshModule()
		const items: ZipItem[] = [testFile({ size: 2_048n }), testFile({ size: 512n })]
		const save: SwSaveTarget = { kind: "sw", id: "abc-123", url: `${SW_DOWNLOAD_PREFIX}abc-123`, name: "Filen.zip" }

		await triggerSwZipDownload(items, save)

		expect(sw.calls).toEqual([{ type: SW_MSG_REGISTER_ZIP_DOWNLOAD, payload: { id: "abc-123", items, name: "Filen.zip" } }])
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
