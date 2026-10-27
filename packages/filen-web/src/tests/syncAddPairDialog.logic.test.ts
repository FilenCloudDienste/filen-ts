import { describe, expect, it } from "vitest"
import type { DesktopSyncRootProblem } from "@filen/shared/desktop"
import { sync } from "@/locales/en/sync"
import {
	addPairRequest,
	canAdvance,
	defaultPairName,
	INITIAL_ADD_PAIR_FORM,
	isHiddenRemoteRow,
	localChoiceOutcome,
	nextStep,
	previousStep,
	remotePick,
	withLocalChoice,
	type AddPairForm,
	type LocalChoice
} from "@/features/sync/components/addPairDialog.logic"

const CATALOG: Record<string, string> = sync

const LOCAL: LocalChoice = { status: "ok", id: "token", path: "/Users/a/Projects", name: "Projects", warnings: [] }

const FILLED: AddPairForm = { local: LOCAL, remote: "remote-uuid", mode: "twoWay", name: "Projects" }

describe("add pair dialog", () => {
	it("step gating", () => {
		expect(canAdvance("local", INITIAL_ADD_PAIR_FORM)).toBe(false)
		expect(canAdvance("local", { ...INITIAL_ADD_PAIR_FORM, local: LOCAL })).toBe(true)
		expect(canAdvance("remote", { ...FILLED, remote: null })).toBe(false)
		expect(canAdvance("remote", FILLED)).toBe(true)
		expect(canAdvance("mode", FILLED)).toBe(true)
		expect(canAdvance("name", { ...FILLED, name: "   " })).toBe(false)
		expect(canAdvance("name", FILLED)).toBe(true)
		expect(nextStep("local")).toBe("remote")
		expect(nextStep("name")).toBeNull()
		expect(previousStep("local")).toBeNull()
		expect(previousStep("mode")).toBe("remote")
		expect(addPairRequest({ ...FILLED, remote: null })).toBeNull()
		expect(addPairRequest({ ...FILLED, name: " Work " })).toEqual({
			localRootId: "token",
			remoteRoot: "remote-uuid",
			mode: "twoWay",
			name: "Work"
		})
	})

	it("defaults to two-way", () => {
		expect(INITIAL_ADD_PAIR_FORM.mode).toBe("twoWay")
	})

	it("default name", () => {
		expect(defaultPairName(LOCAL)).toBe("Projects")
		expect(defaultPairName({ ...LOCAL, name: "" })).toBe("Projects")

		const named = withLocalChoice(INITIAL_ADD_PAIR_FORM, LOCAL)

		expect(named.name).toBe("Projects")
		// A new choice renames a defaulted name, never one the user typed.
		expect(withLocalChoice(named, { ...LOCAL, path: "/Users/a/Music", name: "Music" }).name).toBe("Music")
		expect(withLocalChoice({ ...named, name: "Mine" }, { ...LOCAL, path: "/Users/a/Music", name: "Music" }).name).toBe("Mine")
	})

	it("refusal codes map", () => {
		const problems: DesktopSyncRootProblem[] = [
			"notDirectory",
			"notWritable",
			"filesystemRoot",
			"homeDirectory",
			"appData",
			"temporary",
			"insidePair",
			"containsPair",
			"insideMount",
			"containsMount"
		]

		for (const problem of problems) {
			const outcome = localChoiceOutcome({ status: "refused", path: "/", problem })

			expect(outcome.kind).toBe("refused")

			if (outcome.kind === "refused") {
				expect(CATALOG[outcome.key], problem).toBeTypeOf("string")
			}
		}

		expect(localChoiceOutcome({ status: "canceled" }).kind).toBe("canceled")
	})

	it("warnings do not block", () => {
		const warned: LocalChoice = { ...LOCAL, warnings: ["iCloud", "cloudStorage", "oneDrive"] }
		const outcome = localChoiceOutcome(warned)

		expect(outcome.kind).toBe("ok")

		if (outcome.kind === "ok") {
			expect(outcome.warningKeys).toEqual(["warningICloud", "warningCloudStorage", "warningOneDrive"])
		}

		expect(canAdvance("local", withLocalChoice(INITIAL_ADD_PAIR_FORM, warned))).toBe(true)
	})

	it("the top level picks the account root", () => {
		expect(remotePick(null, "root-uuid")).toBe("root-uuid")
		expect(remotePick("", "root-uuid")).toBe("root-uuid")
		expect(remotePick(null, undefined)).toBeNull()
		expect(remotePick("child-uuid", "root-uuid")).toBe("child-uuid")
		expect(isHiddenRemoteRow(".filen", true)).toBe(true)
		expect(isHiddenRemoteRow(".filen", false)).toBe(false)
	})
})
