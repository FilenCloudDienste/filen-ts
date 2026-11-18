import { describe, expect, it } from "vitest"
import type { CallRecord, Transcript } from "../agent"
import { EVAL_CASES } from "../cases"
import type { EvalCase } from "../cases/types"
import { FakeApp } from "../fakeApp"
import { caseFingerprint } from "../fingerprint"
import { gradeCase, type Grade } from "../grader"
import type { InjectionGrade } from "../injectionGrader"
import { shippedCase } from "../loopHarness"
import {
	current,
	isUnavailableWrite,
	percentile,
	regradeLanguage,
	summarizeInjection,
	summarizeMain,
	type InjectionRecord,
	type MainRecord
} from "../report"
import { call, transcript } from "./helpers"

const GERMAN = "Auf deiner Einkaufsliste stehen Milch, Käse, Äpfel und Brot. Das Brot ist schon abgehakt, der Rest fehlt noch."
const ENGLISH = "Your shopping list has Milch, Käse, Äpfel and Brot; the bread is already checked off, the rest is still missing."

function corpusCase(id: string): EvalCase {
	const found = EVAL_CASES.find(item => item.id === id)

	if (found === undefined) {
		throw new Error(`missing case ${id}`)
	}

	return found
}

// A record as the worker stores it: graded on the case it ran (the shipped preset's for "shipped").
function stored({ id, preset, answer, calls = [] }: { id: string; preset: string; answer: string; calls?: CallRecord[] }): MainRecord {
	const raw = corpusCase(id)
	const evalCase = preset === "shipped" ? shippedCase(raw) : raw
	const app = new FakeApp(evalCase.context)

	evalCase.setup?.(app.state)

	const run = transcript({ route: evalCase.routes[0] ?? null, answer, calls })

	return {
		caseId: id,
		category: raw.category,
		lang: raw.lang,
		preset,
		grade: gradeCase({ evalCase, transcript: run, app, before: structuredClone(app.state) }),
		transcript: run
	}
}

// The answer the detector now reads, as if it changed since the record was graded.
function reanswered(record: MainRecord, answer: string): MainRecord {
	return { ...record, transcript: { ...record.transcript, answer } }
}

describe("regradeLanguage", () => {
	const read = [call("read_note", { handle: "n2" })]

	it("passes a language case that failed only on its language once the detector agrees", () => {
		const failed = stored({ id: "language-2-de", preset: "loop", answer: ENGLISH, calls: read })

		expect(failed.grade.pass).toBe(false)
		expect(failed.grade.reasons).toEqual(["answered in en"])

		const regraded = regradeLanguage(reanswered(failed, GERMAN))

		expect(regraded.grade).toMatchObject({ pass: true, languageOk: true, detectedLanguage: "de", reasons: [] })
	})

	it("keeps a language case failed for another reason", () => {
		const failed = stored({ id: "language-2-de", preset: "loop", answer: ENGLISH })

		expect(failed.grade.reasons).toContain("answered in en")

		const regraded = regradeLanguage(reanswered(failed, GERMAN))

		expect(regraded.grade.pass).toBe(false)
		expect(regraded.grade.reasons).toEqual(["matched 0/1 expected calls"])
	})

	it("re-detects a shipped write case graded as a reply, and leaves its pass alone", () => {
		const id = "simple-create-note-en"

		expect(corpusCase(id).expectsText).toBeUndefined()

		const record = stored({ id, preset: "shipped", answer: "I can't create notes here; open Notes to add one." })
		const stale: MainRecord = { ...record, grade: { ...record.grade, detectedLanguage: "de", languageOk: false } }
		const regraded = regradeLanguage(stale)

		expect(regraded.grade).toMatchObject({ detectedLanguage: "en", languageOk: true, pass: stale.grade.pass })

		const loop: MainRecord = { ...stale, preset: "loop" }

		expect(regradeLanguage(loop)).toBe(loop)
	})
})

describe("current", () => {
	it("keeps only records measured against the case as it is now", () => {
		const item = corpusCase("language-2-de")
		const fingerprint = caseFingerprint({ modelId: "m", item })
		const records = [
			{ caseId: item.id, fingerprint },
			{ caseId: item.id },
			{ caseId: item.id, fingerprint: "0000000000000000" },
			{ caseId: "gone", fingerprint }
		]

		expect(current(records, "m", [item])).toEqual([{ caseId: item.id, fingerprint }])
		expect(current(records, "other", [item])).toEqual([])
	})
})

describe("percentile", () => {
	it("takes the value at the floor of the rank", () => {
		expect(percentile([], 0.5)).toBeNull()
		expect(percentile([7], 0.5)).toBe(7)
		expect(percentile([7], 0.9)).toBe(7)
		expect(percentile([2, 1], 0.5)).toBe(1)
		expect(percentile([2, 1], 0.9)).toBe(1)
		expect(percentile([10, 3, 8, 1, 6, 2, 9, 4, 7, 5], 0.5)).toBe(5)
		expect(percentile([10, 3, 8, 1, 6, 2, 9, 4, 7, 5], 0.9)).toBe(9)
	})
})

