// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { act, renderHook, waitFor } from "@testing-library/react"
import "@/lib/i18n"
import type { PdfEditSessionModel } from "@filen/office/react/pdfedit"
import type { PdfEditPhase } from "@/features/pdf/session/swap"
import type { PdfEngine } from "@/features/pdf/session/engineWorker"
import type { PdfToolSaveOutcome } from "@/features/pdf/tools/registry"
import { linkedFileItem } from "@/tests/fixtures/sdk"

// The viewer's editing hook as a tool's save request goes through it: the overlay's Save refused before the save
// itself (a flatten that fails, a hold taken during a tool's step) still ends the request, a signing save skips the
// flatten, and the viewer going away releases the second PDFs held for inserting after the editor closed.

vi.mock("@/features/pdf/save/remoteChange", () => ({
	checkRemoteHead: () => Promise.reject(new Error("offline"))
}))

vi.mock("@/lib/storage/adapter", () => ({
	kvGetJson: () => Promise.resolve(null),
	kvSetJson: () => Promise.resolve(),
	kvKeys: () => Promise.resolve([]),
	kvDelete: () => Promise.resolve(),
	kvGet: () => Promise.resolve(null),
	kvHas: () => Promise.resolve(false),
	kvEntriesJson: () => Promise.resolve([]),
	kvEntriesJsonInSlices: () => Promise.resolve([]),
	kvDeletePrefix: () => Promise.resolve(),
	kvDeleteIfAt: () => Promise.resolve([]),
	isMissingStorageMethod: () => false
}))

const { usePdfEdit } = await import("@/features/pdf/session/usePdfEdit")
const { PdfEditSwap } = await import("@/features/pdf/session/swap")
const { PdfPagesController } = await import("@/features/pdf/pages/pagesController")

const STATE = {
	revision: 1,
	pageCount: 1,
	dirty: true,
	canUndo: true,
	canRedo: false,
	undoLabel: null,
	redoLabel: null,
	changes: [],
	versions: 1,
	signatures: { fields: [] },
	restrictions: { owner: true, edit: true, annotate: true, form: true, assemble: true, print: true },
	tools: { content: null },
	encryption: { method: "None", access: "owner" },
	security: { pending: null },
	redacting: false,
	tagged: false,
	ownFile: false
}

// An editor session whose commands are recorded; `flatten` decides how annotations.flatten ends.
function fakeSession(flatten: () => Promise<unknown> = () => Promise.resolve({})) {
	const dispatched: string[] = []
	const snapshot = { state: STATE, pending: 0, document: { facts: { signatures: null } } }
	const session = {
		subscribe: () => () => undefined,
		getSnapshot: () => snapshot,
		dispatch: (command: string) => {
			dispatched.push(command)

			return command === "annotations.flatten" ? flatten() : Promise.resolve({ pages: [], state: STATE, widgets: [] })
		},
		discardSignature: () => Promise.resolve({}),
		engine: { call: () => Promise.resolve(null) }
	} as unknown as PdfEditSessionModel

	return { session, dispatched }
}

function editing(swap: InstanceType<typeof PdfEditSwap>, session: PdfEditSessionModel): void {
	const engine = { close: () => Promise.resolve({ heapBytes: 0 }), client: { call: () => Promise.resolve(null) } } as unknown as PdfEngine
	const phase: PdfEditPhase = { kind: "editing", engine, session, startedMs: 0, respawned: false, saving: false }

	act(() => {
		;(swap as unknown as { set: (phase: PdfEditPhase) => void }).set(phase)
	})
}

// The hook with an overlay whose Save runs the hook's save source, as the preview overlay does.
function mount() {
	const saves: Promise<unknown>[] = []
	const view: { current: ReturnType<typeof usePdfEdit> | null } = { current: null }
	const host = {
		writable: true,
		onDirtyChange: () => undefined,
		saveRef: { current: null },
		onSave: () => {
			const source = view.current?.saveSource ?? null

			if (source === null) return false

			saves.push(source({ auto: false }).catch(() => undefined))

			return true
		}
	}
	const rendered = renderHook(() => {
		const current = usePdfEdit(linkedFileItem("contract.pdf"), "authed", host)

		view.current = current

		return current
	})

	return { rendered, saves }
}

afterEach(() => {
	vi.useRealTimers()
	vi.restoreAllMocks()
})

