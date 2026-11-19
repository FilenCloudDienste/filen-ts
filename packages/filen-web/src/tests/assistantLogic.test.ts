import { describe, expect, it } from "vitest"
import { ASSISTANT_TOOLS } from "@filen/shared/assistant"
import { EN_CATALOGS } from "@/lib/i18n/catalog"
import {
	canRemoveModel,
	currentStep,
	downloadByteFigures,
	durationFigure,
	downloadPercent,
	downloadingPercent,
	modelShowsLoading,
	resumedDownloadEnded,
	resumedDownloadStarted,
	proposalTargetKind,
	removableModelBytes,
	spokenText,
	stepCountNoun,
	stepsSummary,
	toolActivityKey,
	toolSubjectKey,
	transcriptRows,
	visibleProgress
} from "@/features/assistant/components/assistant.logic"
import type { TranscriptEntry, TranscriptStep } from "@/features/assistant/store/transcript"

const MODEL = { id: "m", name: "M", sizeBytes: 100 }

describe("downloadPercent", () => {
	it("floors to a whole percentage and clamps to 0..100", () => {
		expect(downloadPercent(0, 100)).toBe(0)
		expect(downloadPercent(999, 1000)).toBe(99)
		expect(downloadPercent(1000, 1000)).toBe(100)
		expect(downloadPercent(2000, 1000)).toBe(100)
	})

	it("reads 0 for an unknown size instead of dividing by zero", () => {
		expect(downloadPercent(10, 0)).toBe(0)
	})
})

describe("downloadByteFigures", () => {
	const total = 2_740_938_752

	it("shows both figures at one precision, so the received part never reads above the total", () => {
		// One decimal against two used to read "2.6 GiB of 2.55 GiB" here.
		expect(downloadByteFigures(total - 1_000_000, total)).toEqual({ received: "2.6 GiB", total: "2.6 GiB" })
		expect(downloadByteFigures(total, total)).toEqual({ received: "2.6 GiB", total: "2.6 GiB" })
		expect(downloadByteFigures(512 * 1024 * 1024, total)).toEqual({ received: "512.0 MiB", total: "2.6 GiB" })
	})

	it("caps the received part at the total and at zero", () => {
		expect(downloadByteFigures(total + 100_000_000, total).received).toBe("2.6 GiB")
		expect(downloadByteFigures(-5, total).received).toBe("0 B")
	})
})

describe("resumed downloads", () => {
	const downloading = (receivedBytes: number, resumed: boolean) =>
		({ kind: "downloading", model: MODEL, receivedBytes, waiting: false, resumed }) as const

	it("announces a download the runtime continued once, as it starts, and never one a click started", () => {
		expect(resumedDownloadStarted({ kind: "not-downloaded", model: MODEL, partialBytes: 5 }, downloading(5, true))).toBe(true)
		expect(resumedDownloadStarted({ kind: "unavailable", reason: "in-use-elsewhere", model: MODEL }, downloading(5, true))).toBe(true)
		expect(resumedDownloadStarted(downloading(5, true), downloading(6, true))).toBe(false)
		expect(resumedDownloadStarted({ kind: "not-downloaded", model: MODEL }, downloading(0, false))).toBe(false)
	})

	it("ends the announcement with the continued download, not with its progress", () => {
		expect(resumedDownloadEnded(downloading(5, true), downloading(6, true))).toBe(false)
		expect(resumedDownloadEnded(downloading(5, true), { kind: "downloaded", model: MODEL, idleUnloaded: false })).toBe(true)
		expect(resumedDownloadEnded(downloading(5, true), { kind: "not-downloaded", model: MODEL, partialBytes: 5 })).toBe(true)
		expect(resumedDownloadEnded(downloading(5, false), { kind: "downloaded", model: MODEL, idleUnloaded: false })).toBe(false)
	})

	it("gives a running download's whole percentage, and nothing otherwise", () => {
		expect(downloadingPercent(downloading(MODEL.sizeBytes / 2, false))).toBe(50)
		expect(downloadingPercent({ kind: "downloaded", model: MODEL, idleUnloaded: false })).toBeNull()
	})
})

describe("modelShowsLoading", () => {
	it("reads a model on disk as loading while a sent message waits for it, before the runtime says so", () => {
		expect(modelShowsLoading({ kind: "loading", model: MODEL, verifying: false }, false)).toBe(true)
		expect(modelShowsLoading({ kind: "downloaded", model: MODEL, idleUnloaded: true }, true)).toBe(true)
		expect(modelShowsLoading({ kind: "downloaded", model: MODEL, idleUnloaded: true }, false)).toBe(false)
		expect(modelShowsLoading({ kind: "ready", model: MODEL }, true)).toBe(false)
		expect(modelShowsLoading({ kind: "error", error: "load-failed", model: MODEL }, true)).toBe(false)
	})
})

