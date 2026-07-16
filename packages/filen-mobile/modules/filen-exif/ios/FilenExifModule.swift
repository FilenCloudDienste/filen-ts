import ExpoModulesCore
import ImageIO
import Foundation

/**
 Native EXIF/XMP transplant for the re-encode paths (HEIC→JPG conversion, camera-upload
 compression). It copies the SOURCE image's metadata into the already-re-encoded TARGET
 JPEG without decoding or re-encoding a single pixel:

   CGImageSourceCopyMetadataAtIndex(source)   // full CGImageMetadata: EXIF + XMP + GPS + …
   CGImageDestinationCopyImageSource(dst, target, { kCGImageDestinationMetadata: metadata })

 `CGImageDestinationCopyImageSource` streams the target's compressed image data through
 verbatim and only rewrites its metadata segments — no bitmap is allocated, no DCT re-encode,
 so it is both memory-light and lossless for the pixels. Orientation is forced to 1 because
 the re-encode already baked rotation into the pixels, and the PixelXDimension/YDimension EXIF
 tags are set to the TARGET's actual size (the copied source dims would otherwise be stale — and
 transposed for a rotated photo whose pixels were baked upright). Proprietary Apple MakerNote is
 dropped: it has no CGImageMetadata/XMP representation, matching the deliberate "standard EXIF +
 XMP" scope (the Android half's allowlist drops it too).

 Every failure path returns `false` (never throws to JS) and leaves the target untouched, so
 a transplant can never break or corrupt an upload — the caller just keeps the plain
 re-encoded file.
 */
public final class FilenExifModule: Module {
	public func definition() -> ModuleDefinition {
		Name("FilenExif")

		// Pin the ImageIO work to the global CONCURRENT utility queue: off the JS thread AND off
		// the main/UI thread, at background QoS, and — unlike Expo's default (a process-wide shared
		// SERIAL "expo.modules.AsyncFunctionQueue") — parallel across concurrent invocations, so a
		// bulk upload's staged transplants run simultaneously instead of queuing behind one another
		// (or behind other modules' async calls).
		AsyncFunction("transplantMetadata") { (sourceUri: String, targetUri: String) -> Bool in
			return FilenExifModule.transplant(sourceUri: sourceUri, targetUri: targetUri)
		}
		.runOnQueue(DispatchQueue.global(qos: .utility))
	}

	private static func fileURL(from uri: String) -> URL? {
		if let url = URL(string: uri), url.isFileURL {
			return url
		}

		if uri.hasPrefix("/") {
			return URL(fileURLWithPath: uri)
		}

		return URL(string: uri)
	}

	// Reads an integer image property (e.g. PixelWidth/Height) from a CGImageSource's properties.
	private static func intProperty(_ source: CGImageSource, _ key: CFString) -> Int? {
		guard let props = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any] else {
			return nil
		}

		return (props[key] as? NSNumber)?.intValue
	}

	private static func transplant(sourceUri: String, targetUri: String) -> Bool {
		guard let sourceURL = fileURL(from: sourceUri), let targetURL = fileURL(from: targetUri) else {
			return false
		}

		// Read the source's full metadata (EXIF + XMP unified) WITHOUT decoding pixels. Use the
		// PRIMARY image index (not a hardcoded 0) so a multi-image container — e.g. a .heics burst —
		// yields the displayed image's metadata.
		guard let source = CGImageSourceCreateWithURL(sourceURL as CFURL, nil) else {
			return false
		}

		let primaryIndex = CGImageSourceGetPrimaryImageIndex(source)

		guard let metadata = CGImageSourceCopyMetadataAtIndex(source, primaryIndex, nil),
			let mutableMetadata = CGImageMetadataCreateMutableCopy(metadata) else {
			return false
		}

		// The re-encoded pixels are already upright — force orientation to 1 so a carried-over
		// non-1 value can't double-rotate the image in other viewers. If the set FAILS, bail (return
		// false → the caller keeps the plain, correctly-displayed file rather than a possibly-sideways
		// one).
		guard CGImageMetadataSetValueMatchingImageProperty(
			mutableMetadata,
			kCGImagePropertyTIFFDictionary,
			kCGImagePropertyTIFFOrientation,
			NSNumber(value: 1)
		) else {
			return false
		}

		// Open the target JPEG as a source; its type drives the (matching) destination type so
		// the copy stays lossless.
		guard let targetSource = CGImageSourceCreateWithURL(targetURL as CFURL, nil),
			let targetType = CGImageSourceGetType(targetSource) else {
			return false
		}

		// Correct the size-bearing EXIF tags to the TARGET's real dimensions — the copied metadata
		// carries the SOURCE's, which are stale (and W/H-swapped for a rotated source baked upright).
		if let width = intProperty(targetSource, kCGImagePropertyPixelWidth),
			let height = intProperty(targetSource, kCGImagePropertyPixelHeight) {
			CGImageMetadataSetValueMatchingImageProperty(
				mutableMetadata, kCGImagePropertyExifDictionary, kCGImagePropertyExifPixelXDimension, NSNumber(value: width)
			)
			CGImageMetadataSetValueMatchingImageProperty(
				mutableMetadata, kCGImagePropertyExifDictionary, kCGImagePropertyExifPixelYDimension, NSNumber(value: height)
			)
		}

		// Write to a sibling temp, then atomically replace the target — a torn write can never
		// leave a half-written JPEG in place.
		let tempURL = targetURL.deletingLastPathComponent()
			.appendingPathComponent("exif-\(UUID().uuidString).tmp")

		guard let destination = CGImageDestinationCreateWithURL(tempURL as CFURL, targetType, 1, nil) else {
			return false
		}

		let options: [CFString: Any] = [kCGImageDestinationMetadata: mutableMetadata]
		var error: Unmanaged<CFError>?
		let copied = CGImageDestinationCopyImageSource(destination, targetSource, options as CFDictionary, &error)

		guard copied else {
			// The error is returned retained (CF Create Rule); consume it and surface why the copy
			// failed ("Not all image formats are supported for this operation" is a real class).
			if let cfError = error?.takeRetainedValue() {
				NSLog("[FilenExif] CGImageDestinationCopyImageSource failed: %@", cfError.localizedDescription)
			}

			try? FileManager.default.removeItem(at: tempURL)

			return false
		}

		do {
			_ = try FileManager.default.replaceItemAt(targetURL, withItemAt: tempURL)
			return true
		} catch {
			try? FileManager.default.removeItem(at: tempURL)
			return false
		}
	}
}
