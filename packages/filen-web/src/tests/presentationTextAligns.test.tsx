// @vitest-environment happy-dom

import "@/tests/support/officeKeys"
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen, within } from "@testing-library/react"
import type { TFunction } from "i18next"
import i18n from "i18next"
import { slideRef } from "@filen/office/core/presentation"
import type { OpenInfo, SlideRender } from "@filen/office/dom/presentation"
import { createShapeSelection, createTextEditing, type TextEditController } from "@filen/office/react/presentation"
import { OfficeRibbon } from "@/features/office/components/ribbon/officeRibbon"
import { homeTextGroups } from "@/features/presentation/components/ribbon/homeText"
import type { PresentationRibbonContext } from "@/features/presentation/components/ribbon/tabs"
import "@/lib/i18n"

// The Paragraph group's alignments each show a glyph of their own: Justify and Distributed are told apart at a glance.

vi.mock("@/lib/useElementSize", () => ({ useElementSize: () => ({ width: 2400, height: 40 }) }))
vi.mock("@/lib/storage/adapter", () => ({
	kvGetJson: () => Promise.resolve(null),
	kvSetJson: () => Promise.resolve(),
	kvDelete: () => Promise.resolve()
}))

const ref = slideRef(256)

afterEach(cleanup)

describe("presentation text alignments", () => {
	it("draws Justify and Distributed with different icons", () => {
		const selection = createShapeSelection()
		const text = createTextEditing()

		selection.show(ref)
		text.set({
			shape: { slide: ref, id: 2 },
			defaults: { paragraph: () => ({}) },
			format: () => ({ run: {}, paragraph: {}, bodyPr: {} }),
			run: () => true,
			setBodyPr: () => undefined,
			subscribe: () => () => undefined
		} as unknown as TextEditController)

		const context = {
			editable: true,
			phone: false,
			selection: new Set(),
			t: i18n.t.bind(i18n) as TFunction,
			editor: {
				info: { slides: [{ ref, hidden: false }], customShows: [], editable: true } as unknown as OpenInfo,
				render: {
					ref,
					index: 0,
					revision: 1,
					hidden: false,
					background: {},
					layers: [],
					notesText: "",
					animated: false
				} as unknown as SlideRender,
				selection,
				command: () => Promise.resolve({ ok: true }),
				session: {},
				text
			}
		} as unknown as PresentationRibbonContext

		render(
			<OfficeRibbon
				label="Ribbon"
				commandsLabel="Commands"
				tabs={[{ id: "home", label: "Home" }]}
				tab="home"
				onTab={() => undefined}
				file={null}
				groups={homeTextGroups(context)}
			/>
		)

		const bar = screen.getByRole("toolbar", { name: "Commands" })
		const glyph = (name: string): string => within(bar).getByRole("button", { name }).querySelector("svg")?.innerHTML ?? ""

		expect(glyph("Justify")).not.toBe("")
		expect(glyph("Distributed")).not.toBe(glyph("Justify"))
	})
})
