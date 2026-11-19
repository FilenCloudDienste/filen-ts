export { codeLanguage, codeLanguageIdFor, codeLanguageSupport } from "./languages"
export { HIGHLIGHT_MAX_CHARS, highlightCodeRuns, mountCodeHighlightStyle, type CodeRun } from "./highlight"
export { codeHighlightStyle, codeSyntaxVariables, codeTheme } from "./theme"
export {
	CODE_PHRASES,
	codeEditorSetup,
	codeFillParent,
	codeLineNumbers,
	codePhrases,
	codeReadOnly,
	type CodeEditorSetupOptions,
	type CodePhrase
} from "./setup"
export { CODE_EDITOR_SCOPE, CODE_SEARCH_SCOPE, codeKeymap, openReplacePanel, openSearchPanel, type CodeBinding } from "./search"
export { mountCodeCompare, type CodeCompareOptions } from "./merge"
