import { describe, expect, it } from "vitest"
import { foreignTokens, replyWithHandles, replyWithoutHandles, settledReply } from "@filen/shared/assistant"

const NAMES: Record<string, string> = {
	d0: "/",
	d5: "Lisbon 2024",
	f3: "CV.pdf",
	f14: "Oma_Geburtstag.jpg",
	f44: "旅行计划.docx",
	f81: "Kontoauszug_August.pdf",
	n1: "Groceries",
	n8: "读书笔记",
	n11: "Catatan rapat",
	c3: "Carlos Ruiz",
	p1: "Workout",
	p2: "Chill",
	d49: "Screenshots 2023",
	f5: "Report.pdf",
	f6: "Budget.xlsx",
	f12: "Ab"
}

function shown(reply: string, foreign: readonly string[] = []): string {
	return replyWithoutHandles(reply, handle => NAMES[handle], { foreign: new Set(foreign) })
}

describe("replyWithoutHandles", () => {
	it("drops a handle bracketed after its item's name, with or without a label", () => {
		expect(shown('Your note "Groceries" (n1) lists milk.')).toBe('Your note "Groceries" lists milk.')
		expect(shown("Found **CV.pdf** (handle: f3).")).toBe("Found **CV.pdf**.")
		expect(shown('Die Datei „CV.pdf" (Handle: f3) ist geteilt.')).toBe('Die Datei „CV.pdf" ist geteilt.')
		expect(shown("您的《读书笔记》（n8）中记录了")).toBe("您的《读书笔记》中记录了")
		expect(shown("- **Lisbon 2024** (directory, handle d5)")).toBe("- **Lisbon 2024** (directory)")
	})

	it("drops a handle that labels a list row naming the item", () => {
		expect(shown("- f14: Oma_Geburtstag.jpg (2025-10-06)\n- n1 - Groceries")).toBe("- Oma_Geburtstag.jpg (2025-10-06)\n- Groceries")
		expect(shown("- **f44** `旅行计划.docx` (2025-07-01)")).toBe("- `旅行计划.docx` (2025-07-01)")
		expect(shown("- p1 Workout tracks=3")).toBe("- Workout tracks=3")
		expect(shown('- **d49** "Screenshots 2023" (directory)')).toBe('- "Screenshots 2023" (directory)')
		expect(shown("- `d49` (directory): Screenshots 2023")).toBe("- Screenshots 2023 (directory)")
	})

	it("puts the name where the handle stood alone", () => {
		expect(shown("- **c3** (Carlos Ruiz) - last active today")).toBe("- **Carlos Ruiz** - last active today")
		expect(shown("Your meeting note is **n11**.")).toBe("Your meeting note is **Catatan rapat**.")
		expect(shown("[Kontoauszug_August.pdf](file://f81)")).toBe("Kontoauszug_August.pdf")
	})

	it("puts the name in brackets and lists where no name stands before them", () => {
		expect(shown("The matching files are (f5, f6).")).toBe("The matching files are (Report.pdf, Budget.xlsx).")
		expect(shown("I found two matching files (f5, f6).")).toBe("I found two matching files (Report.pdf, Budget.xlsx).")
		expect(shown("Chat (c3) and file (f5)")).toBe("Chat (Carlos Ruiz) and file (Report.pdf)")
		expect(shown("The largest is (f5).")).toBe("The largest is (Report.pdf).")
		expect(shown("- f5: 2 MB")).toBe("- Report.pdf: 2 MB")
		expect(shown("CV.pdf (f3, shared)")).toBe("CV.pdf (shared)")
	})

	it("leaves a handle in running prose, where it is as likely a code, a room or a key", () => {
		for (const text of [
			"Priority p1: ship the release; p2: write docs.",
			"The meeting is in room c3.",
			"Press f3 for help.",
			"Take vitamin d5 daily, and a t2 instance."
		]) {
			expect(shown(text)).toBe(text)
		}
	})

	it("leaves a token the user typed or read content holds, unless its item's name stands beside it", () => {
		expect(shown("Fix the login crash (p1) before Friday; docs (p2).", ["p1", "p2"])).toBe(
			"Fix the login crash (p1) before Friday; docs (p2)."
		)
		expect(shown("- p1: fix login\n- [notes](f3)", ["p1", "f3"])).toBe("- p1: fix login\n- [notes](f3)")
		expect(shown("Your playlist Workout (p1) has 3 tracks.", ["p1"])).toBe("Your playlist Workout has 3 tracks.")
	})

	it("leaves handles the app never gave out and text that only looks like one", () => {
		expect(shown("Print it on A4, not f9 or c12.")).toBe("Print it on A4, not f9 or c12.")
		expect(shown("Open d2.txt and /Projects/f3 and f3-draft")).toBe("Open d2.txt and /Projects/f3 and f3-draft")
		// A one-character name says nothing in place of the handle.
		expect(shown("It is in d0.")).toBe("It is in d0.")
	})

	// What the model wrote with handles no result gave out: "f" handles were, so "f7" is one made up.
	const invented = (reply: string, foreign: readonly string[] = []) =>
		replyWithoutHandles(reply, handle => NAMES[handle], {
			foreign: new Set(foreign),
			invented: handle => handle.startsWith("f")
		})

	it("drops the list rows only a made-up handle filled, and keeps the rows that name something", () => {
		expect(
			invented("Here are the most recently changed files:\n\n- [file] (f7)\n- [file] (f8)\n- [file] (f3)\n- **f9**\n\nAnything else?")
		).toBe("Here are the most recently changed files:\n\n- [file] (CV.pdf)\n\nAnything else?")
		expect(invented("1. Report.pdf (f7)\n2. `f8`: 2 MB\n3. [Budget](f9)")).toBe("1. Report.pdf\n2. 2 MB\n3. Budget")
	})

	it("drops a made-up handle where a handle stands as a reference, and leaves it in prose", () => {
		expect(invented("The newest is (f7), then CV.pdf (handle: f8).")).toBe("The newest is, then CV.pdf.")
		expect(invented("Press f7 for help.")).toBe("Press f7 for help.")
		// Of a kind no result gave out.
		expect(invented("- [note] (n9)")).toBe("- [note] (n9)")
	})

	it("keeps a made-up-looking token the user typed or read content holds", () => {
		expect(invented("- [file] (f7)\n- f8: fix login", ["f7", "f8"])).toBe("- [file] (f7)\n- f8: fix login")
	})
})

