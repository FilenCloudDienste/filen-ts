export { applyAddText, applyTextEdit, isTagged, type TextEditResult } from "./apply"
export { prepareTextEdit, type TextEditSource, type TextEditStyle } from "./prepare"
export { readStext, type PdfQuad, type PdfRect, type StextChar, type StextLine, type StextPage } from "./stext"
export {
	hitTestText,
	narrowTarget,
	newTextFrame,
	quadBounds,
	type HitTestOptions,
	type TextEditChar,
	type TextEditHit,
	type TextEditRefusal,
	type TextEditTarget
} from "./target"
