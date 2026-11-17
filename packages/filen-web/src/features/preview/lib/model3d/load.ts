import {
	Box3,
	BufferGeometry,
	DoubleSide,
	Group,
	Mesh,
	MeshStandardMaterial,
	Points,
	PointsMaterial,
	Sphere,
	Texture,
	type AnimationClip,
	type Material,
	type Object3D,
	type WebGLRenderer
} from "three"
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js"
import { PLYLoader } from "three/examples/jsm/loaders/PLYLoader.js"
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js"
import { MTLLoader } from "three/examples/jsm/loaders/MTLLoader.js"
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js"
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js"
import { KTX2Loader } from "three/examples/jsm/loaders/KTX2Loader.js"
import { ThreeMFLoader } from "three/examples/jsm/loaders/3MFLoader.js"
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js"
import { USDLoader } from "three/examples/jsm/loaders/USDLoader.js"
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js"
import { ZipArchive, bytesSource } from "@filen/office/core/opc"
import { THREE_ASSETS } from "virtual:three-assets"
import {
	preflightGltf,
	preflightPly,
	preflightStl,
	preflightZip,
	type ModelFormat,
	type Preflight
} from "@/features/preview/lib/model3d/preflight.logic"

// A model file parsed into a three scene in the 3D worker, after its preflight. Every reference (an OBJ's MTL, an
// MTL's or glTF's textures and buffers) is requested as `filen-ref:///<path>` and answered by the resource sandbox;
// embedded resources as blob: or data: URLs, answered locally.

export const REFERENCE_BASE = "filen-ref:///"

export class ModelRefusedError extends Error {
	readonly reason: Exclude<Preflight, { ok: true }>["reason"]

	constructor(reason: Exclude<Preflight, { ok: true }>["reason"]) {
		super(reason)

		this.name = "ModelRefused"
		this.reason = reason
	}
}

export interface LoadedModel {
	readonly root: Object3D
	readonly animations: readonly AnimationClip[]
}

function buffer(bytes: Uint8Array): ArrayBuffer {
	return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength && bytes.buffer instanceof ArrayBuffer
		? bytes.buffer
		: bytes.slice().buffer
}

function text(bytes: Uint8Array): string {
	return new TextDecoder().decode(bytes)
}

function refuse(check: Preflight): void {
	if (!check.ok) throw new ModelRefusedError(check.reason)
}

const SURFACE = 0xb4bcc8

// A bare geometry (STL, PLY) as a lit mesh, or as points when it has no faces.
function geometryObject(geometry: BufferGeometry): Object3D {
	const colored = geometry.hasAttribute("color")

	if (geometry.index === null && !geometry.hasAttribute("normal") && geometry.getAttribute("position").count % 3 !== 0) {
		return new Points(
			geometry,
			new PointsMaterial({ size: 0.01, vertexColors: colored, color: colored ? 0xffffff : SURFACE, sizeAttenuation: true })
		)
	}

	if (!geometry.hasAttribute("normal")) geometry.computeVertexNormals()

	return new Mesh(
		geometry,
		new MeshStandardMaterial({ color: colored ? 0xffffff : SURFACE, vertexColors: colored, roughness: 0.6, metalness: 0.1 })
	)
}

async function zipPreflight(bytes: Uint8Array): Promise<void> {
	const archive = await ZipArchive.open(bytesSource(bytes))

	refuse(preflightZip(archive.entries.map(entry => ({ compressed: entry.compressedSize, uncompressed: entry.uncompressedSize }))))
}

// The MTL files an OBJ names (`mtllib a.mtl b.mtl`), relative to it.
export function mtlLibraries(obj: string): string[] {
	const names: string[] = []

	for (const match of obj.matchAll(/^\s*mtllib\s+(.+?)\s*$/gm)) {
		const name = match[1]

		if (name !== undefined) names.push(name)
	}

	return names
}

function directoryOf(path: string): string {
	const slash = path.lastIndexOf("/")

	return slash === -1 ? "" : path.slice(0, slash + 1)
}

async function loadObj(source: string, fetchText: (url: string) => Promise<string | null>): Promise<LoadedModel> {
	const loader = new OBJLoader()

	for (const library of mtlLibraries(source)) {
		const mtl = await fetchText(REFERENCE_BASE + library)

		if (mtl === null) continue

		const mtlLoader = new MTLLoader()

		// Both faces: exported meshes often have open or inconsistently wound surfaces.
		mtlLoader.setMaterialOptions({ side: DoubleSide })

		const materials = mtlLoader.parse(mtl, REFERENCE_BASE + directoryOf(library))

		materials.preload()
		loader.setMaterials(materials)
	}

	return { root: loader.parse(source), animations: [] }
}

