import type { Node } from "prosemirror-model"
import type { NewRelationship, PartBytes, SliceClock } from "../../../opc/index"
import type { XmlDocument } from "../../../xml/index"
import type { StoryDoc } from "../../edit/build"
import type { DocxEditContext, NewStory } from "../../edit/context"
import type { DocxEditorSession } from "../../edit/session"
import type { StoryPart } from "../../model/index"
import type { DocxPackage } from "../../package"
import type { NewStoryContainer } from "../newStory"
import type { StoryChange } from "../save"
import { commentParts } from "./comments"
import { coreParts } from "./core"
import { customXmlParts } from "./customXml"
import { mediaParts } from "./media"
import { noteParts } from "./notes"
import { settingsParts } from "./settings"

// The parts of one save, for the writers and contributors that add to them. Everything recorded here is
// checked by gate 2 like the rest of the save.
export interface SaveParts {
	readonly pkg: DocxPackage
	readonly context: DocxEditContext
	readonly clock: SliceClock | undefined
	// State of this save shared by a feature's writers (atoms, wrappers) and its contributor, by key.
	state<T>(key: object, create: () => T): T
	// A new relationship from `part`, its id as the part's relationships will give it. The part's
	// relationships must be loaded: every story part's are, others with loadRelationships.
	relationship(part: string, relationship: NewRelationship): string
	loadRelationships(part: string): Promise<void>
	// `name` when neither the package nor this save has a part of that name, else the first free one with a
	// number before the extension (word/comments.xml, word/comments1.xml...).
	freeName(name: string): string
	// Whether the save has written a part so far (a story part, a contributor's).
	changed(): boolean
	// The id of the main part's relationship to `target`, a part the save creates for stories the editor
	// added (context.newStories), so a reference to it (a section's header reference) can be written.
	storyRelationship(target: string): string | undefined
	// A source part's XML, when the package has the part.
	xml(name: string): Promise<XmlDocument | undefined>
	// New bytes for a part the package has. A story part whose stories this save rewrites or adds to cannot be
	// replaced whole; a story part replaced whole is checked as a whole part (well-formed, ids, references),
	// not paragraph by paragraph. Content types and relationships parts are the save's own.
	replace(name: string, bytes: PartBytes): void
	// A part the package does not have, typed `contentType` (an Override, unless a Default already types it).
	// Deflated unless `compress` says otherwise or the content type is compressed already (deflatesWell).
	add(name: string, bytes: PartBytes, contentType: string, options?: { readonly compress?: boolean }): void
	// A Default content type for files with `extension` (media); an extension typed otherwise is refused.
	addDefault(extension: string, contentType: string): void
}

// What a save wrote of the stories.
export interface WrittenStories {
	readonly sessions: readonly DocxEditorSession[]
	// Each session's document as the save read it.
	readonly docs: readonly Node[]
	// The stories rewritten (those written as their source are not).
	readonly stories: readonly StoryChange[]
}

// A story part's root start tag rewritten to declare more namespaces, and the prefix each gets.
export interface RootDeclarations {
	readonly open: string
	readonly prefixes: ReadonlyMap<string, string>
}

// A feature's share of a save beyond story content: the parts it keeps (comments, notes, media, settings,
// custom XML, core properties) and where its new stories go.
export interface PartContributor {
	// The document attributes (doc node) this contributor writes; a save refuses one set that none writes.
	readonly attributes?: readonly string[]
	// Whether something the save writes refers to `story`, beyond comment and note references (found by the
	// save itself): an added story nothing refers to is left out.
	references?(story: NewStory, docs: readonly Node[]): boolean
	// Where a new story (its item is -1) is written, when it is this contributor's: a new comment's
	// w:comment in the comments part.
	container?(story: StoryDoc, doc: Node): NewStoryContainer | undefined
	// Source story containers (items of their part) the save takes out of their part: a deleted comment. Each
	// must be a child of its part's root.
	removed?(parts: SaveParts, written: Omit<WrittenStories, "stories">): ReadonlyMap<StoryPart, readonly number[]>
	// `part`'s root start tag rewritten with namespaces its stories now need (a paragraph id in a part that does
	// not declare w14), with the prefix of each; undefined when none. Asked before the part's stories are
	// written (`stories` is empty then).
	declarations?(part: StoryPart, written: WrittenStories): RootDeclarations | undefined
	// Writes this contributor's parts once every story is written.
	contribute?(parts: SaveParts, written: WrittenStories): Promise<void>
}

// The core properties contributor goes last: it writes the core part bound controls edit.
export const PART_CONTRIBUTORS: readonly PartContributor[] = [commentParts, noteParts, mediaParts, settingsParts, customXmlParts, coreParts]
