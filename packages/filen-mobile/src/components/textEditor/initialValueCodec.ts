// The DOM (WebView) text editors receive their initial content as an `initialValue`
// prop. Expo DOM components serialize initial props into the WebView through
// react-native-webview's `injectedJavaScriptObject`, whose injection embeds the
// JSON into a JS string literal. Note/editor HTML containing quotes, newlines or
// other special characters corrupts that literal (Expo SDK 56 + react-native-webview),
// which crashes the DOM component runtime ("$$EXPO_DOM_HOST_OS is not defined").
//
// Encoding the value to base64 keeps it within a JSON/JS-injection-safe character
// set, so the initial prop survives serialization. The DOM side decodes it before use.

/** Encode editor initial content (native side, before passing to the DOM component). */
export function encodeEditorInitialValue(value: string): string {
	return Buffer.from(value, "utf8").toString("base64")
}

/** Decode editor initial content (DOM/WebView side, before applying to the editor). */
export function decodeEditorInitialValue(encoded: string): string {
	if (!encoded) {
		return ""
	}

	const binary = atob(encoded)
	const bytes = Uint8Array.from(binary, char => char.charCodeAt(0))

	return new TextDecoder().decode(bytes)
}