function loadGltf(bytes: Uint8Array, binary: boolean, renderer: WebGLRenderer | null): Promise<LoadedModel> {
	refuse(preflightGltf(bytes, binary))

	const loader = new GLTFLoader()
	// One decoder worker each: a preview decodes one model.
	const draco = new DRACOLoader()
		.setDecoderPath({ js: `${THREE_ASSETS.draco}draco_wasm_wrapper.js`, wasm: `${THREE_ASSETS.draco}draco_decoder.wasm` })
		.setWorkerLimit(1)

	loader.setDRACOLoader(draco)
	loader.setMeshoptDecoder(MeshoptDecoder)

	let ktx2: KTX2Loader | null = null

	if (renderer !== null) {
		ktx2 = new KTX2Loader().setTranscoderPath(THREE_ASSETS.basis).setWorkerLimit(1).detectSupport(renderer)
		loader.setKTX2Loader(ktx2)
	}

	return loader
		.parseAsync(binary ? buffer(bytes) : text(bytes), REFERENCE_BASE)
		.then(gltf => ({ root: gltf.scene, animations: gltf.animations }))
		.finally(() => {
			draco.dispose()
			ktx2?.dispose()
		})
}

// Parses `bytes` as `format`. Rejects with ModelRefusedError when a preflight refuses it, with the loader's error when
// it does not parse.
export async function loadModel(
	bytes: Uint8Array,
	format: ModelFormat,
	renderer: WebGLRenderer | null,
	fetchText: (url: string) => Promise<string | null>
): Promise<LoadedModel> {
	switch (format) {
		case "stl":
			refuse(preflightStl(bytes))

			return { root: geometryObject(new STLLoader().parse(buffer(bytes))), animations: [] }
		case "ply":
			refuse(preflightPly(bytes))

			return { root: geometryObject(new PLYLoader().parse(buffer(bytes))), animations: [] }
		case "obj":
			return await loadObj(text(bytes), fetchText)
		case "gltf":
			return await loadGltf(bytes, false, renderer)
		case "glb":
			return await loadGltf(bytes, true, renderer)
		case "3mf":
			await zipPreflight(bytes)

			return { root: new ThreeMFLoader().parse(buffer(bytes)), animations: [] }
		case "fbx": {
			const root = new FBXLoader().parse(buffer(bytes), REFERENCE_BASE)

			return { root, animations: root.animations }
		}
		case "usdz":
			await zipPreflight(bytes)

			return { root: new USDLoader().parse(buffer(bytes), REFERENCE_BASE), animations: [] }
	}
}

export interface ModelInfo {
	readonly triangles: number
	readonly vertices: number
	readonly meshes: number
	readonly materials: number
	readonly textures: number
	// Size along x, y and z, in the model's units.
	readonly size: readonly [number, number, number]
	// Bytes of geometry attributes and indices, and of textures at their drawn size.
	readonly attributeBytes: number
	readonly textureBytes: number
}

function materialsOf(object: Object3D): Material[] {
	const material = (object as { material?: Material | Material[] }).material

	if (material === undefined) return []

	return Array.isArray(material) ? material : [material]
}

function texturesOf(material: Material): Texture[] {
	return Object.values(material).filter((value): value is Texture => value instanceof Texture)
}

export function modelInfo(root: Object3D): ModelInfo {
	const materials = new Set<Material>()
	const textures = new Set<Texture>()
	let triangles = 0
	let vertices = 0
	let meshes = 0
	let attributeBytes = 0

	root.traverse(object => {
		const geometry = (object as { geometry?: BufferGeometry }).geometry

		if (!(geometry instanceof BufferGeometry)) return

		meshes++

		const position = geometry.getAttribute("position")

		vertices += position.count
		triangles += object instanceof Mesh ? Math.floor((geometry.index?.count ?? position.count) / 3) : 0

		for (const attribute of Object.values(geometry.attributes)) attributeBytes += attribute.array.byteLength

		attributeBytes += geometry.index?.array.byteLength ?? 0

		for (const material of materialsOf(object)) {
			materials.add(material)

			for (const texture of texturesOf(material)) textures.add(texture)
		}
	})

	let textureBytes = 0

	for (const texture of textures) {
		const image = texture.image as { width?: number; height?: number } | null

		textureBytes += (image?.width ?? 0) * (image?.height ?? 0) * 4
	}

	const box = new Box3().setFromObject(root)
	const size = box.isEmpty() ? [0, 0, 0] : [box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z]

	return {
		triangles,
		vertices,
		meshes,
		materials: materials.size,
		textures: textures.size,
		size: [size[0] ?? 0, size[1] ?? 0, size[2] ?? 0],
		attributeBytes,
		textureBytes
	}
}

export function boundingSphere(root: Object3D): { center: [number, number, number]; radius: number } {
	const box = new Box3().setFromObject(root)

	if (box.isEmpty()) return { center: [0, 0, 0], radius: 1 }

	const sphere = box.getBoundingSphere(new Sphere())

	return { center: [sphere.center.x, sphere.center.y, sphere.center.z], radius: Math.max(sphere.radius, 1e-6) }
}

export function setWireframe(root: Object3D, on: boolean): void {
	root.traverse(object => {
		for (const material of materialsOf(object)) {
			if ("wireframe" in material) (material as { wireframe: boolean }).wireframe = on
		}
	})
}

// A parsed group's root, so the scene holds one object.
export function asGroup(root: Object3D): Object3D {
	if ("isGroup" in root && root.isGroup === true) return root

	const group = new Group()

	group.add(root)

	return group
}
