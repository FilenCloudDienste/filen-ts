import type { Node as ProseMirrorNode } from "prosemirror-model"
import { TextSelection } from "prosemirror-state"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { docxSchema, parseDocxEditorCommand } from "@filen/office/core/docx/edit"
import { datePictures, intlDatePicture, numericDatePicture } from "../core/docx/fields/datePictures"
import { datePicture } from "../core/docx/fields/evaluate"
import { dayPeriodName, formatControlDate } from "../core/docx/forms/dates"
import { STYLES_PART } from "./docxEditFixtures"
import { buildDocx, type SyntheticDocx } from "./docxSynthetic"
import { pagedEditor, settleAll } from "./pagedFixtures"

// Date pictures for a language read in Latin digits and the Gregorian calendar, the AM/PM item in the language's
// own day period (fields and controls alike), and dates and fields inserted in the caret's formatting and language.

beforeEach(() => {
	vi.stubEnv("TZ", "UTC")
})

afterEach(() => {
	vi.unstubAllGlobals()
})

// The user's regional settings, as the runtime reports them.
function regional(language: string): void {
	vi.stubGlobal("navigator", { language })
}

const NON_LATIN = /[٠-٩۰-۹০-৯०-९๐-๙؜‎‏]/

describe("date pictures for a language", () => {
	it("reads non-Latin digits and calendars as Latin digits and the Gregorian calendar, without bidi marks", () => {
		for (const language of ["fa-IR", "bn-BD", "mr-IN", "ar-SA", "ar-EG", "th-TH", "he-IL"]) {
			const pictures = datePictures(language)

			expect(pictures.length, language).toBeGreaterThan(3)

			for (const picture of pictures) {
				expect(NON_LATIN.test(picture), `${language} ${picture}`).toBe(false)
				expect(parseDocxEditorCommand({ type: "insert.date", format: picture }), `${language} ${picture}`).toBeDefined()
				// A Gregorian year: 2026, never 1405 (Persian) or 2569 (Thai Buddhist).
				if (picture.includes("yyyy")) expect(datePicture(new Date(Date.UTC(2026, 9, 12)), picture, language)).toContain("2026")
			}
		}

		expect(intlDatePicture("ar-EG", { year: "numeric", month: "2-digit", day: "2-digit" })).toBe("dd/MM/yyyy")
		expect(intlDatePicture("fa-IR", { year: "numeric", month: "2-digit", day: "2-digit" })).toBe("yyyy/MM/dd")
	})

	it("offers the numeric short date with a four-digit year first", () => {
		expect(numericDatePicture("en-US")).toBe("M/d/yyyy")
		expect(numericDatePicture("de-DE")).toBe("dd.MM.yyyy")
		expect(datePictures("de-DE")[0]).toBe("dd.MM.yyyy")
		expect(datePictures("ja-JP")[0]).toBe("yyyy/MM/dd")
		expect(datePictures(undefined)[0]).toBe("M/d/yyyy")
	})

	it("puts the day period where Korean and Chinese put it, shown in their words", () => {
		const korean = datePictures("ko-KR").find(picture => picture.includes("am/pm") && !picture.includes("y"))
		const chinese = datePictures("zh-CN").find(picture => picture.includes("am/pm") && !picture.includes("y"))
		const afternoon = new Date(Date.UTC(2026, 9, 12, 15, 4))

		expect(korean).toBe("am/pm h:mm")
		regional("ko-KR")
		expect(datePicture(afternoon, korean ?? "", "ko-KR")).toBe("오후 3:04")
		expect(chinese).toBe("am/pmh:mm")
		regional("zh-CN")
		expect(datePicture(afternoon, chinese ?? "", "zh-CN")).toBe("下午3:04")
	})
})

describe("the AM/PM item", () => {
	const morning = new Date(Date.UTC(2026, 9, 12, 9, 30))
	const evening = new Date(Date.UTC(2026, 9, 12, 21, 30))

	it("shows the user's regional day period in a field and a control (A/P too, whole), Latin AM/PM in English", () => {
		const cases: [string, string, string][] = [
			["en-US", "AM", "PM"],
			["ko-KR", "오전", "오후"],
			["zh-CN", "上午", "下午"],
			["ja-JP", "午前", "午後"],
			["ar-EG", "ص", "م"]
		]

		for (const [locale, am, pm] of cases) {
			regional(locale)
			expect(dayPeriodName(9), locale).toBe(am)
			expect(dayPeriodName(21), locale).toBe(pm)
			// A field in German (its language names the month, the regional settings the day period) and a control
			// (its time is midnight).
			expect(datePicture(morning, "h:mm AM/PM MMMM", "de-DE")).toBe(`9:30 ${am} Oktober`)
			expect(datePicture(evening, "h:mm am/pm", "de-DE")).toBe(`9:30 ${pm}`)
			expect(datePicture(evening, "h:mm A/P", "de-DE")).toBe(`9:30 ${pm}`)
			expect(formatControlDate("2026-10-12", "yyyy-MM-dd a/p", "de-DE")).toBe(`2026-10-12 ${am}`)
		}
	})
})

