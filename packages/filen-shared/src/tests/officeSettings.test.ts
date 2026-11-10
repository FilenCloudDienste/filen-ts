import { describe, expect, it } from "vitest"
import {
	DEFAULT_OFFICE_AUTOSAVE,
	MAX_AUTHOR_NAME_LENGTH,
	OfficeSettingsVersionError,
	emptyOfficeSettings,
	mergeOfficeSettings,
	normalizeAuthorName,
	officeAuthorName,
	officeAutosave,
	parseOfficeSettings,
	sameOfficeSettings,
	serializeOfficeSettings,
	setAuthorName,
	setOfficeAutosave,
	OFFICE_SETTINGS_DEFAULTS,
	normalizeAuthorInitials,
	officeSetting,
	officeSettingsValues,
	setOfficeSetting
} from "@filen/shared"

describe("office settings", () => {
	it("starts unset: no author name, autosave on", () => {
		const doc = emptyOfficeSettings()

		expect(officeAuthorName(doc)).toBeNull()
		expect(officeAutosave(doc)).toBe(DEFAULT_OFFICE_AUTOSAVE)
		expect(DEFAULT_OFFICE_AUTOSAVE).toBe(true)
	})

	it("normalises author names and refuses empty, overlong or control-character ones", () => {
		expect(normalizeAuthorName("  Jane \n  Doe ")).toBe("Jane Doe")
		expect(normalizeAuthorName("Café")).toBe("Café")
		expect(normalizeAuthorName("   ")).toBeUndefined()
		expect(normalizeAuthorName("x".repeat(MAX_AUTHOR_NAME_LENGTH + 1))).toBeUndefined()
		expect(normalizeAuthorName("a\u0000b")).toBeUndefined()
	})

	it("round-trips through its stable text", () => {
		const doc = setOfficeAutosave(setAuthorName(emptyOfficeSettings(), "Jane", 10), false, 20)
		const text = serializeOfficeSettings(doc)

		expect(parseOfficeSettings(text)).toEqual(doc)
		expect(serializeOfficeSettings(parseOfficeSettings(text))).toBe(text)
		expect(officeAuthorName(doc)).toBe("Jane")
		expect(officeAutosave(doc)).toBe(false)
	})

	it("drops fields that are not registers, reads unreadable values as the default and refuses a newer format", () => {
		const doc = parseOfficeSettings(JSON.stringify({ v: 1, authorName: { value: 5, at: 1 }, autosave: { value: true, at: "x" }, x: 3 }))

		expect(officeAuthorName(doc)).toBeNull()
		expect(officeAutosave(doc)).toBe(DEFAULT_OFFICE_AUTOSAVE)
		// The unreadable name is kept for the app that wrote it; the rest are not registers.
		expect(serializeOfficeSettings(doc)).toBe(JSON.stringify({ v: 1, authorName: { value: 5, at: 1 } }))
		expect(parseOfficeSettings("[]")).toEqual(emptyOfficeSettings())
		expect(() => parseOfficeSettings(JSON.stringify({ v: 2 }))).toThrow(OfficeSettingsVersionError)
		expect(() => parseOfficeSettings("{")).toThrow(SyntaxError)
	})

	it("merges per setting, the later change winning, and the same way on every device", () => {
		const a = setAuthorName(emptyOfficeSettings(), "Ann", 100)
		const b = setOfficeAutosave(setAuthorName(emptyOfficeSettings(), "Bob", 200), false, 50)
		const merged = mergeOfficeSettings(a, b)

		expect(officeAuthorName(merged)).toBe("Bob")
		expect(officeAutosave(merged)).toBe(false)
		expect(sameOfficeSettings(merged, mergeOfficeSettings(b, a))).toBe(true)

		// A tie resolves by value, whichever side is local.
		const tieA = setAuthorName(emptyOfficeSettings(), "Ann", 5)
		const tieB = setAuthorName(emptyOfficeSettings(), "Bob", 5)

		expect(sameOfficeSettings(mergeOfficeSettings(tieA, tieB), mergeOfficeSettings(tieB, tieA))).toBe(true)
	})

	it("changes nothing for the same value, and outbids a register from a clock ahead", () => {
		const doc = setAuthorName(emptyOfficeSettings(), "Jane", 1000)

		expect(setAuthorName(doc, " Jane ", 2000)).toBe(doc)
		expect(setAuthorName(doc, "", 2000)).toBe(doc)

		const behind = setAuthorName(doc, "Joan", 10)

		expect(behind.registers.get("authorName")?.at).toBe(1001)
		expect(officeAuthorName(mergeOfficeSettings(doc, behind))).toBe("Joan")

		const autosave = setOfficeAutosave(doc, true, 5)

		expect(autosave.registers.get("autosave")).toEqual({ value: true, at: 5 })
		expect(setOfficeAutosave(autosave, true, 50)).toBe(autosave)
	})

	it("reads every setting's default from an empty document", () => {
		expect(officeSettingsValues(emptyOfficeSettings())).toEqual(OFFICE_SETTINGS_DEFAULTS)
		expect(OFFICE_SETTINGS_DEFAULTS.autosaveDelayMs).toBe(30_000)
		expect(OFFICE_SETTINGS_DEFAULTS.spellCheck).toBe(true)
	})

	it("sets each setting only to a value it takes", () => {
		let doc = emptyOfficeSettings()

		doc = setOfficeSetting(doc, "autosaveDelayMs", 60_000, 1)
		doc = setOfficeSetting(doc, "proofingLanguage", "de-CH", 2)
		doc = setOfficeSetting(doc, "regionalFormat", "en-GB", 3)
		doc = setOfficeSetting(doc, "paperSize", "letter", 4)
		doc = setOfficeSetting(doc, "authorInitials", " J D ", 5)
		doc = setOfficeSetting(doc, "flagRepeatedWords", false, 6)

		expect(officeSettingsValues(doc)).toMatchObject({
			autosaveDelayMs: 60_000,
			proofingLanguage: "de-CH",
			regionalFormat: "en-GB",
			paperSize: "letter",
			authorInitials: "JD",
			flagRepeatedWords: false
		})
		expect(setOfficeSetting(doc, "autosaveDelayMs", 12_345 as 15_000, 7)).toBe(doc)
		expect(setOfficeSetting(doc, "proofingLanguage", "not a tag", 7)).toBe(doc)
		expect(setOfficeSetting(doc, "authorName", null, 7)).toBe(doc)

		// Null is "not chosen": the initials come from the name again, the languages from the browser.
		const cleared = setOfficeSetting(setOfficeSetting(doc, "authorInitials", null, 8), "regionalFormat", null, 9)

		expect(officeSetting(cleared, "authorInitials")).toBeNull()
		expect(officeSetting(cleared, "regionalFormat")).toBeNull()
		expect(parseOfficeSettings(serializeOfficeSettings(cleared))).toEqual(cleared)
	})

	it("normalises initials and refuses empty, overlong or control-character ones", () => {
		expect(normalizeAuthorInitials(" a b ")).toBe("ab")
		expect(normalizeAuthorInitials("")).toBeUndefined()
		expect(normalizeAuthorInitials("x".repeat(10))).toBeUndefined()
		expect(normalizeAuthorInitials("a\u0000")).toBeUndefined()
	})

	it("keeps settings a newer app wrote through a save and a merge", () => {
		const text = JSON.stringify({
			v: 1,
			autosave: { value: false, at: 10 },
			autosaveDelayMs: { value: 600_000, at: 11 },
			zoom: { value: { kind: "fit" }, at: 12 }
		})
		const doc = parseOfficeSettings(text)

		// The delay this version has no option for reads as the default, and is written back unchanged.
		expect(officeSetting(doc, "autosaveDelayMs")).toBe(30_000)
		expect(serializeOfficeSettings(doc)).toBe(text)

		const changed = setOfficeAutosave(doc, true, 20)
		const merged = mergeOfficeSettings(changed, emptyOfficeSettings())

		expect(JSON.parse(serializeOfficeSettings(merged))).toEqual({
			v: 1,
			autosave: { value: true, at: 20 },
			autosaveDelayMs: { value: 600_000, at: 11 },
			zoom: { value: { kind: "fit" }, at: 12 }
		})
	})
})
