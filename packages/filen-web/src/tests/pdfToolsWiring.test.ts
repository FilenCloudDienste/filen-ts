import { describe, expect, it, vi } from "vitest"
import { PDF_DESKTOP_MEMORY } from "@filen/office/core/pdfedit"
import { PageViewport } from "@filen/office/react/pdfedit"

vi.mock("@/lib/keymap/kbd.logic", () => ({ isMacPlatform: () => false }))
vi.mock("@/lib/log", () => ({ log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }))

const { changedSpan, displayToSurface, displayTransform, surfaceToDisplay } = await import("@/features/pdf/textEdit/textEdit.logic")
const { signsInOneVersion, signWithCertificate } = await import("@/features/pdf/signing/signDocument")

type SigningDeps = import("@/features/pdf/signing/signDocument").PdfSigningDeps
type PdfSigningRequest = import("@/features/pdf/signing/signDocument").PdfSigningRequest

describe("what a text edit replaces", () => {
	it("is the changed word alone, its neighbours kept", () => {
		const before = "Hello brave new world"

		expect(changedSpan(before, "Hello bold new world")).toEqual({ start: 6, end: 11, text: "bold" })
		expect(changedSpan(before, "Hello braver new world")).toEqual({ start: 6, end: 11, text: "braver" })
		expect(changedSpan(before, "Hello brave new worlds")).toEqual({ start: 16, end: 21, text: "worlds" })
		expect(changedSpan(before, "Jello brave new world")).toEqual({ start: 0, end: 5, text: "Jello" })
		expect(changedSpan(before, before)).toBeNull()
	})

	it("spans several words when several changed, and deletes", () => {
		expect(changedSpan("one two three four", "one 2 3 four")).toEqual({ start: 4, end: 13, text: "2 3" })
		expect(changedSpan("Hello brave new world", "Hello new world")).toEqual({ start: 6, end: 12, text: "" })
	})

	it("anchors text inserted between words on the next word, or the last at the end", () => {
		expect(changedSpan("Hello world", "Hello big world")).toEqual({ start: 6, end: 11, text: "big world" })
		expect(changedSpan("Hello world", "Hello world again")).toEqual({ start: 6, end: 11, text: "world again" })
	})
})

describe("page surface and display space", () => {
	const viewport = (rotation: 0 | 90 | 180 | 270) => new PageViewport({ viewBox: [0, 0, 600, 800], scale: 2, rotation })

	it("maps a click to the engine's display space and back, at any view rotation", () => {
		for (const rotation of [0, 90, 180, 270] as const) {
			const geometry = viewport(rotation)
			const [x, y] = displayToSurface(geometry, 100, 50)
			const [dx, dy] = surfaceToDisplay(geometry, x, y)

			expect(dx).toBeCloseTo(100)
			expect(dy).toBeCloseTo(50)
		}

		expect(displayToSurface(viewport(0), 100, 50)).toEqual([200, 100])
	})

	it("lays content drawn at display × scale onto the page box", () => {
		expect(displayTransform(viewport(0))).toBe("matrix(1, 0, 0, 1, 0, 0)")

		const turned = displayTransform(viewport(90))
		const [a, b, c, d, e, f] = (/matrix\((.*)\)/.exec(turned)?.[1] ?? "").split(", ").map(Number)
		// Display (100, 50) drawn at scale 2 lands where displayToSurface puts it.
		const [x, y] = displayToSurface(viewport(90), 100, 50)

		expect((a ?? 0) * 200 + (c ?? 0) * 100 + (e ?? 0)).toBeCloseTo(x)
		expect((b ?? 0) * 200 + (d ?? 0) * 100 + (f ?? 0)).toBeCloseTo(y)
	})
})

describe("signing with a certificate", () => {
	const MIB = 1024 * 1024

	it("keeps unsaved changes and the signature in one version when they fit together", () => {
		expect(signsInOneVersion(false, false, 300 * MIB, PDF_DESKTOP_MEMORY)).toBe(true)
		expect(signsInOneVersion(true, true, 300 * MIB, PDF_DESKTOP_MEMORY)).toBe(true)
		expect(signsInOneVersion(true, false, 10 * MIB, PDF_DESKTOP_MEMORY)).toBe(true)
		expect(signsInOneVersion(true, false, 120 * MIB, PDF_DESKTOP_MEMORY)).toBe(false)
	})

	function harness(options: { dirty: boolean; size: number; saves: boolean[] }) {
		const calls: string[] = []
		const signer = {
			unlock: vi.fn(),
			sign: vi.fn(),
			terminate: vi.fn(() => {
				calls.push("terminate")
			})
		}
		const session = {
			getSnapshot: () => ({ state: { dirty: options.dirty, signatures: { fields: [] } } }),
			dispatch: vi.fn((command: string, _args: unknown) => {
				calls.push(command)

				return Promise.resolve({})
			}),
			discardSignature: vi.fn(() => {
				calls.push("discard")

				return Promise.resolve({})
			})
		}
		const deps: SigningDeps = {
			session: read => read(session as never),
			fileSize: () => options.size,
			memory: PDF_DESKTOP_MEMORY,
			save: job => {
				calls.push(job === null ? "save" : "signedSave")

				return Promise.resolve(options.saves.shift() ?? false)
			},
			job: (jobSigner, digest) => ({
				signer: jobSigner,
				digest,
				hints: () => Promise.resolve([]),
				onSigned: vi.fn()
			}),
			onSaveChangesFirst: () => calls.push("notice"),
			onFailed: () => calls.push("failed")
		}
		const request: PdfSigningRequest = {
			signer,
			summary: { digest: "SHA-256", capacity: 4000 } as unknown as PdfSigningRequest["summary"],
			field: {
				placement: { kind: "rect" as const, page: 0, rect: [0, 0, 100, 40] },
				visual: null,
				lines: [],
				name: null,
				reason: null,
				location: null,
				certify: null
			}
		}

		return { calls, deps, request, session }
	}

	it("places, signs as the save's last step and terminates the signer", async () => {
		const { calls, deps, request, session } = harness({ dirty: true, size: 1000, saves: [true] })

		expect(await signWithCertificate(deps, request)).toBe(true)
		expect(calls).toEqual(["sign.addField", "signedSave", "terminate"])
		expect(session.dispatch.mock.calls[0]?.[1]).toMatchObject({ capacity: 4000, placement: request.field.placement })
	})

	it("saves the changes first when they and the signature do not fit together, and says so", async () => {
		const { calls, deps, request } = harness({ dirty: true, size: 200 * MIB, saves: [true, true] })

		expect(await signWithCertificate(deps, request)).toBe(true)
		expect(calls).toEqual(["notice", "save", "sign.addField", "signedSave", "terminate"])
	})

	it("takes the placed signature back when the signed save did not happen", async () => {
		const { calls, deps, request } = harness({ dirty: false, size: 1000, saves: [false] })

		expect(await signWithCertificate(deps, request)).toBe(false)
		expect(calls).toEqual(["sign.addField", "signedSave", "terminate", "discard"])
	})

	it("stops before placing when the changes could not be saved first", async () => {
		const { calls, deps, request } = harness({ dirty: true, size: 200 * MIB, saves: [false] })

		expect(await signWithCertificate(deps, request)).toBe(false)
		expect(calls).toEqual(["notice", "save", "terminate"])
	})
})
