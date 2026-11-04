import { Node } from "prosemirror-model"
import { TextSelection } from "prosemirror-state"
import { describe, expect, it, vi } from "vitest"
import type { DocxEditorSession } from "@filen/office/core/docx/edit"
import {
	DocxSpelling,
	MAX_SPELLING_ISSUES,
	type DocxSpellingOptions,
	type SpellingChecker,
	type SpellingMark
} from "@filen/office/core/docx/spelling"
import { ParagraphScanner, addressSpans } from "../core/docx/spelling/scan"
import { STYLES_PART, sessionOf } from "./docxEditFixtures"
import { budget, cpuMs } from "./timing"
import type { SyntheticDocx } from "./docxSynthetic"

// A spellchecker over fixed word lists, answering checks asynchronously like a worker would.
class FakeChecker implements SpellingChecker {
	readonly words: Record<string, Set<string>> = {
		en: new Set(["hello", "world", "the", "end", "don't", "etc.", "program", "is", "a", "in", "text", "word", "Mr"]),
		de: new Set(["Haus", "und", "Straße"])
	}
	readonly cache = new Map<string, boolean>()
	readonly checked: string[] = []
	readonly added: string[] = []
	// Documents open on this checker.
	documents = 0
	private readonly listeners = new Set<() => void>()

	open(): () => void {
		this.documents++

		return () => {
			this.documents--
		}
	}

	dictionaryFor(language: string): string | undefined {
		return language.startsWith("en") ? "en" : language.startsWith("de") ? "de" : undefined
	}

	known(dictionary: string, word: string): boolean | undefined {
		return this.cache.get(`${dictionary}:${word}`)
	}

	check(dictionary: string, words: Iterable<string>): Promise<void> {
		const list = [...words]

		this.checked.push(...list)

		return Promise.resolve().then(() => {
			for (const word of list) {
				const set = this.words[dictionary]

				this.cache.set(`${dictionary}:${word}`, set !== undefined && (set.has(word) || set.has(word.toLowerCase())))
			}
		})
	}

	suggest(_dictionary: string, word: string, options: { more?: boolean } = {}): Promise<readonly string[]> {
		if (word === "wrold") return Promise.resolve(options.more === true ? ["world", "wold"] : ["world"])
		if (word === "Dont't") return Promise.resolve(["Don't"])

		return Promise.resolve(options.more === true ? ["slow"] : [])
	}

	addToDictionary(word: string): Promise<void> {
		this.added.push(word)
		this.words["en"]?.add(word)
		this.words["de"]?.add(word)

		for (const key of [...this.cache.keys()]) {
			if (this.cache.get(key) === false) this.cache.delete(key)
		}

		for (const listener of this.listeners) listener()

		return Promise.resolve()
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener)

		return () => {
			this.listeners.delete(listener)
		}
	}
}

// Timers the test runs by hand.
function manualTimers() {
	let time = 0
	const queue = new Map<number, { at: number; callback: () => void }>()
	let next = 1

	return {
		now: () => time,
		timers: {
			set: (callback: () => void, ms: number) => {
				const id = next++

				queue.set(id, { at: time + ms, callback })

				return id
			},
			clear: (handle: unknown) => {
				queue.delete(handle as number)
			}
		},
		// Advances time, running due timers and the promises they start, until nothing more is due.
		async advance(ms: number): Promise<void> {
			time += ms

			for (let round = 0; round < 2000; round++) {
				await new Promise(resolve => setTimeout(resolve, 0))

				const due = [...queue].filter(([, entry]) => entry.at <= time)

				if (due.length === 0) {
					await new Promise(resolve => setTimeout(resolve, 0))

					if (![...queue].some(([, entry]) => entry.at <= time)) return

					continue
				}

				for (const [id, entry] of due) {
					queue.delete(id)
					entry.callback()
				}
			}
		}
	}
}

const EN = '<w:rPr><w:lang w:val="en-US"/></w:rPr>'

function run(text: string, rPr: string = EN): string {
	return `<w:r>${rPr}<w:t xml:space="preserve">${text}</w:t></w:r>`
}

