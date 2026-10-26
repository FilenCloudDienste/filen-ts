export {
	CONTENT_TYPES_NAMESPACE,
	CONTENT_TYPES_PART,
	ContentTypes,
	editContentTypes,
	parseContentTypes,
	type ContentTypeChanges
} from "./contentTypes"
export { crc32 } from "./crc32"
export { OpcError, ZipError, type OpcErrorCode, type ZipErrorCode } from "./errors"
export { bytesSource, chunksSource, memorySink, type ByteSink, type ByteSource, type MemorySink } from "./io"
export { BytePieces, isByteChunks, joinBytes, type ByteChunks, type PartBytes } from "./pieces"
export { OpcPackage } from "./package"
export { isValidPartName, partKey, partNameUri, relationshipsPartName, relativeTarget, resolvePartName } from "./partNames"
export {
	RELATIONSHIPS_NAMESPACE,
	Relationships,
	addRelationships,
	parseRelationships,
	type NewRelationship,
	type Relationship
} from "./relationships"
export {
	DEFAULT_ZIP_LIMITS,
	ZIP64_COMPRESSED,
	ZIP64_OFFSET,
	ZIP64_UNCOMPRESSED,
	ZipArchive,
	decodeEntryName,
	type EntryLayout,
	type InflateHook,
	type ZipEntry,
	type ZipLimits,
	type ZipOpenOptions
} from "./zipReader"
export {
	planZip,
	writeZip,
	type PartChange,
	type PlannedArchive,
	type WriteZipOptions,
	type WriteZipReport,
	type ZipChanges,
	type ZipPlan,
	type ZipPlanItem
} from "./zipWriter"
export { SliceClock, sliceClock, type Slicing } from "../slicing"
export {
	MEDIA_LIMITS,
	PRESENTATION_ZIP_LIMITS,
	checkPackage,
	confirmMedia,
	imageDimensions,
	imageWithinBudget,
	isMediaCandidate,
	isMediaRelationship,
	mediaTargets,
	sniffMedia,
	type EntryClass,
	type MediaContainer,
	type MediaLimits,
	type MediaNotice,
	type PackagePolicy
} from "./mediaPolicy"
