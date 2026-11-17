import { XmlDomParser } from "@/features/preview/lib/model3d/xmlDom"

// What a loader reads from a window in the 3D worker, which has none: ThreeMFLoader parses its XML with DOMParser.
// Nothing else of a window is provided.
export function installModelGlobals(): void {
	if (!("DOMParser" in globalThis)) Object.assign(globalThis, { DOMParser: XmlDomParser })
}
