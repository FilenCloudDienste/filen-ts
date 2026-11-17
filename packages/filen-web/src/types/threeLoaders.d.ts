// patches/three@0.187.0.patch: ThreeMFLoader and USDLoader unpack a package through `unzip` when it is set, instead of
// three's own unzipSync.
import "three/examples/jsm/loaders/3MFLoader.js"
import "three/examples/jsm/loaders/USDLoader.js"

declare module "three/examples/jsm/loaders/3MFLoader.js" {
	interface ThreeMFLoader {
		unzip?: (data: Uint8Array) => Record<string, Uint8Array>
	}
}

declare module "three/examples/jsm/loaders/USDLoader.js" {
	interface USDLoader {
		unzip?: (data: Uint8Array) => Record<string, Uint8Array>
	}
}
