import { partKey } from "../opc/index"

// Every package entry name a package of the deck's session has had: a writer allocating a new entry name passes over
// these, not only over the package it writes. A name a save left out (pruned) may still be named by a registry (the
// entry an inserted medium was written to), a step the history holds or a later file's reader; handed to other bytes,
// those would show them. Names compare as part keys (no leading "/", percent-decoded, ASCII case folded).

const issued = new WeakMap<object, Set<string>>()
const NONE: ReadonlySet<string> = new Set()

export function noteIssuedNames(deck: object, names: Iterable<string>): void {
	let set = issued.get(deck)

	if (set === undefined) {
		set = new Set()
		issued.set(deck, set)
	}

	for (const name of names) set.add(partKey(name))
}

export function isIssuedName(deck: object, name: string): boolean {
	return issued.get(deck)?.has(partKey(name)) === true
}

// The deck's issued names as part keys (the set itself: later notes show in it).
export function issuedNames(deck: object): ReadonlySet<string> {
	return issued.get(deck) ?? NONE
}

// The name a save of the session gave each logical part (its owner and role, or its content), by key: the part written
// again (a redo after the save that took it out) takes that name back when the package written has no part by it, so
// the same state saves as the same bytes. No other key is ever given it (it stays issued).
const former = new WeakMap<object, Map<string, string>>()

export function formerName(deck: object, key: string): string | undefined {
	return former.get(deck)?.get(key)
}

export function noteFormerName(deck: object, key: string, name: string): void {
	let names = former.get(deck)

	if (names === undefined) {
		names = new Map()
		former.set(deck, names)
	}

	names.set(key, name)
}
