// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, createEvent, fireEvent, render, screen } from "@testing-library/react"
import { createElement } from "react"
import { QueryClient } from "@tanstack/react-query"
import "@/lib/i18n"

const { uploadDroppedFiles } = vi.hoisted(() => ({ uploadDroppedFiles: vi.fn() }))

vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))
vi.mock("@/features/drive/lib/uploadDrop", async importOriginal => ({
	...(await importOriginal<typeof import("@/features/drive/lib/uploadDrop")>()),
	uploadDroppedFiles
}))

import { UploadDropzone } from "@/features/drive/components/uploadDropzone"

function renderZone() {
	render(createElement(UploadDropzone, { parentUuid: null, children: createElement("div", { "data-testid": "inside" }) }))

	return screen.getByTestId("inside")
}

function drag(type: "dragEnter" | "dragOver" | "drop", element: Element, types: string[]): Event {
	const event = createEvent[type](element, { dataTransfer: { types, dropEffect: "none", items: [], files: [] } })

	fireEvent(element, event)

	return event
}

afterEach(() => {
	cleanup()
})

describe("the listing's upload dropzone", () => {
	it("an OS file drop still reaches the upload dropzone", () => {
		const inside = renderZone()

		drag("dragEnter", inside, ["Files"])
		expect(drag("dragOver", inside, ["Files"]).defaultPrevented).toBe(true)
		drag("drop", inside, ["Files"])

		expect(uploadDroppedFiles).toHaveBeenCalledExactlyOnceWith(expect.anything(), null)
	})

	it("leaves any other HTML5 drag alone, so dropping text uploads nothing", () => {
		const inside = renderZone()

		drag("dragEnter", inside, ["text/plain"])
		expect(drag("dragOver", inside, ["text/plain"]).defaultPrevented).toBe(false)
		drag("drop", inside, ["text/plain"])

		expect(uploadDroppedFiles).not.toHaveBeenCalled()
	})
})
