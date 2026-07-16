package io.filen.exif

import android.net.Uri
import android.util.Log
import androidx.exifinterface.media.ExifInterface
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.util.UUID

/**
 * Native EXIF/XMP transplant for the re-encode paths (HEIC→JPG conversion, camera-upload
 * compression). Copies the standard EXIF tag set + the XMP packet from the SOURCE image into
 * the already-re-encoded TARGET JPEG without decoding or re-encoding pixels:
 *
 *   ExifInterface(source).getAttribute(tag)  →  ExifInterface(temp).setAttribute(tag, …)
 *   ExifInterface(temp).saveAttributes()     // rewrites the JPEG's APP1, streams pixel data
 *   Files.move(temp, target, ATOMIC_MOVE)    // atomic replace — a torn write never reaches target
 *
 * `saveAttributes()` rewrites only the metadata segment and streams the image data through, so
 * it never allocates the bitmap or re-compresses the pixels. It is NOT atomic on its own (it
 * truncates the file in place), so we run it against a temp COPY and atomically move the result
 * over the target — a mid-write failure only ever touches the disposable temp, so the target is
 * always the valid plain re-encoded file. Orientation is forced to NORMAL because the re-encode
 * already baked rotation into the pixels.
 *
 * Scope note: this deliberately carries the STANDARD tag set + XMP, not proprietary MakerNote /
 * private IFD binary — a product decision for the (already lossy) compress/convert paths. The
 * bit-exact path is "leave those options off": then the original uploads untouched. One API
 * ceiling to be aware of: androidx ExifInterface's get/setAttribute string surface is US-ASCII,
 * so NON-ASCII text (an accented Artist/Copyright/caption, or Unicode in the XMP packet) is
 * degraded to '?' — inherent to the platform API, not this module. Camera-written EXIF is ASCII
 * in practice; it only bites user-authored text fields.
 *
 * Every failure returns `false` (never throws to JS) and leaves the target untouched, so a
 * transplant can never break or corrupt an upload.
 */
class FilenExifModule : Module() {
	override fun definition() = ModuleDefinition {
		Name("FilenExif")

		// Coroutine + Dispatchers.IO: runs off the main/JS thread on the I/O dispatcher (sized
		// for blocking file work and concurrent), so a bulk upload's staged transplants run in
		// parallel and never block the UI.
		AsyncFunction("transplantMetadata") Coroutine { sourceUri: String, targetUri: String ->
			withContext(Dispatchers.IO) {
				transplant(sourceUri, targetUri)
			}
		}
	}

	private fun transplant(sourceUri: String, targetUri: String): Boolean {
		val sourcePath = pathFromUri(sourceUri) ?: return false
		val targetPath = pathFromUri(targetUri) ?: return false

		if (!File(sourcePath).exists() || !File(targetPath).exists()) {
			return false
		}

		val source =
			try {
				ExifInterface(sourcePath)
			} catch (e: Exception) {
				Log.w(TAG, "source read failed: ${e.message}")

				return false
			}

		// First attempt carries the standard tags + XMP. A JPEG APP1 caps at ~64 KB, and a HEIC
		// source's XMP item has no such limit — an oversized XMP makes saveAttributes throw, which
		// would otherwise drop EVERYTHING (dates/GPS included). Retry once WITHOUT XMP so at least
		// the standard tags survive that case.
		return try {
			writeToTargetAtomic(source, targetPath, includeXmp = true)
		} catch (e: Exception) {
			Log.w(TAG, "transplant with XMP failed, retrying without XMP: ${e.message}")

			try {
				writeToTargetAtomic(source, targetPath, includeXmp = false)
			} catch (e2: Exception) {
				Log.w(TAG, "transplant retry without XMP failed: ${e2.message}")

				false
			}
		}
	}