describe("era items in a field's picture", () => {
	const day = new Date(Date.UTC(2026, 9, 5, 12))

	it("are literal characters in every language but Japanese", () => {
		for (const language of ["en-US", "de-DE", "fr-FR", "zh-TW", "ko-KR", "th-TH"]) {
			expect(datePicture(day, "Week e, B, g", language), language).toBe("Week e, B, g")
			expect(datePicture(day, "Begin dd", language), language).toBe("Begin 05")
			expect(datePicture(day, "aaa E O A", language), language).toBe("aaa E O A")
		}
	})

	it("are the Japanese imperial calendar's in a Japanese field (its East Asian language, else its language)", () => {
		const fifteenth = new Date(Date.UTC(2026, 9, 15, 12))

		expect(datePicture(fifteenth, "ggge'年'M'月'd'日'", "en-US", undefined, "ja-JP")).toBe("令和8年10月15日")
		expect(datePicture(fifteenth, "g e, gg ee", "ja-JP")).toBe("R 8, 令 08")
		expect(datePicture(fifteenth, "aaa aaaa", "ja-JP")).toBe("木 木曜日")
		// Whatever the calendar switch.
		expect(datePicture(fifteenth, "ggg e", "en-US", "hijri", "ja")).toBe("令和 8")
		// A Japanese Latin language with another East Asian one: literal.
		expect(datePicture(fifteenth, "ggg e", "ja-JP", undefined, "zh-CN")).toBe("ggg e")
	})

	it("reads the East Asian language of the field's run when it is updated", async () => {
		const opened = await pagedEditor(
			buildDocx({
				body: '<w:p><w:r><w:rPr><w:lang w:val="en-US" w:eastAsia="ja-JP"/></w:rPr><w:t xml:space="preserve">On </w:t></w:r></w:p>'
			})
		)

		await settleAll(opened.editor)
		opened.context.identity.now = () => Date.UTC(2026, 9, 15, 12)

		const session = opened.editor.session

		session.dispatch(session.state.tr.setSelection(TextSelection.create(session.state.doc, 4)))
		expect(opened.editor.execute({ type: "insert.field", instruction: " DATE \\@ \"ggge'年'\" " })).toBe(true)

		let result: unknown

		session.state.doc.descendants(node => {
			if (node.type === docxSchema.nodes.field) result = node.attrs["result"]

			return true
		})

		expect(result).toBe("令和8年")
	})

	it("stay a date control's calendar's", () => {
		expect(formatControlDate("2026-10-15", "ggge'年'", "ja-JP", "japan")).toBe("令和8年")
		expect(formatControlDate("2026-10-15", "BBBB", "th-TH", "thai")).toBe("2569")
		expect(formatControlDate("2026-10-15", "yyyy g", "ar-SA", "hijri")).toBe("1448 هـ")
	})
})

