// `window.desktop` is the desktop shell's preload bridge (@filen/shared/desktop). Absent in a plain browser;
// read it only through src/lib/desktop.ts.
import type { DesktopBridge } from "@filen/shared/desktop"

declare global {
	interface Window {
		readonly desktop?: DesktopBridge
	}
}
