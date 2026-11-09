// Names of the engine-only functions the engine's formula text calls (refs/formulaRefs.ts writes them; the plugins in formula/functions
// define them). Kept apart from the plugins so formula text can be written without loading the engine.

// FILEN.CRITERION(value): a criteria argument of COUNTIF and its kind, an empty cell read as 0.
export const CRITERION_FUNCTION = "FILEN.CRITERION"

// FILEN.INTERSECT(range): the cell of a range in the formula's own row or column, as Excel reads a range where one
// value is wanted (implicit intersection), on any sheet.
export const INTERSECT_FUNCTION = "FILEN.INTERSECT"

// FILEN.CALL(lambda, value1, ...): a LAMBDA called, one a LET or LAMBDA name holds (f(1)) or written in place
// (LAMBDA(x,x+1)(1)), which the engine has no syntax for.
export const CALL_FUNCTION = "FILEN.CALL"

// FILEN.SPILL(formula): a dynamic-array formula, its array spilled over the cells beside and below it.
export const SPILL_FUNCTION = "FILEN.SPILL"

// FILEN.ANCHOR(cell): the cells the dynamic-array formula at the cell spills over (A1#, stored as ANCHORARRAY(A1)).
export const ANCHOR_FUNCTION = "FILEN.ANCHOR"

// FILEN.NULL(): Excel's #NULL!, what an intersection of references that do not meet gives (A1:A3 B1:B3).
export const NULL_FUNCTION = "FILEN.NULL"

// FILEN.OFFSET(reference, rows, cols, [height], [width]): OFFSET with an argument the engine cannot resolve as it
// parses (anything but an integer literal, or one left empty).
export const OFFSET_FUNCTION = "FILEN.OFFSET"

// FILEN.RANGE(reference, reference): the range from one reference to the other (A1:INDEX(A:A,3)), either a function's.
export const RANGE_FUNCTION = "FILEN.RANGE"

// FILEN.INDEXREF(reference, row_num, [column_num], [area_num]): INDEX giving the reference, a single cell's too, at an
// end of a range.
export const INDEX_REFERENCE_FUNCTION = "FILEN.INDEXREF"