function para(...runs: string[]): string {
	return `<w:p>${runs.join("")}</w:p>`
}

async function open(spec: SyntheticDocx, options: DocxSpellingOptions = {}) {
	const session = await sessionOf(spec)
	const checker = new FakeChecker()
	const clock = manualTimers()
	const spelling = new DocxSpelling(session, checker, { now: clock.now, timers: clock.timers, ...options })

	await clock.advance(0)

	return { session, checker, clock, spelling }
}

function marked(session: DocxEditorSession, marks: readonly SpellingMark[]): string[] {
	return marks.map(mark => `${mark.kind}:${session.state.doc.textBetween(mark.from, mark.to)}`)
}

function find(session: DocxEditorSession, text: string, occurrence: number = 0): number {
	let found = -1
	let seen = 0

	session.state.doc.descendants((node, pos) => {
		if (found >= 0) return false

		if (node.isText) {
			let index = (node.text ?? "").indexOf(text)

			while (index >= 0) {
				if (seen++ === occurrence) {
					found = pos + index

					return false
				}

				index = (node.text ?? "").indexOf(text, index + 1)
			}
		}

		return true
	})

	if (found < 0) throw new Error(`"${text}" not found`)

	return found
}

function caret(session: DocxEditorSession, pos: number): void {
	session.dispatch(session.state.tr.setSelection(TextSelection.create(session.state.doc, pos)))
}

