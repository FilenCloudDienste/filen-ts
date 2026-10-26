import type { GateReason } from "./model"

// Why a deck opens view-only (an empty list: editable). Gated decks still export and convert: those write a new
// file and report what they drop (the signature, the write reservation).
//   signed          a package digital signature origin with a signature: editing would invalidate it
//   strict          ISO 29500 Strict namespaces: read through the Strict groups, saved only as a transitional copy
//   writeProtected  p:modifyVerifier (a write-reservation password)
//   malformed       markup in a part a save must rewrite could not be read
export interface GateFacts {
	readonly signatures: number
	readonly strict: boolean
	readonly modifyVerifier: boolean
	readonly malformed: boolean
}

export function gateReasons(facts: GateFacts): GateReason[] {
	const reasons: GateReason[] = []

	if (facts.signatures > 0) reasons.push("signed")
	if (facts.strict) reasons.push("strict")
	if (facts.modifyVerifier) reasons.push("writeProtected")
	if (facts.malformed) reasons.push("malformed")

	return reasons
}

// Adds a reason found after open (a part parsed lazily turned out malformed), once.
export function addGate(gate: GateReason[], reason: GateReason): void {
	if (!gate.includes(reason)) gate.push(reason)
}