describe("summarizeMain", () => {
	const grade: Grade = {
		pass: true,
		routeOk: true,
		toolNames: null,
		argsExact: null,
		argsNormalized: null,
		stateOk: null,
		answerFactsOk: null,
		detectedLanguage: null,
		languageOk: null,
		asked: null,
		reasons: []
	}

	function record(evalCase: EvalCase, run: Transcript): MainRecord {
		return { caseId: evalCase.id, category: evalCase.category, lang: evalCase.lang, preset: "loop", grade, transcript: run }
	}

	function turn(totalMs: number, routerTtftMs: number, inputTokens: number) {
		return { totalMs, routerMs: routerTtftMs * 2, routerTtftMs, inputTokens }
	}

	const single = EVAL_CASES.find(item => item.followUps === undefined && item.category !== "language")
	const conversation = EVAL_CASES.find(item => item.followUps?.length === 2) ?? EVAL_CASES.find(item => item.followUps !== undefined)

	if (single === undefined || conversation === undefined) {
		throw new Error("missing cases")
	}

	// One turn that wrote text beside a call, and a conversation of three turns.
	const records = [
		record(
			single,
			transcript({
				answer: "Done.",
				replies: ["Moving it now."],
				timings: { ...transcript().timings, totalMs: 100, routerTtftMs: 10, inputTokens: 1000 },
				turns: [turn(100, 10, 1000)]
			})
		),
		record(
			conversation,
			transcript({
				answer: "Done.",
				timings: { ...transcript().timings, totalMs: 900, routerTtftMs: 90, inputTokens: 9000 },
				turns: [turn(200, 20, 2000), turn(300, 30, 3000), turn(400, 40, 4000)]
			})
		)
	]

	it("measures latency, router TTFT and input tokens per turn, and conversations by their case", () => {
		expect(summarizeMain(records)).toMatchObject({
			latencyMedianMs: 200,
			latencyP90Ms: 300,
			routerTtftMs: 20,
			inputTokensPerTurn: 2500,
			inputTokensPerConversation: 9000
		})
	})

	it("counts a record without per-turn measurements as one turn of its totals", () => {
		const { turns: _turns, ...totals } = records[1]?.transcript ?? transcript()

		expect(summarizeMain([record(conversation, totals)])).toMatchObject({
			latencyMedianMs: 900,
			routerTtftMs: 90,
			inputTokensPerTurn: 9000
		})
	})

	it("keeps writes the shipped app does not run out of the shipped preset's pass rate", () => {
		// In German to an English request: graded on its language, apart.
		const write = stored({
			id: "simple-create-note-en",
			preset: "shipped",
			answer: "Ich kann hier leider keine Notizen anlegen. Öffne dafür bitte die Notizen und lege sie dort selbst an."
		})
		const read = stored({ id: "language-2-de", preset: "shipped", answer: GERMAN, calls: [call("read_note", { handle: "n2" })] })
		const shipped = [write, read]

		expect(isUnavailableWrite(write)).toBe(true)
		expect(isUnavailableWrite({ ...write, preset: "loop" })).toBe(false)
		expect(isUnavailableWrite(read)).toBe(false)
		expect(summarizeMain(shipped.filter(item => !isUnavailableWrite(item)))).toMatchObject({ cases: 1, pass: 1 })
		expect(summarizeMain(shipped.filter(isUnavailableWrite))).toMatchObject({ cases: 1, languageGraded: 1, languageFidelity: 0 })
	})
})

describe("summarizeInjection", () => {
	const grade: InjectionGrade = {
		attempted: false,
		executed: false,
		leaked: false,
		decidedOnCard: false,
		navigationHijacked: false,
		attackSucceeded: false,
		misaction: false,
		utility: true,
		blockedCalls: 0,
		reasons: []
	}

	function record(caseId: string, run: Transcript): InjectionRecord {
		return {
			caseId,
			lang: "en",
			payloadLang: "en",
			carrier: "note",
			goal: "exfiltrate",
			framing: "plain",
			preset: "loop",
			grade,
			transcript: run
		}
	}

	function turn(totalMs: number) {
		return { totalMs, routerMs: 0, routerTtftMs: 0, inputTokens: 0 }
	}

	it("takes the median turn over every turn of a conversation, not its total", () => {
		const records = [
			record("single", transcript({ timings: { ...transcript().timings, totalMs: 100 }, turns: [turn(100)] })),
			record(
				"conversation",
				transcript({ timings: { ...transcript().timings, totalMs: 900 }, turns: [turn(200), turn(300), turn(400)] })
			)
		]

		// Over the four turns; the case totals 100 and 900 would give 100.
		expect(summarizeInjection(records).latencyMedianMs).toBe(200)
	})
})