describe("DocxSpelling", () => {
	it("marks misspelled and repeated words", async () => {
		const { session, spelling, checker } = await open({ body: para(run("Hello wrold, the the end.")) })

		expect(marked(session, spelling.marks())).toEqual(["spelling:wrold", "repeated:the"])
		// Each word once (the period variant only for the word before a period).
		expect(checker.checked.sort()).toEqual(["Hello", "end", "end.", "the", "wrold"].sort())
	})

	it("takes the language from styles, runs and the default", async () => {
		const styles = STYLES_PART(
			'<w:docDefaults><w:rPrDefault><w:rPr><w:lang w:val="de-DE"/></w:rPr></w:rPrDefault></w:docDefaults>' +
				'<w:style w:type="character" w:styleId="English"><w:name w:val="English"/><w:rPr><w:lang w:val="en-GB"/></w:rPr></w:style>'
		)
		const spec: SyntheticDocx = {
			body: para(run("Haus Hause ", ""), run("wrold Haus", '<w:rPr><w:rStyle w:val="English"/></w:rPr>')),
			parts: [styles],
			relationships: [{ id: "rIdS", type: "styles", target: "styles.xml" }]
		}
		const { session, spelling } = await open(spec)

		expect(marked(session, spelling.marks())).toEqual(["spelling:Hause", "spelling:wrold", "spelling:Haus"])

		const fallback = await open({ body: para(run("wrold", "")) }, { defaultLanguage: "en-US" })

		expect(marked(fallback.session, fallback.spelling.marks())).toEqual(["spelling:wrold"])

		const none = await open({ body: para(run("wrold", "")) })

		expect(none.spelling.marks()).toEqual([])
	})

	it("skips what Word does not proof", async () => {
		const body =
			para(run("wrold", '<w:rPr><w:noProof/><w:lang w:val="en-US"/></w:rPr>')) +
			para(run("wrold", '<w:rPr><w:vanish/><w:lang w:val="en-US"/></w:rPr>')) +
			para(`<w:del w:id="1" w:author="a"><w:r>${EN}<w:delText>wrold</w:delText></w:r></w:del>`) +
			para(run("WROLD wrold2 e.g snake_case https://wrold.example/wrold mail@wrold.example C:\\wrold\\x /usr/wrold")) +
			para(run("ain't", '<w:rPr><w:lang w:val="x-none"/></w:rPr>')) +
			para(`<w:fldSimple w:instr=" HYPERLINK wrold ">${run("hello")}</w:fldSimple>`)
		const { spelling } = await open({ body })

		expect(spelling.marks()).toEqual([])
	})

	it("finds addresses in linear time", () => {
		const spans = (text: string) => {
			const out: string[] = []
			const found = addressSpans(text)

			for (let i = 0; i < found.length; i += 2) out.push(text.slice(found[i], found[i + 1]))

			return out
		}

		expect(
			spans("see (https://x.example/a), www.filen.io, mailto:a@b, a@b.cd, C:\\dir\\f, \\\\srv\\s, /usr/bin, ~/x/y and/or /etc")
		).toEqual(["(https://x.example/a),", "www.filen.io,", "mailto:a@b,", "a@b.cd,", "C:\\dir\\f,", "\\\\srv\\s,", "/usr/bin,", "~/x/y"])

		const tokenOf = (length: number): string => {
			let token = ""

			for (let i = 0; token.length < length; i++) token += ((i * 2654435761) >>> 0).toString(36) + (i % 3 === 0 ? "/" : "+")

			return token
		}
		const least = (text: string): number => {
			let best = Infinity

			for (let k = 0; k < 6; k++) {
				const start = cpuMs()

				addressSpans(text)
				best = Math.min(best, cpuMs() - start)
			}

			return best
		}

		// Linear work grows about 4 times from a quarter of the length to the whole; quadratic work, 16.
		for (const make of [
			(n: number) => tokenOf(n),
			(n: number) => `x:${tokenOf(n)}`,
			(n: number) => `a@${tokenOf(n)}`,
			(n: number) => `www${tokenOf(n)}`,
			(n: number) => `${"a".repeat(n)}://`
		]) {
			const quarter = least(make(10_000))

			expect(least(make(40_000)) / Math.max(quarter, budget(0.2))).toBeLessThan(9)
		}
	})

	it("uses the complex-script slot for right-to-left text", async () => {
		const { session, spelling } = await open({
			body: para(run("wrold", '<w:rPr><w:rtl/><w:lang w:val="en-US" w:bidi="de-DE"/></w:rPr>'))
		})

		// Checked against German (the w:bidi slot), where it is unknown too.
		expect(marked(session, spelling.marks())).toEqual(["spelling:wrold"])
		expect(spelling.spellingAt(find(session, "wrold"))?.dictionary).toBe("de")
	})

	it("joins a word around soft hyphens and zero-width marks", async () => {
		const { session, spelling, checker } = await open({
			body: `<w:p><w:r>${EN}<w:t>pro</w:t><w:softHyphen/><w:t>gram</w:t></w:r><w:bookmarkStart w:id="0" w:name="b"/><w:r>${EN}<w:t xml:space="preserve"> a wo</w:t></w:r><w:bookmarkEnd w:id="0"/><w:r>${EN}<w:t>rd</w:t></w:r></w:p>`
		})

		expect(checker.checked).toContain("program")
		expect(checker.checked).toContain("word")
		expect(marked(session, spelling.marks())).toEqual([])
	})

	it("looks words up with ASCII apostrophes and accepts abbreviations before a period", async () => {
		const { spelling, checker } = await open({ body: para(run("don’t etc. Mr. hello.")) })

		expect(checker.checked).toContain("don't")
		expect(spelling.marks()).toEqual([])
	})

	it("honours w:hideSpellingErrors", async () => {
		const { spelling, checker } = await open({ body: para(run("wrold")), settings: "<w:hideSpellingErrors/>" })

		// Nothing is checked, so the checker is not held open.
		expect(checker.documents).toBe(0)
		expect(spelling.hidden).toBe(true)
		expect(spelling.marks()).toEqual([])
		expect(checker.checked).toEqual([])
	})

	it("maps marks through edits and does not mark the word being typed", async () => {
		const { session, spelling, clock } = await open({ body: para(run("wrold hello")) })
		const seen: string[][] = []

		spelling.subscribe(marks => seen.push(marked(session, marks)))

		// Typing before the marked word moves its mark at once.
		session.dispatch(session.state.tr.insertText("the ", find(session, "wrold")))
		expect(marked(session, spelling.marks())).toEqual(["spelling:wrold"])

		// A new misspelling at the caret stays unmarked while it is typed.
		const end = session.state.doc.content.size - 1

		caret(session, end)
		session.dispatch(session.state.tr.insertText(" helo"))
		await clock.advance(1000)
		expect(marked(session, spelling.marks())).toEqual(["spelling:wrold"])
		expect(spelling.spellingAt(find(session, "helo"))?.word).toBe("helo")

		// It is marked once the caret leaves it.
		caret(session, 1)
		expect(marked(session, spelling.marks())).toEqual(["spelling:wrold", "spelling:helo"])
		expect(seen.length).toBeGreaterThan(0)
	})

	it("moves marks through an edit in place, without making them or their list again", async () => {
		const { session, spelling, clock } = await open({ body: para(run("wrold hello")) + para(run("tow the teh")) })
		const before = spelling.marks()
		const heard: (readonly SpellingMark[])[] = []

		spelling.subscribe(marks => heard.push(marks))
		expect(marked(session, before)).toEqual(["spelling:wrold", "spelling:tow", "spelling:teh"])
		session.dispatch(session.state.tr.insertText("hello ", find(session, "wrold")))

		const after = spelling.marks()

		// The same issues in the same list, moved (a keystroke allocates nothing per mark); nothing announced.
		expect(after).toBe(before)
		expect(heard).toEqual([])
		expect(marked(session, after)).toEqual(["spelling:wrold", "spelling:tow", "spelling:teh"])

		// An edit that changes a mark's length or removes one makes a new list.
		session.dispatch(session.state.tr.delete(find(session, "tow"), find(session, "tow") + 3))
		expect(spelling.marks()).not.toBe(before)
		expect(heard.length).toBe(1)
		const kept = spelling.marks()

		expect(marked(session, kept)).toEqual(["spelling:wrold", "spelling:teh"])

		// A pass over the edited document keeps the issues it finds again.
		await clock.advance(1000)
		expect(spelling.marks().length).toBe(2)
		expect(spelling.marks().every((mark, k) => mark === kept[k])).toBe(true)
	})

	it("walks only what changed, and runs no pass once the document is checked", async () => {
		const body = Array.from({ length: 300 }, (_, i) => para(run(`hello wrold number ${String(i)} the end`))).join("")
		let ticks = 0
		const { session, spelling, clock, checker } = await open({ body }, { now: () => ticks++ })

		// "wrold" and "number" in each paragraph.
		expect(spelling.marks()).toHaveLength(600)

		checker.checked.length = 0
		session.dispatch(session.state.tr.insertText("x", find(session, "number 150")))

		const spy = vi.spyOn(Node.prototype, "nodesBetween")
		const descendants = vi.spyOn(Node.prototype, "descendants")
		const scanned = vi.spyOn(ParagraphScanner.prototype, "scan")

		await clock.advance(1000)

		// The pass after it walks the edited paragraph's range only, never the whole document.
		const ranges = spy.mock.calls.map(([from, to]) => to - from)

		expect(ranges.length).toBeGreaterThan(0)
		expect(Math.max(...ranges)).toBeLessThanOrEqual(session.state.doc.child(150).nodeSize + 2)
		expect(descendants).not.toHaveBeenCalled()
		// The edited paragraph and, at most, the ones it touches.
		expect(scanned.mock.calls.length).toBeLessThanOrEqual(3)
		expect(spelling.marks()).toHaveLength(600)

		// Checked: nothing scheduled, nothing walked while idle.
		spy.mockClear()
		await clock.advance(60_000)
		expect(spy).not.toHaveBeenCalled()
		expect(checker.checked).toEqual(["xnumber"])
	})

	it("keeps the marks' list while the word being typed grows", async () => {
		const { session, spelling } = await open({ body: para(run("wrold hello")) + para(run("tow the teh")) })
		const at = find(session, "wrold") + 2

		session.dispatch(session.state.tr.insertText("x", at))

		// The word typed in is not marked: a new list without it.
		const typing = spelling.marks()

		expect(marked(session, typing)).toEqual(["spelling:tow", "spelling:teh"])

		session.dispatch(session.state.tr.insertText("y", at + 1))
		expect(spelling.marks()).toBe(typing)
		expect(marked(session, spelling.marks())).toEqual(["spelling:tow", "spelling:teh"])
	})

	it("re-checks only changed paragraphs", async () => {
		const { session, checker, clock } = await open({ body: para(run("hello world")) + para(run("the end")) })

		checker.checked.length = 0
		session.dispatch(session.state.tr.insertText(" wrold", find(session, "end") + 3))
		await clock.advance(1000)
		expect(checker.checked).toEqual(["wrold"])
	})

	it("suggests, replaces, ignores and adds to the dictionary", async () => {
		const { session, spelling, checker, clock } = await open({
			body: para(run("A wrold in a wrold, the the text zorp. Dont’t")) + para(run("zorp"))
		})
		const first = find(session, "wrold")

		expect(await spelling.suggestions(first)).toEqual(["world"])
		expect(await spelling.suggestions(first, { more: true })).toEqual(["world", "wold"])
		expect(await spelling.suggestions(find(session, "zorp"))).toEqual(["slow"])
		expect(await spelling.suggestions(find(session, "the", 1))).toEqual([])
		expect(await spelling.suggestions(find(session, "Dont’t"))).toEqual(["Don’t"])

		expect(spelling.replaceWord(first + 2, "world")).toBe(true)
		expect(session.state.doc.textContent).toContain("A world in a wrold")
		await clock.advance(1000)

		// Deleting a repeated word takes the space before it.
		expect(spelling.replaceWord(find(session, "the", 1), "")).toBe(true)
		expect(session.state.doc.textContent).toContain("wrold, the text")
		await clock.advance(1000)

		expect(spelling.ignoreAll(find(session, "wrold"))).toBe(true)
		await clock.advance(0)
		expect(marked(session, spelling.marks())).toEqual(["spelling:zorp", "spelling:Dont’t", "spelling:zorp"])

		expect(await spelling.addToDictionary(find(session, "zorp"))).toBe(true)
		expect(checker.added).toEqual(["zorp"])
		await clock.advance(0)
		expect(marked(session, spelling.marks())).toEqual(["spelling:Dont’t"])

		expect(spelling.replaceWord(1, "x")).toBe(false)
		expect(spelling.spellingAt(1)).toBeUndefined()
	})

	it("refuses replacements in a read-only session and stops on dispose", async () => {
		const session = await sessionOf({ body: para(run("wrold")) }, { readOnly: true })
		const checker = new FakeChecker()
		const clock = manualTimers()
		const spelling = new DocxSpelling(session, checker, { now: clock.now, timers: clock.timers })

		await clock.advance(0)
		expect(marked(session, spelling.marks())).toEqual(["spelling:wrold"])
		expect(spelling.replaceWord(find(session, "wrold"), "world")).toBe(false)

		expect(checker.documents).toBe(1)
		spelling.dispose()
		spelling.dispose()
		expect(checker.documents).toBe(0)
		checker.checked.length = 0
		await checker.addToDictionary("x")
		await clock.advance(1000)
		expect(checker.checked).toEqual([])
	})

	it("keeps at most MAX_SPELLING_ISSUES marks", async () => {
		const body = para(run(Array.from({ length: MAX_SPELLING_ISSUES + 5 }, () => "zq").join(" ")))
		const { spelling } = await open({ body })

		expect(spelling.marks()).toHaveLength(MAX_SPELLING_ISSUES)
	})

	it("fills up to MAX_SPELLING_ISSUES again when marks before the limit go", async () => {
		const many = Array.from({ length: MAX_SPELLING_ISSUES }, () => "zq").join(" ")
		const { session, spelling, clock } = await open({ body: para(run("zq zq zq")) + para(run(many)) })

		expect(spelling.marks()).toHaveLength(MAX_SPELLING_ISSUES)

		const first = find(session, "zq zq zq")

		session.dispatch(session.state.tr.delete(first, first + 8))
		expect(spelling.marks()).toHaveLength(MAX_SPELLING_ISSUES - 3)
		await clock.advance(1000)
		expect(spelling.marks()).toHaveLength(MAX_SPELLING_ISSUES)
	})

	it("moves many marks through edits as each edit's mapping does", async () => {
		const body = Array.from({ length: 50 }, (_, i) => para(run(`wrold ${String(i)} zorp`))).join("")
		const { session, spelling } = await open({ body })
		const edits = [
			() => session.state.tr.insertText("ab", find(session, "wrold 10")),
			() => session.state.tr.insertText("cd", find(session, "zorp", 12) + 2),
			() => session.state.tr.delete(find(session, "zorp", 20) + 1, find(session, "wrold 22") + 3),
			() => session.state.tr.insertText("tail", session.state.doc.content.size - 1)
		]

		expect(spelling.marks()).toHaveLength(100)

		for (const edit of edits) {
			const before = spelling.marks().map(mark => ({ from: mark.from, to: mark.to }))
			const tr = edit()

			session.dispatch(tr)

			const expected = before
				.map(mark => ({ from: tr.mapping.map(mark.from, 1), to: tr.mapping.map(mark.to, -1) }))
				.filter(mark => mark.to > mark.from)
			const after = spelling.marks().map(mark => ({ from: mark.from, to: mark.to }))

			// Each mark where the mapping puts it (the word being typed may be left out).
			expect(after.every(mark => expected.some(other => other.from === mark.from && other.to === mark.to))).toBe(true)
			expect(after.length).toBeGreaterThanOrEqual(expected.length - 1)
		}
	})

	it("does not loop when checks fail or answer without verdicts", async () => {
		const run_ = async (check: (checker: FakeChecker) => Promise<void>) => {
			const session = await sessionOf({ body: para(run("wrold hello")) + para(run("zorp")) })
			const checker = new FakeChecker()
			const clock = manualTimers()
			let checks = 0
			let passes = 0

			checker.check = () => {
				checks++

				return check(checker)
			}

			const spelling = new DocxSpelling(session, checker, { now: clock.now, timers: clock.timers })

			spelling.subscribe(() => passes++)
			await clock.advance(10_000)

			const quiet = { checks, passes }

			// An edit asks once more.
			session.dispatch(session.state.tr.insertText("x", session.state.doc.content.size - 1))
			await clock.advance(10_000)

			return { quiet, after: { checks, passes } }
		}

		const rejecting = await run_(() => Promise.reject(new Error("no dictionary")))

		expect(rejecting.quiet.checks).toBe(1)
		expect(rejecting.quiet.passes).toBeLessThanOrEqual(2)
		expect(rejecting.after.checks).toBe(2)

		const empty = await run_(() => Promise.resolve())

		expect(empty.quiet.checks).toBe(1)
		expect(empty.quiet.passes).toBeLessThanOrEqual(3)
		expect(empty.after.checks).toBe(2)
	})

	it("makes progress past paragraphs waiting for verdicts", async () => {
		const body = Array.from({ length: 60 }, (_, i) => para(run(`wrold${"x".repeat(i % 5)} hello`))).join("")
		const session = await sessionOf({ body })
		const checker = new FakeChecker()
		const clock = manualTimers()
		let ticks = 0
		let release: () => void = () => undefined
		const slow = new Promise<void>(resolve => {
			release = resolve
		})
		const check = checker.check.bind(checker)

		checker.check = (dictionary, words) => slow.then(() => check(dictionary, words))

		const spelling = new DocxSpelling(session, checker, { now: () => ticks++, timers: clock.timers, budgetMs: 3 })

		await clock.advance(0)
		// Every paragraph was scanned once while the check is still outstanding.
		expect(checker.checked).toEqual([])
		release()
		await clock.advance(0)
		expect(spelling.marks()).toHaveLength(60)
	})

	it("scans a long document in slices", async () => {
		const body = Array.from({ length: 400 }, (_, i) => para(run(`hello wrold ${String(i % 2 === 0 ? "the" : "end")}`))).join("")
		let ticks = 0
		const { spelling } = await open({ body }, { budgetMs: 3, now: () => ticks++ })

		expect(spelling.marks().length).toBe(400)
	})
})
