import { strFromU8, strToU8 } from "fflate"
import { describe, expect, it } from "vitest"
import { writeSettings } from "../core/ods/write/settings"
import { DEFAULT_VIEW } from "../core/xlsx/read/worksheet"
import { ODS_NS } from "./odsFixtures"

// A split window (split mode 1, positions in twips) reads as no frozen pane; a view saved unfrozen keeps the split
// as the source has it, a freeze replaces it.

const item = (name: string, type: string, value: string): string =>
	`<config:config-item config:name="${name}" config:type="${type}">${value}</config:config-item>`

const SPLIT = [
	item("HorizontalSplitMode", "short", "1"),
	item("VerticalSplitMode", "short", "1"),
	item("HorizontalSplitPosition", "int", "2880"),
	item("VerticalSplitPosition", "int", "1440"),
	item("ActiveSplitRange", "short", "3"),
	item("PositionRight", "int", "7"),
	item("PositionBottom", "int", "12")
]

const SETTINGS = strToU8(
	`<?xml version="1.0" encoding="UTF-8"?><office:document-settings ${ODS_NS} office:version="1.3"><office:settings>` +
		'<config:config-item-set config:name="ooo:view-settings"><config:config-item-map-indexed config:name="Views"><config:config-item-map-entry>' +
		'<config:config-item-map-named config:name="Tables"><config:config-item-map-entry config:name="S">' +
		item("CursorPositionX", "int", "0") +
		item("CursorPositionY", "int", "0") +
		SPLIT.join("") +
		item("PositionLeft", "int", "0") +
		item("PositionTop", "int", "0") +
		"</config:config-item-map-entry></config:config-item-map-named></config:config-item-map-entry></config:config-item-map-indexed></config:config-item-set>" +
		"</office:settings></office:document-settings>"
)

describe("ODS split window panes", () => {
	it("keeps a source split when the cursor moves", () => {
		const view = { ...DEFAULT_VIEW, activeRow: 4, activeCol: 3 }
		const written = writeSettings(SETTINGS, "S", false, [{ name: "S", sourceName: "S", view, changed: true }])

		expect(written).not.toBeNull()

		const text = strFromU8(written ?? new Uint8Array(0))

		for (const kept of SPLIT) expect(text).toContain(kept)

		expect(text).toContain(item("CursorPositionX", "int", "3"))
		expect(text).toContain(item("CursorPositionY", "int", "4"))
	})

	it("replaces a source split with frozen panes once the view freezes", () => {
		const view = { ...DEFAULT_VIEW, frozen: { rows: 1, cols: 0, topLeftRow: 1, topLeftCol: 0 } }
		const text = strFromU8(
			writeSettings(SETTINGS, "S", false, [{ name: "S", sourceName: "S", view, changed: true }]) ?? new Uint8Array(0)
		)

		expect(text).toContain(item("HorizontalSplitMode", "short", "0"))
		expect(text).toContain(item("VerticalSplitMode", "short", "2"))
		expect(text).toContain(item("VerticalSplitPosition", "int", "1"))
		expect(text).toContain(item("PositionBottom", "int", "1"))
	})
})

describe("a settings.xml without a view", () => {
	const ROOT =
		'<?xml version="1.0" encoding="UTF-8"?><office:document-settings xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" office:version="1.3">'
	const frozen = { ...DEFAULT_VIEW, frozen: { rows: 1, cols: 0, topLeftRow: 1, topLeftCol: 0 } }

	for (const [label, inner] of [
		["no office:settings", ""],
		["a self-closing office:settings", "<office:settings/>"]
	] as const) {
		it(`gets the view levels it lacks and the namespaces they need, with ${label}`, () => {
			const written = writeSettings(strToU8(`${ROOT}${inner}</office:document-settings>`), "S", false, [
				{ name: "S", sourceName: undefined, view: frozen, changed: true }
			])
			const text = strFromU8(written ?? new Uint8Array(0))

			expect(text).toContain('xmlns:config="urn:oasis:names:tc:opendocument:xmlns:config:1.0"')
			expect(text).toContain('xmlns:ooo="http://openoffice.org/2004/office"')
			expect(text).toContain(
				'<office:settings><config:config-item-set config:name="ooo:view-settings"><config:config-item-map-indexed config:name="Views"><config:config-item-map-entry>' +
					item("ViewId", "string", "view1")
			)
			expect(text).toContain('<config:config-item-map-entry config:name="S">')
			expect(text).toContain(item("VerticalSplitMode", "short", "2"))
		})

		it(`stays as it was when no view changes, with ${label}`, () => {
			const bytes = strToU8(`${ROOT}${inner}</office:document-settings>`)

			expect(writeSettings(bytes, "S", false, [{ name: "S", sourceName: "S", view: DEFAULT_VIEW, changed: false }])).toBeNull()
		})
	}

	it("declares the config namespace under a free prefix when config is bound elsewhere", () => {
		const bytes = strToU8(
			'<?xml version="1.0" encoding="UTF-8"?><office:document-settings xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:config="urn:example:other"><office:settings/></office:document-settings>'
		)
		const text = strFromU8(
			writeSettings(bytes, "S", false, [{ name: "S", sourceName: undefined, view: frozen, changed: true }]) ?? new Uint8Array(0)
		)

		expect(text).toContain('xmlns:config2="urn:oasis:names:tc:opendocument:xmlns:config:1.0"')
		expect(text).toContain('<config2:config-item-set config2:name="ooo:view-settings">')
	})
})