describe("canRemoveModel", () => {
	it("offers removal only while the files are on disk", () => {
		expect(canRemoveModel({ kind: "downloaded", model: MODEL, idleUnloaded: false })).toBe(true)
		expect(canRemoveModel({ kind: "ready", model: MODEL })).toBe(true)
		expect(canRemoveModel({ kind: "error", error: "load-failed", model: MODEL })).toBe(true)
		expect(canRemoveModel({ kind: "error", error: "out-of-memory", model: MODEL })).toBe(true)
		expect(canRemoveModel({ kind: "error", error: "download-failed", model: MODEL })).toBe(false)
		expect(canRemoveModel({ kind: "not-downloaded", model: MODEL })).toBe(false)
		// What a stopped or failed download left behind is the user's to free.
		expect(canRemoveModel({ kind: "not-downloaded", model: MODEL, partialBytes: 1 })).toBe(true)
		expect(canRemoveModel({ kind: "error", error: "storage-full", model: MODEL, partialBytes: 1 })).toBe(true)
		expect(canRemoveModel({ kind: "downloading", model: MODEL, receivedBytes: 1, waiting: false, resumed: false })).toBe(false)
		expect(canRemoveModel({ kind: "loading", model: MODEL, verifying: false })).toBe(false)
		expect(canRemoveModel({ kind: "unavailable", reason: "in-use-elsewhere", model: MODEL })).toBe(false)
	})
})

describe("removableModelBytes", () => {
	it("quotes what Remove frees, not the manifest size", () => {
		expect(removableModelBytes({ kind: "not-downloaded", model: MODEL, partialBytes: 30 })).toBe(30)
		expect(removableModelBytes({ kind: "not-downloaded", model: MODEL, staleBytes: 250 })).toBe(250)
		expect(removableModelBytes({ kind: "not-downloaded", model: MODEL, partialBytes: 30, staleBytes: 250 })).toBe(280)
		expect(removableModelBytes({ kind: "error", error: "storage-full", model: MODEL, partialBytes: 40 })).toBe(40)
		expect(removableModelBytes({ kind: "error", error: "download-failed", model: MODEL, partialBytes: 40 })).toBe(40)
	})

	it("quotes the whole model while it is on disk", () => {
		expect(removableModelBytes({ kind: "error", error: "load-failed", model: MODEL })).toBe(100)
		expect(removableModelBytes({ kind: "error", error: "out-of-memory", model: MODEL })).toBe(100)
		expect(removableModelBytes({ kind: "downloaded", model: MODEL, idleUnloaded: false })).toBe(100)
		expect(removableModelBytes({ kind: "ready", model: MODEL })).toBe(100)
	})
})

describe("transcriptRows", () => {
	const user: TranscriptEntry = { kind: "user", id: "user:t1", turnId: "t1", text: "hi" }

	it("adds the waiting bubble while the running turn shows nothing yet", () => {
		expect(transcriptRows([user], "t1").at(-1)).toEqual({ kind: "thinking", id: "thinking" })
		expect(transcriptRows([user], null)).toEqual([user])
	})

	it("leaves it out once the turn has steps or a reply, but not for an earlier turn's", () => {
		const streaming: TranscriptEntry = { kind: "reply", id: "reply:r", turnId: "t1", text: "x", final: false }
		const steps: TranscriptEntry = {
			kind: "steps",
			id: "steps:t1",
			turnId: "t1",
			steps: [],
			startedAt: 0,
			lastAt: 0,
			outcome: null,
			expanded: null
		}
		const next: TranscriptEntry = { kind: "user", id: "user:t2", turnId: "t2", text: "again" }

		expect(transcriptRows([user, streaming], "t1")).toHaveLength(2)
		expect(transcriptRows([user, steps], "t1")).toHaveLength(2)
		expect(transcriptRows([user, steps, next], "t2")).toHaveLength(4)
	})
})

describe("toolActivityKey", () => {
	// The runtime sends tool names only; a tool added to the shared registry without wording here would
	// fall back to the generic line.
	it("words every tool in the shared registry with a key the catalog ships", () => {
		for (const tool of ASSISTANT_TOOLS) {
			const key = toolActivityKey(tool.name)

			expect(key, tool.name).not.toBe("assistantToolGeneric")
			expect(EN_CATALOGS.assistant[key], tool.name).toBeTypeOf("string")
		}
	})

	it("falls back to a generic line for a name it does not know, including prototype keys", () => {
		expect(toolActivityKey("made_up")).toBe("assistantToolGeneric")
		expect(toolActivityKey("constructor")).toBe("assistantToolGeneric")
	})
})