describe("calendars", () => {
	it("names Gregorian months in Persian and Pashto as the Gregorian calendar does (not the Persian calendar's)", () => {
		const day = new Date(Date.UTC(2026, 9, 15, 12))

		expect(datePicture(day, "d MMMM yyyy", "fa-IR")).toBe("15 اکتبر 2026")
		expect(formatControlDate("2026-10-15", "d MMMM yyyy", "fa-IR", "gregorian")).toBe("15 اکتبر 2026")
		expect(formatControlDate("2026-10-15", "MMMM", "ps-AF", "gregorian")).not.toBe("تله")
		expect(datePicture(day, "MMMM", "th-TH")).toBe("ตุลาคม")
	})

	it("shows a Japanese or Chinese month next to a day with its unit, as Word does", () => {
		const day = new Date(Date.UTC(2026, 2, 4, 12))

		expect(datePicture(day, "d MMMM", "ja-JP")).toBe("4 3月")
		expect(datePicture(day, "d MMMM", "zh-CN")).toBe("4 3月")
		expect(formatControlDate("2026-03-04", "yyyy MMMM d", "zh-TW")).toBe("2026 3月 4")
		// Without a day: the month's own name.
		expect(datePicture(day, "MMMM", "ja-JP")).toBe("3月")
		// The genitive of a Slavic month stays.
		expect(datePicture(day, "d MMMM", "ru-RU")).toBe("4 марта")
	})

	it("reads a Windows language identifier (ST_Lang in hex) as its language", () => {
		expect(datePictures("0409")).toEqual(datePictures("en-US"))
		expect(datePictures("0x0407")).toEqual(datePictures("de-DE"))
		expect(numericDatePicture("0411")).toBe("yyyy/MM/dd")
		expect(datePicture(new Date(Date.UTC(2026, 2, 4, 12)), "d MMMM yyyy", "0407")).toBe("4 März 2026")
		expect(formatControlDate("2026-03-04", "MMMM", "040c")).toBe("mars")
	})

	it("shows a date control in a non-Gregorian calendar with Latin digits, the Hebrew month by its number", () => {
		expect(formatControlDate("2026-10-15", "d/M/yyyy", "ar-SA", "hijri")).toBe("5/5/1448")
		expect(formatControlDate("2026-10-15", "d/M/yyyy", "fa-IR", "hijri")).toBe("5/5/1448")
		expect(formatControlDate("2026-10-15", "d/M/yyyy", "bn-IN", "saka")).toBe("23/7/1948")
		// 15 October 2026 is 4 Heshvan 5787: Heshvan follows Tishri.
		expect(formatControlDate("2026-10-15", "d/M/yyyy", "he-IL", "hebrew")).toBe("4/2/5787")
		// Nisan 5787 (2027 is a leap year: Adar I and Adar II before it): the eighth month.
		expect(formatControlDate("2027-04-08", "M", "he-IL", "hebrew")).toBe("8")
		expect(formatControlDate("2026-10-15", "yyyy g", "ar-SA", "hijri")).toBe("1448 هـ")
	})

	it("numbers Hebrew months from Tishri at a year's edges with a bounded number of Intl calls", () => {
		// 1 Tishri 5787, 29 Elul 5787 (leap: the 13th month), 29 Elul 5786 (common: the 12th), 30 Tishri 5787.
		const cases: [string, string][] = [
			["2026-09-12", "1"],
			["2027-10-01", "13"],
			["2026-09-11", "12"],
			["2026-10-11", "1"],
			["2026-10-12", "2"]
		]

		for (const [iso, month] of cases) expect(formatControlDate(iso, "M", "he-IL", "hebrew")).toBe(month)

		const parts = vi.spyOn(Intl.DateTimeFormat.prototype, "formatToParts")

		try {
			expect(formatControlDate("2027-10-01", "M", "he-IL", "hebrew")).toBe("13")
			// One step per month back to Tishri, not one per day of the year.
			expect(parts.mock.calls.length).toBeLessThanOrEqual(16)
		} finally {
			parts.mockRestore()
		}
	})

	it("reads a DATE or TIME field's \\h as the Hijri calendar and \\s as Saka", async () => {
		const opened = await pagedEditor(buildDocx({ body: '<w:p><w:r><w:t xml:space="preserve">On </w:t></w:r></w:p>' }))

		await settleAll(opened.editor)
		opened.context.identity.now = () => Date.UTC(2026, 9, 15, 12)

		const session = opened.editor.session

		session.dispatch(session.state.tr.setSelection(TextSelection.create(session.state.doc, 4)))
		expect(opened.editor.execute({ type: "insert.field", instruction: ' DATE \\h \\@ "d/M/yyyy" ' })).toBe(true)
		expect(opened.editor.execute({ type: "insert.field", instruction: ' DATE \\s \\@ "d/M/yyyy" ' })).toBe(true)
		expect(opened.editor.execute({ type: "insert.field", instruction: ' DATE \\@ "d/M/yyyy" ' })).toBe(true)

		const results: unknown[] = []

		session.state.doc.descendants(node => {
			if (node.type === docxSchema.nodes.field) results.push(node.attrs["result"])

			return true
		})

		expect(results).toEqual(["5/5/1448", "23/7/1948", "15/10/2026"])
	})
})

describe("dates and fields inserted at the caret", () => {
	const STYLES = STYLES_PART('<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>')

	function spec(body: string): SyntheticDocx {
		return { body, parts: [STYLES], relationships: [{ id: "rIdS", type: "styles", target: "styles.xml" }] }
	}

	function fieldOf(doc: ProseMirrorNode): ProseMirrorNode | undefined {
		let found: ProseMirrorNode | undefined

		doc.descendants(node => {
			if (node.type === docxSchema.nodes.field) found = node

			return found === undefined
		})

		return found
	}

	async function open() {
		const opened = await pagedEditor(
			buildDocx(spec('<w:p><w:r><w:rPr><w:b/><w:lang w:val="de-DE"/></w:rPr><w:t xml:space="preserve">Heute: </w:t></w:r></w:p>'))
		)

		await settleAll(opened.editor)
		opened.context.identity.now = () => Date.UTC(2026, 9, 12, 14, 5, 9)

		const session = opened.editor.session

		session.dispatch(session.state.tr.setSelection(TextSelection.create(session.state.doc, 8)))

		return opened
	}

	it("types the date in the run's language and formatting", async () => {
		const { editor } = await open()

		expect(editor.execute({ type: "insert.date", format: "dddd, d MMMM yyyy", field: false })).toBe(true)
		expect(editor.session.state.doc.textContent).toBe("Heute: Montag, 12 Oktober 2026")

		const text = editor.session.state.doc.nodeAt(9)

		expect(text?.marks.map(mark => mark.type.name)).toEqual(expect.arrayContaining(["bold", "lang"]))
	})

	it("inserts a field with the caret's formatting, its result in the run's language", async () => {
		const { editor } = await open()

		expect(editor.execute({ type: "insert.date", format: "dddd, d MMMM yyyy" })).toBe(true)

		const field = fieldOf(editor.session.state.doc)

		expect(field?.attrs["result"]).toBe("Montag, 12 Oktober 2026")
		expect(field?.marks.map(mark => mark.type.name)).toEqual(expect.arrayContaining(["bold", "lang"]))
	})
})
