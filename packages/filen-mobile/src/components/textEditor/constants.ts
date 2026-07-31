import { Platform } from "react-native"

/**
 * Largest file the text/code editor will open.
 *
 * The bound is the editor, not the transfer: CodeMirror holds the whole document, builds a DOM for
 * the visible range over it, and re-tokenizes on edit, so past a few tens of megabytes it stops being
 * usable well before it runs out of memory. Refusing with an honest message beats opening something
 * that types at one character per second.
 *
 * Android is lower because the WebView renderer is a separate, more readily reclaimed process, and
 * losing it mid-edit loses the edit. Both numbers are judgement calls informed by the mechanism, not
 * measurements; revisit with field data rather than treating them as derived.
 */
export const MAX_TEXT_BYTES = Platform.OS === "ios" ? 32 * 1024 * 1024 : 16 * 1024 * 1024
