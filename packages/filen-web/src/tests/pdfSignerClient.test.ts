import { readFileSync } from "node:fs"
import { webcrypto } from "node:crypto"
import { afterEach, describe, expect, it, vi } from "vitest"
import * as Comlink from "comlink"
import forge from "node-forge"
import { createPdfSignerApi } from "@/features/pdf/workers/pdfSignerCore"

// The page side of the signer with both workers played on this thread (the core over Comlink on a MessageChannel):
// a modern container never starts the legacy signer; a legacy one is read again there and signed with.

const started: string[] = []
const stopped: string[] = []

function fakeWorker(kind: string, legacy: boolean) {
	return class {
		private readonly port: MessagePort

		constructor() {
			const { port1, port2 } = new MessageChannel()

			started.push(kind)
			Comlink.expose(createPdfSignerApi(webcrypto.subtle, legacy ? forge : null), port2)
			this.port = port1
		}

		postMessage(message: unknown, transfer: Transferable[]): void {
			this.port.postMessage(message, transfer)
		}

		addEventListener(type: "message", listener: (event: MessageEvent) => void): void {
			this.port.addEventListener(type, listener)
			this.port.start()
		}

		removeEventListener(type: "message", listener: (event: MessageEvent) => void): void {
			this.port.removeEventListener(type, listener)
		}

		terminate(): void {
			stopped.push(kind)
			this.port.close()
		}
	}
}

vi.mock("@/features/pdf/workers/pdfSigner.worker.ts?worker", () => ({ default: fakeWorker("signer", false) }))
vi.mock("@/features/pdf/workers/pdfSignerLegacy.worker.ts?worker", () => ({ default: fakeWorker("legacy", true) }))
vi.mock("@/lib/sdk/client", () => ({ sdkApi: {} }))

const { openPdfSigner } = await import("@/features/pdf/signing/signerClient")

function p12(name: string): File {
	return new File(
		[readFileSync(new URL(`../../../filen-office/src/tests/fixtures/pdfsign/p12/${name}.p12`, import.meta.url))],
		`${name}.p12`
	)
}

afterEach(() => {
	started.length = 0
	stopped.length = 0
})

describe("the certificate signer's workers", () => {
	it("signs with a modern container without starting the legacy signer", async () => {
		const opened = await openPdfSigner({ kind: "device", file: p12("p256") })

		if (!opened.ok) throw new Error(opened.reason)

		expect((await opened.signer.unlock("fixture-password")).ok).toBe(true)
		expect((await opened.signer.sign(new Uint8Array(32))).length).toBeGreaterThan(0)

		opened.signer.terminate()

		expect(started).toEqual(["signer"])
		expect(stopped).toEqual(["signer"])
	})

	it("reads a legacy container again in the legacy signer and signs there", async () => {
		const opened = await openPdfSigner({ kind: "device", file: p12("legacy-3des") })

		if (!opened.ok) throw new Error(opened.reason)

		// The container's integrity check needs no legacy cipher: a wrong password is told without the legacy signer.
		expect(await opened.signer.unlock("wrong")).toEqual({ ok: false, reason: "password" })
		expect(started).toEqual(["signer"])
		expect((await opened.signer.unlock("fixture-password")).ok).toBe(true)
		expect(stopped).toEqual(["signer"])
		expect((await opened.signer.sign(new Uint8Array(32))).length).toBeGreaterThan(0)

		opened.signer.terminate()

		expect(started).toEqual(["signer", "legacy"])
		expect(stopped).toEqual(["signer", "legacy"])
	})

	it("starts the legacy signer once for a key no signer takes", async () => {
		const opened = await openPdfSigner({ kind: "device", file: p12("brainpool") })

		if (!opened.ok) throw new Error(opened.reason)

		expect(await opened.signer.unlock("fixture-password")).toEqual({ ok: false, reason: "algorithm" })
		expect(await opened.signer.unlock("fixture-password")).toEqual({ ok: false, reason: "algorithm" })
		expect(started).toEqual(["signer", "legacy"])

		opened.signer.terminate()
	})
})