describe("step wording", () => {
	// A subject only ever comes from a tool's grounded arguments; every tool that has one gets a label for it.
	it("has a label with the subject for every tool with a grounded argument, from keys the catalog ships", () => {
		for (const tool of ASSISTANT_TOOLS) {
			const grounded = (tool.grounded.handles?.length ?? 0) + (tool.grounded.text?.length ?? 0) > 0
			const key = toolSubjectKey(tool.name)

			expect(key !== null, tool.name).toBe(grounded)

			if (key !== null) {
				expect(EN_CATALOGS.assistant[key], tool.name).toContain("{{subject}}")
			}
		}

		expect(toolSubjectKey("constructor")).toBeNull()
	})

	it("counts what a listing is of", () => {
		expect(stepCountNoun("list_notes")).toBe("notes")
		expect(stepCountNoun("list_chats")).toBe("chats")
		expect(stepCountNoun("list_playlists")).toBe("playlists")
		expect(stepCountNoun("search_items")).toBe("items")
	})

	it("shows seconds with one decimal below ten, and whole seconds while running", () => {
		expect(durationFigure(4230, false)).toEqual({ seconds: 4.23, fractionDigits: 1 })
		expect(durationFigure(12_900, false)).toEqual({ seconds: 12, fractionDigits: 0 })
		expect(durationFigure(4900, true)).toEqual({ seconds: 4, fractionDigits: 0 })
		expect(durationFigure(-5, false)).toEqual({ seconds: 0, fractionDigits: 1 })
	})

	it("shows the reading bar only while some of the prompt is left", () => {
		expect(visibleProgress(null)).toBeNull()
		expect(visibleProgress(1)).toBeNull()
		expect(visibleProgress(0.25)).toBe(0.25)
		expect(visibleProgress(-1)).toBe(0)
	})
})

describe("steps summary", () => {
	const step = (patch: Partial<Extract<TranscriptStep, { kind: "tool" }>>): TranscriptStep => ({
		id: "s",
		kind: "tool",
		status: "done",
		progress: null,
		tool: "search_items",
		subject: null,
		resultCount: null,
		resultMore: false,
		failure: null,
		startedAt: 0,
		endedAt: 1,
		...patch
	})
	const entry = (steps: TranscriptStep[]): Extract<TranscriptEntry, { kind: "steps" }> => ({
		kind: "steps",
		id: "steps:t1",
		turnId: "t1",
		steps,
		startedAt: 1000,
		lastAt: 5200,
		outcome: "complete",
		expanded: null
	})

	it("counts the calls and the turn's whole time, and flags a failure", () => {
		const routing: TranscriptStep = {
			id: "r",
			kind: "routing",
			status: "done",
			progress: null,
			route: "files",
			startedAt: 0,
			endedAt: 1
		}

		expect(stepsSummary(entry([routing, step({ id: "a" }), step({ id: "b", status: "failed", failure: "error" })]))).toEqual({
			tools: 2,
			durationMs: 4200,
			failed: true
		})
		expect(stepsSummary(entry([routing]))).toEqual({ tools: 0, durationMs: 4200, failed: false })
	})

	it("flags no failure for a declined call or a repeat, and does not count a repeat as a tool used", () => {
		expect(
			stepsSummary(
				entry([
					step({ id: "a" }),
					step({ id: "b", status: "failed", failure: "declined" }),
					step({ id: "c", status: "failed", failure: "repeated" })
				])
			)
		).toEqual({ tools: 2, durationMs: 4200, failed: false })
	})

	it("announces a card waiting on the user before anything else, then the call that runs, never a queued one", () => {
		const waiting = step({ id: "a", status: "waiting" })
		const running = step({ id: "b", status: "active" })
		const queued = step({ id: "c", status: "queued" })

		expect(currentStep(entry([waiting, queued]))).toBe(waiting)
		expect(currentStep(entry([running, queued]))).toBe(running)
		expect(currentStep(entry([step({ id: "d" }), queued]))).toBeNull()
	})

	it("announces the newest running row, never a thinking one", () => {
		const waiting = step({ id: "a", status: "waiting" })
		const thinking: TranscriptStep = { id: "t", kind: "thinking", status: "active", progress: null, startedAt: 0, endedAt: null }

		expect(currentStep(entry([waiting, thinking]))).toBe(waiting)
		expect(currentStep(entry([step({ id: "a" }), thinking]))).toBeNull()
	})
})

describe("proposalTargetKind", () => {
	it("reads the kind from the handle's leading letter, defaulting to a file", () => {
		expect(proposalTargetKind("d3")).toBe("directory")
		expect(proposalTargetKind("n1")).toBe("note")
		expect(proposalTargetKind("c2")).toBe("chat")
		expect(proposalTargetKind("x9")).toBe("file")
		expect(proposalTargetKind("")).toBe("file")
	})
})

describe("spokenText", () => {
	it("drops emphasis, code and heading/quote markers but keeps the words", () => {
		expect(spokenText("# Title\n> quoted **bold** and `code`\nmy_file.txt")).toBe("Title\nquoted bold and code\nmy_file.txt")
	})
})
