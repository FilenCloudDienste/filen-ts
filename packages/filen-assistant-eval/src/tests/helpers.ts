import type { CallRecord, Transcript } from "../agent"

// A transcript with every count and timing zeroed; each suite passes its own route, answer and steps.
export function transcript(overrides: Partial<Transcript> = {}): Transcript {
	return {
		route: "organize",
		intent: "change",
		routeRaw: "organize change",
		calls: [],
		answer: "",
		replies: [],
		invalidOutputs: 0,
		unrecovered: false,
		steps: 1,
		stepCapHit: false,
		quarantineCalls: 0,
		timings: {
			routerMs: 0,
			routerTtftMs: 0,
			firstStepTtftMs: null,
			totalMs: 0,
			generations: 0,
			inputTokens: 0,
			outputTokens: 0,
			decodeMs: 0
		},
		...overrides
	}
}

export function call(tool: string, args: Record<string, unknown>, status: CallRecord["status"] = "ok", consequential = false): CallRecord {
	return {
		step: 1,
		tool,
		args,
		status,
		consequential
	}
}
