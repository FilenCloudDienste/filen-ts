import { describe, expect, it } from "vitest"
import { advanceSkipMasterKeysChain, type SkipMasterKeysStage } from "@/components/auth/skip-master-keys-chain.logic"

const STAGES: readonly SkipMasterKeysStage[] = ["stage1", "stage2", "stage3", "stage4"]

describe("advanceSkipMasterKeysChain (skip-master-keys ceremony orchestration)", () => {
	it("confirming advances one stage at a time, in order", () => {
		expect(advanceSkipMasterKeysChain("stage1", true)).toEqual({ status: "advance", stage: "stage2" })
		expect(advanceSkipMasterKeysChain("stage2", true)).toEqual({ status: "advance", stage: "stage3" })
		expect(advanceSkipMasterKeysChain("stage3", true)).toEqual({ status: "advance", stage: "stage4" })
	})

	it("confirming the last stage (the typed-confirm) completes the chain instead of advancing", () => {
		expect(advanceSkipMasterKeysChain("stage4", true)).toEqual({ status: "complete" })
	})

	it.each(STAGES)("cancelling aborts the whole chain from %s, never just the current stage", stage => {
		expect(advanceSkipMasterKeysChain(stage, false)).toEqual({ status: "aborted" })
	})

	it("never regresses to an earlier stage or repeats the current one on confirm", () => {
		for (const stage of STAGES) {
			const outcome = advanceSkipMasterKeysChain(stage, true)
			if (outcome.status === "advance") {
				expect(STAGES.indexOf(outcome.stage)).toBeGreaterThan(STAGES.indexOf(stage))
			}
		}
	})
})
