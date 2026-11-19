import type { ContentTypes, Relationships, SliceClock } from "../../../opc/index"
import type { XmlDocument } from "../../../xml/index"
import type { DocxEditContext } from "../../edit/context"
import type { StoryPart } from "../../model/index"
import type { PartReader } from "../../model/reader"
import type { DocxPackage } from "../../package"
import type { DocxChanges } from "../save"
import { commentChecks } from "./comments"
import { drawingChecks } from "./drawings"
import { fieldChecks } from "./fields"
import { formChecks } from "./forms"
import { mathChecks } from "./math"
import { noteChecks } from "./notes"
import { revisionChecks } from "./revisions"
import { sectionChecks } from "./sections"
import { tableChecks } from "./tables"
import { textboxChecks } from "./textbox"

// What a check of gate 2 sees of the save being checked.
export interface CheckInput {
	readonly original: DocxPackage
	readonly context: DocxEditContext
	readonly changes: DocxChanges
	// The content types as written.
	readonly types: ContentTypes
	readonly clock: SliceClock | undefined
	// A part's relationships as written.
	relationshipsOf(part: string): Promise<Relationships>
	// Whether the written package has the part.
	exists(part: string): boolean
	// How often an id the facts count ("space:id"; see verify.ts and DocxCheck.fact) appears in the story parts
	// as written, and in the source's. Complete in `done` only: during `part` they count the parts checked so far.
	ids(key: string): number
	source(key: string): number
	// The ids of id space `space` ("commentReference") the save wrote more of than the source had.
	added(space: string): string[]
}

// A changed XML part as gate 2 parsed it.
export interface CheckedPart {
	readonly name: string
	// The story part it is, when it is one.
	readonly part: StoryPart | undefined
	// The whole part as written, or (`skeleton`) a story part's rewritten stories alone, each copy of source
	// nodes in them standing as an empty <_/> (see verify.ts).
	readonly document: XmlDocument
	readonly skeleton: boolean
}

// Ids a feature adds to the facts gate 2 counts per id space ("comment:4"): an id counted more than once
// once a save added it is a duplicate. Asked of the WordprocessingML children named `elements` of the story
// parts' roots (comments, notes; gate 2 counts the ids of references, bookmarks and revisions itself).
export interface DocxFact {
	readonly elements: readonly string[]
	id(reader: PartReader, node: number): string | undefined
}

// A feature's checks. Each refuses the save by throwing DocxVerifyError.
export interface DocxCheck {
	readonly fact?: DocxFact
	// The check judges only the save's own markup (copies of the source are left alone): on a story part with
	// namespaces declared below its root, gate 2 runs its `part` on the skeleton as well as on the whole part.
	readonly newMarkupOnly?: boolean
	// Checks a changed XML part (relationships and content types are checked apart).
	part?(input: CheckInput, part: CheckedPart): Promise<void> | void
	// Checks the save as a whole, after every part.
	done?(input: CheckInput): Promise<void> | void
}

export const DOCX_CHECKS: readonly DocxCheck[] = [
	...commentChecks,
	...noteChecks,
	...sectionChecks,
	...tableChecks,
	...fieldChecks,
	...formChecks,
	...drawingChecks,
	...textboxChecks,
	...revisionChecks,
	...mathChecks
]

// Each check gives the host a turn after it when its slice is up (a part's checks together are long).
export async function checkPart(checks: readonly DocxCheck[], input: CheckInput, part: CheckedPart): Promise<void> {
	for (const check of checks) {
		if (check.part === undefined) continue

		await check.part(input, part)

		if (input.clock?.due === true) await input.clock.pause()
	}
}

export async function checkDone(checks: readonly DocxCheck[], input: CheckInput): Promise<void> {
	for (const check of checks) {
		if (check.done === undefined) continue

		await check.done(input)

		if (input.clock?.due === true) await input.clock.pause()
	}
}
