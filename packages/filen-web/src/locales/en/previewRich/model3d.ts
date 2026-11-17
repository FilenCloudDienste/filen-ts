// "preview" namespace, rich viewers — the 3D model viewer (stl, obj, gltf, glb, 3mf, ply). Spread into
// preview.ts; same catalog rules.
export const previewRichModel3d = {
	/** 3D viewer — accessible name of the model's canvas */
	previewModelCanvasLabel: "3D model",
	/** 3D viewer — toolbar: frame the whole model again */
	previewModelFit: "Fit",
	/** 3D viewer — toolbar: back to the view the model opened at */
	previewModelReset: "Reset",
	/** 3D viewer — toolbar: draw the model's edges only */
	previewModelWireframe: "Wireframe",
	/** 3D viewer — toolbar: play the model's animation */
	previewModelPlay: "Play",
	/** 3D viewer — toolbar: stop the model's animation */
	previewModelStop: "Stop",
	/** 3D viewer — toolbar menu: an animation without a name, by its position */
	previewModelAnimation: "Animation {{number}}",
	/** 3D viewer — toolbar: show the file as text */
	previewModelShowSource: "View source",
	/** 3D viewer — back from the source to the model */
	previewModelShowModel: "View model",
	/** 3D viewer — toolbar: show or hide the information panel */
	previewModelInfo: "Info",
	/** 3D viewer — information panel: a count */
	previewModelCount: "{{value, number}}",
	/** 3D viewer — information panel: section of the model's figures */
	previewModelInfoModel: "Model",
	/** 3D viewer — information panel: the file's format */
	previewModelInfoFormat: "Format",
	/** 3D viewer — information panel: triangle count */
	previewModelInfoTriangles: "Triangles",
	/** 3D viewer — information panel: vertex count */
	previewModelInfoVertices: "Vertices",
	/** 3D viewer — information panel: mesh count */
	previewModelInfoMeshes: "Meshes",
	/** 3D viewer — information panel: material count */
	previewModelInfoMaterials: "Materials",
	/** 3D viewer — information panel: texture count */
	previewModelInfoTextures: "Textures",
	/** 3D viewer — information panel: the model's size along x, y and z, in its own units */
	previewModelInfoBounds: "Size",
	/** 3D viewer — information panel: section of the files the model references */
	previewModelInfoReferences: "Referenced files",
	/** 3D viewer — information panel: a referenced file that was not found */
	previewModelInfoMissing: "Not found",
	/** 3D viewer — information panel: a referenced file that cannot be read on its own (an archive's member) */
	previewModelInfoUnreadable: "Not readable on its own",
	/** 3D viewer — information panel: a referenced file outside the model's directory, or one that did not fit */
	previewModelInfoRefused: "Not loaded",
	/** 3D viewer — information panel: how many more referenced files of the kind above are not listed */
	previewModelInfoMore_one: "and {{count, number}} more",
	previewModelInfoMore_other: "and {{count, number}} more",
	/** 3D viewer — information panel: references to the network, refused */
	previewModelInfoBlocked: "Network references blocked",
	/** 3D viewer — information panel: textures too large to load */
	previewModelInfoSkipped: "Textures skipped",
	/** 3D viewer — notice over the model: referenced files not loaded (missing, not readable, or past the cap) */
	previewModelReferencesMissing_one: "{{count, number}} referenced file not loaded",
	previewModelReferencesMissing_other: "{{count, number}} referenced files not loaded",
	/** 3D viewer — the browser cannot draw 3D in a worker */
	previewModelNoWebgl: "This browser can't display 3D models here.",
	/** 3D viewer — the file did not parse */
	previewModelUnreadable: "This model can't be read.",
	/** 3D viewer — the model declares more geometry or unpacked data than the viewer loads */
	previewModelTooLarge: "This model is too large to preview.",
	/** 3D viewer — the parsed model needs more graphics memory than the viewer allows */
	previewModelTooComplex: "This model is too complex to display."
} as const
