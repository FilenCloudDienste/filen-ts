import { XmlDomParser } from "@/features/preview/lib/model3d/xmlDom"

// What the loaders read from a window in the 3D worker, which has none: FBXLoader sizes the cameras a file declares
// from window.innerWidth and innerHeight (those cameras are never drawn through); ThreeMFLoader parses its XML with
// DOMParser. Nothing else of a window is provided.
export function installModelGlobals(): void {
	if (!("window" in globalThis)) Object.assign(globalThis, { window: { innerWidth: 1, innerHeight: 1, devicePixelRatio: 1 } })
	if (!("DOMParser" in globalThis)) Object.assign(globalThis, { DOMParser: XmlDomParser })
}
