import type { SheetFeature } from "../../sheet/registry"
import type { XlsxDocument } from "./document"
import { freezeFeature } from "./freeze"
import { hideFeature } from "./hide"
import { mergeFeature } from "./merge"
import { protectionFeature } from "./protection"
import { sheetCopyFeature } from "./sheetCopy"
import { moveCellsFeature } from "./moveCells"
import { shiftCellsFeature } from "./shiftCells"
import { sheetOpsFeature } from "./sheets"

// The structure features of an xlsx session: sheets deleted, moved, hidden and coloured; rows and columns hidden;
// frozen panes; merges; protection; sheets duplicated; cells inserted, deleted and dragged.
export const STRUCTURE_FEATURES: readonly SheetFeature<XlsxDocument>[] = [
	sheetOpsFeature,
	sheetCopyFeature,
	hideFeature,
	freezeFeature,
	mergeFeature,
	protectionFeature,
	shiftCellsFeature,
	moveCellsFeature
]
