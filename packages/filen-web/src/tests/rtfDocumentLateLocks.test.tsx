// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import { bytesSource } from "@filen/office/core/opc"
import type { DocxRtfDocument, RtfLockedBlock } from "@filen/office/dom/docx/rtf"
import { RtfDocument, type RtfOpened } from "@/features/preview/components/rtfDocument"
import "@/lib/i18n"

// An RTF document opened for editing: the editor opens on the taken copy while the document is proved in the
// worker (its Gate 1 waits for the locks: rtfEditing.test.ts).

const state = vi.hoisted(() => ({
	prove: (): Promise<readonly RtfLockedBlock[]> => new Promise(() => undefined),
	released: 0
}))

vi.mock("@/features/preview/lib/docxEngine", () => ({
	docxRtf: {
		open: () =>
			Promise.resolve({
				kind: "opened",
				document: {
					host: () => {
						throw new Error("no engine in this test")
					},
					bytes: bytesSource(new Uint8Array(0)),
					untranslated: 0,
					gate: [],
					take: () => Promise.resolve(new Uint8Array([1, 2, 3])),
					prove: () => state.prove(),
					write: () => Promise.reject(new Error("no writes in this test")),
					convertEdited: () => Promise.reject(new Error("no conversions in this test")),
					release: () => {
						state.released += 1
					}
				} satisfies DocxRtfDocument
			})
	}
}))

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void } {
	let resolve: (value: T) => void = () => undefined
	let reject: (error: Error) => void = () => undefined
	const promise = new Promise<T>((done, fail) => {
		resolve = done
		reject = fail
	})

	return { promise, resolve, reject }
}

function Shown({ opened }: { opened: RtfOpened }) {
	return <p>{opened.editing === undefined ? "viewing" : `editing ${String(opened.editing.docx.length)}`}</p>
}

describe("RTF document opened for editing before its proof", () => {
	it("hands the editor its copy while the document is still being proved", async () => {
		const proved = deferred<readonly RtfLockedBlock[]>()

		state.prove = () => proved.promise

		render(
			<RtfDocument
				bytes={new Uint8Array([9])}
				edit
			>
				{opened => <Shown opened={opened} />}
			</RtfDocument>
		)

		expect(await screen.findByText("editing 3")).toBeTruthy()
	})

	it("shows the load failure when the proof fails after the editor opened", async () => {
		const proved = deferred<readonly RtfLockedBlock[]>()

		state.prove = () => proved.promise

		render(
			<RtfDocument
				bytes={new Uint8Array([9])}
				edit
			>
				{opened => <Shown opened={opened} />}
			</RtfDocument>
		)

		await screen.findByText("editing 3")
		proved.reject(new Error("worker failed"))
		await waitFor(() => {
			expect(screen.queryByText("editing 3")).toBeNull()
		})
	})

	it("releases the document on close with the proof still pending", async () => {
		state.prove = () => new Promise(() => undefined)
		state.released = 0

		const view = render(
			<RtfDocument
				bytes={new Uint8Array([9])}
				edit
			>
				{opened => <Shown opened={opened} />}
			</RtfDocument>
		)

		await screen.findByText("editing 3")
		view.unmount()
		expect(state.released).toBe(1)
	})
})
