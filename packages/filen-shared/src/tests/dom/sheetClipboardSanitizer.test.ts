// @vitest-environment happy-dom

import { describe, expect, it } from "vitest"
import { createSheetClipboardSanitizer, type SheetClipboardPurifier } from "@filen/shared/dom"

describe("createSheetClipboardSanitizer", () => {
	// DOMPurify's `removed` holds the last run's parsed document until its next run.
	it("lets go of what the run removed", () => {
		const purifier: SheetClipboardPurifier = {
			removed: [],
			sanitize: dirty => {
				purifier.removed.push({ element: dirty })

				return dirty
			}
		}

		expect(createSheetClipboardSanitizer(purifier)("<table></table>")).toBe("<table></table>")
		expect(purifier.removed).toEqual([])
	})

	// A purifier that hands back what it was given, to see what the comment pass did.
	function passThrough(): (html: string) => string {
		return createSheetClipboardSanitizer({ removed: [], sanitize: dirty => dirty })
	}

	it("takes the comment markers out of a style element as Excel writes it", () => {
		const html =
			"<html><head><style><!--\ntd { mso-number-format: '0.00'; }\n.xl65 { color: red; }\n--></style></head><body><table><tr><td class='xl65'>1</td></tr></table><!-- kept --></body></html>"

		expect(passThrough()(html)).toBe(
			"<html><head><style>\ntd { mso-number-format: '0.00'; }\n.xl65 { color: red; }\n</style></head><body><table><tr><td class='xl65'>1</td></tr></table><!-- kept --></body></html>"
		)
	})

	it("matches upper-case and spaced tags, and each element on its own", () => {
		expect(passThrough()("<STYLE type='text/css'><!-- a {} --></STYLE ><p><!-- p --></p><style><!--b{}--></style\n>")).toBe(
			"<STYLE type='text/css'> a {} </STYLE ><p><!-- p --></p><style>b{}</style\n>"
		)
	})

	it("reads an opening as a word boundary after style, as the regex it replaced did", () => {
		expect(passThrough()("<stylesheet><!-- a --></stylesheet><style-x><!-- b --></style>")).toBe(
			"<stylesheet><!-- a --></stylesheet><style-x> b </style>"
		)
	})

	it("leaves an unclosed style element alone", () => {
		expect(passThrough()("<style><!-- a --></style><style><!-- b -->")).toBe("<style> a </style><style><!-- b -->")
	})

	// At the paste cap. A regex retried from every unclosed opening is quadratic here and runs past the test timeout.
	it("passes many unclosed style openings through in one scan", () => {
		const html = "<style><!--".repeat(70_000)

		expect(passThrough()(html)).toBe(html)
		expect(passThrough()("<style".repeat(130_000))).toBe("<style".repeat(130_000))
	})
})
