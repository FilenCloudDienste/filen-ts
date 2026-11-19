export const instr = (text: string): string => `<w:r><w:instrText xml:space="preserve">${text}</w:instrText></w:r>`
export const char = (type: string): string => `<w:r><w:fldChar w:fldCharType="${type}"/></w:r>`
export const run = (text: string): string => `<w:r><w:t xml:space="preserve">${text}</w:t></w:r>`
export const para = (inner: string): string => `<w:p>${inner}</w:p>`

// A MACROBUTTON with a result, without one, with an empty one, w:fldSimple with and without one, one inside
// another field's result, and one whose display text is quoted.
export const BODY = [
	para(char("begin") + instr(' MACROBUTTON  synchronize "Sync contents" ') + char("separate") + run("*") + char("end")),
	para(char("begin") + instr(" MACROBUTTON  synchronize Without result ") + char("end")),
	para(char("begin") + instr(" MACROBUTTON NoMacro [Click here] ") + char("separate") + char("end")),
	para('<w:fldSimple w:instr=" MACROBUTTON NoMacro Simple text "/>'),
	para(`<w:fldSimple w:instr=" MACROBUTTON NoMacro Simple text ">${run("stored")}</w:fldSimple>`),
	para(
		char("begin") +
			instr(" QUOTE x ") +
			char("separate") +
			run("outer ") +
			char("begin") +
			instr(" MACROBUTTON NoMacro Nested ") +
			char("end") +
			char("end")
	),
	para(run("Body"))
].join("")

// What each of BODY's paragraphs shows, in order.
export const SHOWN = ["*", "Without result", "[Click here]", "Simple text", "stored", "outer ", "Body"]
