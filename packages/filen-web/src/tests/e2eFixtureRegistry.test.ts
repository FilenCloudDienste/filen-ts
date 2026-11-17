import { describe, expect, it } from "vitest"

// The e2e fixtures-setup builds every registered scenario in one run and gates every browser lane, so a registry
// entry it cannot upload blocks the whole suite. These checks run what the setup would do with each scenario, short
// of the browser: no generator is called, so nothing large is built.

const { FIXTURE_FILES, FIXTURE_SCENARIOS, fixturePayloads } = await import("../../e2e/fixtures/registry")
const { splitUpload } = await import("../../e2e/fixtures/scenarios")

type FixturePayload = ReturnType<typeof fixturePayloads>[keyof ReturnType<typeof fixturePayloads>]

const payloads = fixturePayloads()

function payloadForms(payload: FixturePayload): string[] {
	return ["buffer", "filledBytes", "generate"].filter(form => form in payload)
}

describe("e2e fixture registry", () => {
	it.each(FIXTURE_SCENARIOS)("uploads every file of %s exactly once", scenario => {
		const names = FIXTURE_FILES[scenario]
		const { onDisk, inline } = splitUpload(names, payloads)

		expect(names.length).toBeGreaterThan(0)
		expect([...onDisk, ...inline].map(({ name }) => name).sort()).toEqual([...names].sort())
	})

	it.each(FIXTURE_SCENARIOS)("gives each file of %s exactly one payload form", scenario => {
		for (const name of FIXTURE_FILES[scenario]) {
			const payload = payloads[name]
			const forms = payloadForms(payload)

			expect(forms, name).toHaveLength(1)

			if ("buffer" in payload) {
				expect(payload.buffer.length, name).toBeGreaterThan(0)
				expect(payload.mimeType, name).not.toBe("")
			} else if ("filledBytes" in payload) {
				expect(payload.filledBytes, name).toBeGreaterThan(0)
			}
		}
	})

	// The setup waits for each row by a substring match on its name, so a name inside a sibling's is a strict-mode
	// violation there.
	it.each(FIXTURE_SCENARIOS)("names no file of %s inside a sibling's name", scenario => {
		const names = FIXTURE_FILES[scenario]

		for (const name of names) {
			expect(
				names.filter(other => other !== name && other.includes(name)),
				name
			).toEqual([])
		}
	})

	it("has a payload for no file outside the registry", () => {
		const registered = new Set<string>(FIXTURE_SCENARIOS.flatMap(scenario => FIXTURE_FILES[scenario]))

		expect(Object.keys(payloads).filter(name => !registered.has(name))).toEqual([])
	})
})