	// Applies the source's metadata to a temp COPY of the target, then atomically moves it over
	// the target. Returns false (no move) when there is nothing to copy; PROPAGATES a save/move
	// exception so the caller can retry without XMP. The target is only ever replaced by an atomic
	// move of a fully-written temp, so it is never left torn.
	private fun writeToTargetAtomic(
		source: ExifInterface,
		targetPath: String,
		includeXmp: Boolean,
	): Boolean {
		val targetFile = File(targetPath)
		val tempFile = File(targetFile.parentFile, "exif-${UUID.randomUUID()}.tmp")

		try {
			targetFile.copyTo(tempFile, overwrite = true)

			val temp = ExifInterface(tempFile.absolutePath)
			var copiedAny = false

			for (tag in COPYABLE_TAGS) {
				val value = source.getAttribute(tag) ?: continue

				if (value.isEmpty()) {
					continue
				}

				temp.setAttribute(tag, value)
				copiedAny = true
			}

			if (includeXmp) {
				// Best-effort: a failure READING/SETTING XMP must not drop the standard-tag copy.
				// (An oversized XMP throws later at saveAttributes, which the caller retries without.)
				try {
					source.getAttribute(ExifInterface.TAG_XMP)?.let {
						if (it.isNotEmpty()) {
							// Neutralize any tiff:Orientation inside the XMP so it agrees with the
							// forced EXIF orientation=1 (the re-encoded pixels are upright). Without
							// this, an XMP-first reader could re-rotate; iOS's unified metadata is
							// already coherent.
							temp.setAttribute(ExifInterface.TAG_XMP, neutralizeXmpOrientation(it))
							copiedAny = true
						}
					}
				} catch (_: Exception) {
				}
			}

			if (!copiedAny) {
				tempFile.delete()

				return false
			}

			// The re-encoded pixels are already upright — pin orientation to NORMAL so a
			// carried-over value can't double-rotate the image in other viewers.
			temp.setAttribute(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL.toString())

			temp.saveAttributes()

			// Atomic replace (rename(2) on the same filesystem): a reader sees either the old or the
			// new file, never a torn one, even on process death mid-move.
			Files.move(tempFile.toPath(), targetFile.toPath(), StandardCopyOption.ATOMIC_MOVE)

			return true
		} catch (e: Exception) {
			try {
				tempFile.delete()
			} catch (_: Exception) {
			}

			throw e
		}
	}

	// Resets any XMP tiff:Orientation value (a single digit 2-8) to 1, length-preserving so the
	// XMP packet stays byte-valid. Covers both the attribute (tiff:Orientation="6") and element
	// (<tiff:Orientation>6</tiff:Orientation>) forms; an already-1 or absent tag is left as-is.
	private fun neutralizeXmpOrientation(xmp: String): String {
		return xmp.replace(Regex("(tiff:Orientation\\s*[=>\"'\\s]{1,6})[2-8]")) { "${it.groupValues[1]}1" }
	}

	private fun pathFromUri(uri: String): String? {
		return try {
			// Callers only ever pass file:// URIs; a content:// would yield a non-file path that
			// the exists() check then rejects.
			Uri.parse(uri).path ?: uri.takeIf { it.startsWith("/") }
		} catch (e: Exception) {
			null
		}
	}

