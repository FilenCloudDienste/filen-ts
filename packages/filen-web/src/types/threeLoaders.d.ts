// patches/three@0.187.0.patch: ThreeMFLoader unpacks a package through `unzip` when it is set, instead of three's own
// unzipSync.
import "three/examples/jsm/loaders/3MFLoader.js"

declare module "three/examples/jsm/loaders/3MFLoader.js" {
	interface ThreeMFLoader {
		unzip?: (data: Uint8Array) => Record<string, Uint8Array>
	}
}