describe("a tool's save request", () => {
	it("ends as failed when the flatten before the save fails, and the next Save is not the tool's", async () => {
		const { rendered } = mount()
		const { session, dispatched } = fakeSession(() => Promise.reject(new Error("flatten refused")))

		editing(rendered.result.current.swap, session)
		act(() => {
			rendered.result.current.history?.flatten?.toggle()
		})

		const outcome = await act(() => rendered.result.current.toolContext.host.save({ kind: "version" }))

		expect(outcome.status).toBe("failed")
		expect(dispatched).toEqual(["annotations.flatten"])

		// A later plain Save takes no request: a second tool save asks and ends on its own.
		const second = await act(() => rendered.result.current.toolContext.host.save({ kind: "version" }))

		expect(second.status).toBe("failed")
		expect(dispatched).toEqual(["annotations.flatten", "annotations.flatten"])
		rendered.unmount()
	})

	it("waits for a hold taken during a tool's step instead of handing the save to a source that refuses it", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })

		const { rendered, saves } = mount()
		const { session } = fakeSession()

		editing(rendered.result.current.swap, session)

		let release: () => void = () => undefined

		act(() => {
			release = rendered.result.current.swap.hold()
		})

		let outcome: PdfToolSaveOutcome | null = null

		void rendered.result.current.toolContext.host.save({ kind: "version" }).then(ended => {
			outcome = ended
		})
		// Far past the 20 tries of a save that cannot start: the hold is waited for, the overlay never asked.
		await act(() => vi.advanceTimersByTimeAsync(5_000))
		expect(saves).toHaveLength(0)
		expect(outcome).toBeNull()

		act(() => {
			release()
		})
		await act(() => vi.advanceTimersByTimeAsync(100))
		vi.useRealTimers()
		await waitFor(() => {
			expect(outcome).not.toBeNull()
		})
		expect(saves).toHaveLength(1)
		// The save ran (and failed on the remote check): it was the tool's, not refused for the hold.
		expect(outcome).toMatchObject({ status: "failed" })
		rendered.unmount()
	})

	it("stops waiting on a hold once a Save during it ended the request", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })

		const { rendered, saves } = mount()
		const { session } = fakeSession()

		editing(rendered.result.current.swap, session)

		let release: () => void = () => undefined

		act(() => {
			release = rendered.result.current.swap.hold()
		})

		let outcome: PdfToolSaveOutcome | null = null

		void rendered.result.current.toolContext.host.save({ kind: "version" }).then(ended => {
			outcome = ended
		})
		await act(() => vi.advanceTimersByTimeAsync(200))
		expect(saves).toHaveLength(0)

		// The overlay's Save run directly while the hold is on (as a click would): refused, the request ends.
		const source = rendered.result.current.saveSource

		expect(source).not.toBeNull()
		await act(async () => {
			saves.push(source?.({ auto: false }).catch(() => undefined) ?? Promise.resolve())
			// The waiting poll sees the request ended on its next tick.
			await vi.advanceTimersByTimeAsync(100)
		})
		expect(outcome).toEqual({ status: "cancelled" })

		// The hold ends: the abandoned request does not hand the overlay a save.
		act(() => {
			release()
		})
		await act(() => vi.advanceTimersByTimeAsync(500))
		expect(saves).toHaveLength(1)
		rendered.unmount()
	})

	it("ends as cancelled when the save source refuses because another save holds the document", async () => {
		const { rendered } = mount()
		const { session } = fakeSession()

		editing(rendered.result.current.swap, session)
		act(() => {
			rendered.result.current.swap.hold()
		})

		// The overlay's Save run directly while the hold is on (as a click would): the parked request ends.
		let outcome: PdfToolSaveOutcome | null = null
		const swap = rendered.result.current.swap
		const snapshot = vi.spyOn(swap, "getSnapshot")

		// requestSave reads the phase as unheld once, as it would just before the hold was taken.
		snapshot.mockImplementationOnce(() => ({ kind: "view" }))
		void rendered.result.current.toolContext.host.save({ kind: "version" }).then(ended => {
			outcome = ended
		})
		await waitFor(() => {
			expect(outcome).toEqual({ status: "cancelled" })
		})
		rendered.unmount()
	})

	it("skips the flatten for a signing save", async () => {
		const { rendered } = mount()
		const { session, dispatched } = fakeSession()

		editing(rendered.result.current.swap, session)
		act(() => {
			rendered.result.current.history?.flatten?.toggle()
		})

		const terminate = vi.fn()
		const signed = await act(() =>
			rendered.result.current.toolContext.sign({
				signer: { terminate } as never,
				summary: { digest: "SHA-256", capacity: 4000 } as never,
				field: {
					placement: { kind: "rect", page: 0, rect: [0, 0, 100, 40] },
					visual: null,
					lines: [],
					name: null,
					reason: null,
					location: null,
					certify: null
				}
			})
		)

		expect(signed).toBe(false)
		expect(dispatched).toEqual(["sign.addField"])
		expect(terminate).toHaveBeenCalledTimes(1)
		rendered.unmount()
	})
})

describe("the viewer going away", () => {
	it("closes the editor, then releases the second PDFs held for inserting", () => {
		const order: string[] = []

		vi.spyOn(PdfEditSwap.prototype, "close").mockImplementation(() => {
			order.push("close")
		})
		vi.spyOn(PdfPagesController.prototype, "dispose").mockImplementation(() => {
			order.push("dispose")
		})

		const { rendered } = mount()

		rendered.unmount()
		expect(order).toEqual(["close", "dispose"])
	})
})