	companion object {
		private const val TAG = "FilenExif"

		// The standard EXIF tag set worth carrying across a re-encode — dates, GPS, camera/lens,
		// exposure. Orientation is deliberately EXCLUDED (forced to NORMAL after the copy). Values
		// are copied as their raw ExifInterface string form, so GPS rationals / timestamps round
		// trip verbatim (no lossy decimal conversion).
		private val COPYABLE_TAGS =
			listOf(
				// Timestamps
				ExifInterface.TAG_DATETIME,
				ExifInterface.TAG_DATETIME_ORIGINAL,
				ExifInterface.TAG_DATETIME_DIGITIZED,
				ExifInterface.TAG_OFFSET_TIME,
				ExifInterface.TAG_OFFSET_TIME_ORIGINAL,
				ExifInterface.TAG_OFFSET_TIME_DIGITIZED,
				ExifInterface.TAG_SUBSEC_TIME,
				ExifInterface.TAG_SUBSEC_TIME_ORIGINAL,
				ExifInterface.TAG_SUBSEC_TIME_DIGITIZED,
				// GPS
				ExifInterface.TAG_GPS_VERSION_ID,
				ExifInterface.TAG_GPS_LATITUDE,
				ExifInterface.TAG_GPS_LATITUDE_REF,
				ExifInterface.TAG_GPS_LONGITUDE,
				ExifInterface.TAG_GPS_LONGITUDE_REF,
				ExifInterface.TAG_GPS_ALTITUDE,
				ExifInterface.TAG_GPS_ALTITUDE_REF,
				ExifInterface.TAG_GPS_TIMESTAMP,
				ExifInterface.TAG_GPS_DATESTAMP,
				ExifInterface.TAG_GPS_SPEED,
				ExifInterface.TAG_GPS_SPEED_REF,
				ExifInterface.TAG_GPS_TRACK,
				ExifInterface.TAG_GPS_TRACK_REF,
				ExifInterface.TAG_GPS_IMG_DIRECTION,
				ExifInterface.TAG_GPS_IMG_DIRECTION_REF,
				ExifInterface.TAG_GPS_DEST_BEARING,
				ExifInterface.TAG_GPS_DEST_BEARING_REF,
				ExifInterface.TAG_GPS_MAP_DATUM,
				ExifInterface.TAG_GPS_PROCESSING_METHOD,
				ExifInterface.TAG_GPS_DOP,
				ExifInterface.TAG_GPS_H_POSITIONING_ERROR,
				// Camera / authorship
				ExifInterface.TAG_MAKE,
				ExifInterface.TAG_MODEL,
				ExifInterface.TAG_SOFTWARE,
				ExifInterface.TAG_ARTIST,
				ExifInterface.TAG_COPYRIGHT,
				ExifInterface.TAG_IMAGE_DESCRIPTION,
				ExifInterface.TAG_USER_COMMENT,
				ExifInterface.TAG_IMAGE_UNIQUE_ID,
				// Lens
				ExifInterface.TAG_LENS_MAKE,
				ExifInterface.TAG_LENS_MODEL,
				ExifInterface.TAG_LENS_SPECIFICATION,
				ExifInterface.TAG_LENS_SERIAL_NUMBER,
				// Exposure
				ExifInterface.TAG_EXPOSURE_TIME,
				ExifInterface.TAG_F_NUMBER,
				ExifInterface.TAG_EXPOSURE_PROGRAM,
				ExifInterface.TAG_PHOTOGRAPHIC_SENSITIVITY,
				ExifInterface.TAG_ISO_SPEED,
				ExifInterface.TAG_SHUTTER_SPEED_VALUE,
				ExifInterface.TAG_APERTURE_VALUE,
				ExifInterface.TAG_BRIGHTNESS_VALUE,
				ExifInterface.TAG_EXPOSURE_BIAS_VALUE,
				ExifInterface.TAG_MAX_APERTURE_VALUE,
				ExifInterface.TAG_METERING_MODE,
				ExifInterface.TAG_LIGHT_SOURCE,
				ExifInterface.TAG_FLASH,
				ExifInterface.TAG_FOCAL_LENGTH,
				ExifInterface.TAG_FOCAL_LENGTH_IN_35MM_FILM,
				ExifInterface.TAG_EXPOSURE_MODE,
				ExifInterface.TAG_WHITE_BALANCE,
				ExifInterface.TAG_DIGITAL_ZOOM_RATIO,
				ExifInterface.TAG_SCENE_CAPTURE_TYPE,
				ExifInterface.TAG_CONTRAST,
				ExifInterface.TAG_SATURATION,
				ExifInterface.TAG_SHARPNESS,
				ExifInterface.TAG_SENSING_METHOD,
				ExifInterface.TAG_COLOR_SPACE,
				ExifInterface.TAG_EXIF_VERSION
			)
	}
}