describe("settledReply", () => {
	it("holds back a handle, or a link to one, still being written", () => {
		expect(settledReply("Ab (f1")).toBe("Ab")
		expect(settledReply("See [CV.pdf](file://f")).toBe("See ")
		expect(settledReply("Found **f1")).toBe("Found ")
		expect(settledReply("Ab (f12) is here")).toBe("Ab (f12) is here")
		expect(settledReply("Ab (f12)")).toBe("Ab (f12)")
	})
})

describe("foreignTokens", () => {
	it("collects tokens other people wrote, not the app's pointers", () => {
		const found = foreignTokens(
			{
				handle: "n1",
				chat: "c1",
				name: "c4",
				content: "Fix (p1) in room c12",
				items: [{ handle: "f3", name: "Report d9 final.pdf" }]
			},
			new Set()
		)

		expect([...found].sort()).toEqual(["c12", "c4", "d9", "p1"])
	})
})

describe("replyWithHandles", () => {
	it("gives a longer name its own handle before a shorter one it contains", () => {
		expect(
			replyWithHandles(
				"Project.docx is in Project.",
				new Map([
					["d3", "Project"],
					["f1", "Project.docx"]
				])
			)
		).toBe("Project.docx (f1) is in Project (d3).")
		expect(
			replyWithHandles(
				"Invoices.zip is in Invoices.",
				new Map([
					["d4", "Invoices"],
					["f2", "Invoices.zip"]
				])
			)
		).toBe("Invoices.zip (f2) is in Invoices (d4).")
	})

	it("tags no plain word and no name written in another case", () => {
		const items = new Map([
			["n1", "to"],
			["f9", "notes"],
			["d1", "Documents"],
			["f3", "CV.pdf"]
		])

		expect(replyWithHandles("I sent it to Anna. You have no notes and no documents; see cv.pdf.", items)).toBe(
			"I sent it to Anna. You have no notes and no documents; see cv.pdf."
		)
	})

	it("tags only the first few items a long reply names", () => {
		const items = new Map(
			Array.from({ length: 12 }, (_, index) => [`f${String(index + 1)}`, `Scan_${String(index + 1).padStart(3, "0")}.pdf`])
		)
		const reply = [...items.values()].map(name => `- ${name}`).join("\n")
		const tagged = replyWithHandles(reply, items)

		expect(tagged.match(/ \(f\d+\)/g)).toHaveLength(8)
		expect(tagged).toContain("- Scan_001.pdf (f1)")
		expect(tagged).toContain("- Scan_012.pdf\n".slice(0, -1))
		expect(tagged).not.toContain("(f12)")
	})

	it("adds the handle after the first mention of a name the turn handed out", () => {
		const items = new Map([
			["c3", "Carlos Ruiz"],
			["n1", "Groceries"],
			["f3", "CV.pdf"]
		])

		expect(replyWithHandles("Carlos Ruiz asked about the budget. Carlos Ruiz is waiting.", items)).toBe(
			"Carlos Ruiz (c3) asked about the budget. Carlos Ruiz is waiting."
		)
		expect(replyWithHandles('Your note "Groceries" lists milk; CV.pdf (f3) is in Documents.', items)).toBe(
			'Your note "Groceries" (n1) lists milk; CV.pdf (f3) is in Documents.'
		)
	})

	it("adds nothing for a name inside a longer word or one the reply leaves out", () => {
		expect(replyWithHandles("The CV.pdfs are gone.", new Map([["f3", "CV.pdf"]]))).toBe("The CV.pdfs are gone.")
		expect(replyWithHandles("Nothing found.", new Map([["f3", "CV.pdf"]]))).toBe("Nothing found.")
	})
})
