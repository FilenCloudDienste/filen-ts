// Scenario modules: each workstream declares its scenarios of the shared, read-only fixture tree
// (helpers/fixtures.ts) in a module of its own, registered once in registry.ts, so no two of them edit one
// list. A module holds the file names, which specs import, and the payloads, which only the setup builds.
//
// A module's file NAMES live in one place rather than in each spec because both sides need them: the setup uploads
// exactly this list, the spec locates exactly this list. Two copies that merely agree today would
// drift into a "row never appeared" timeout that names neither side. Names are plain and stable (no
// run id) — the containing scenario directory is already unique per run, so nothing collides.
//
// NO FILE NAME MAY BE A SUBSTRING OF A SIBLING: each spec locates its own rows with a bare
// `getByRole("option", { name })`, which matches accessible names by SUBSTRING, so a name that is a
// prefix of a sibling's turns the lookup for the shorter one into a strict-mode violation (observed
// live). The SCENARIO KEYS are no longer bound by it — every descent goes through descendInto, whose
// row lookup anchors the name on a token boundary (helpers/listing.ts).
//
// EXACT COUNTS ARE LOAD-BEARING. Several specs assert a listing's option count outright, and every
// preview pager leg depends on how many slots the overlay has (a two-file scenario is what makes
// "exactly one of Previous/Next is enabled from either end" true). Adding a file to a scenario
// "because it's convenient" breaks those tests; add a new scenario instead.
//
// File names are unique across the whole tree, and so are scenario keys: registry.ts throws on a repeat.

// Inline bytes, or a file synthesized on disk: a size to fill, or a generator. The disk forms exist for
// the big files: Playwright reads a path-based file input straight off local disk into the browser, so a
// 24 MiB payload never has to serialize through the Playwright<->driver bridge as a call argument (the
// same trick downloads.spec.ts used for the same file before this setup took the upload over). A
// generator also runs only in the setup, when its scenario uploads, never at import.
export interface InlineFixture {
	readonly buffer: Buffer
	readonly mimeType: string
}

export interface FilledFixture {
	readonly filledBytes: number
}

export interface GeneratedFixture {
	readonly generate: () => Buffer
}

export type DiskFixture = FilledFixture | GeneratedFixture

export type FixturePayload = InlineFixture | DiskFixture

export type ScenarioFiles = Readonly<Record<string, readonly string[]>>

export type ScenarioFileName<F extends ScenarioFiles> = F[keyof F][number]

export interface ScenarioModule<F extends ScenarioFiles> {
	readonly files: F
	// One payload per file name; a missing one is a compile error rather than a mid-run "row never appeared".
	// Called by the setup alone, so a spec importing the names builds no bytes.
	readonly payloads: () => Readonly<Record<ScenarioFileName<F>, FixturePayload>>
}

// `const` keeps each scenario's names a tuple, which the specs' row helpers map over.
export function scenarioModule<const F extends ScenarioFiles>(
	files: F,
	payloads: () => Readonly<Record<ScenarioFileName<F>, FixturePayload>>
): ScenarioModule<F> {
	return { files, payloads }
}
