//! filen-drag.node: drive items dragged out of the Filen window become virtual files for Explorer.
//!
//! `begin` builds a data object offering `FileGroupDescriptorW` (every entry, prebuilt) and `FileContents` (one stream
//! per file). The object lives on an addon-owned MTA thread ([`mta`]) and is marshalled to the main (STA) thread for
//! `DoDragDrop`, so Explorer's calls never need the main thread, which stays blocked in `DoDragDrop` until the drop and
//! then runs JS. Explorer extracts asynchronously (`IDataObjectAsyncCapability`): each `FileContents` request hands out
//! a stream at once and asks JS for that entry's temp file through a non-blocking threadsafe function; the stream's
//! reads wait for the file in bounded steps ([`slot`]). Nothing here needs JS before `DoDragDrop` returns.
//!
//! Unsafe code is allowed only in the COM modules (`mta`, `data_object`, `stream`, `source`); every block says why it
//! is sound. Node-API symbols live only in `napi_api`, which test builds leave out, so `cargo test` links without Node.

#![deny(unsafe_code)]
#![deny(unsafe_op_in_unsafe_fn)]
#![deny(clippy::undocumented_unsafe_blocks)]
#![warn(clippy::pedantic)]

pub mod descriptor;
pub mod slot;

// inline_always, ref_as_ptr: in the expansion of windows-core's `#[implement]`, not in code written here.
#[cfg(windows)]
#[allow(unsafe_code, clippy::inline_always, clippy::ref_as_ptr)]
mod data_object;
#[cfg(windows)]
#[allow(unsafe_code)]
mod mta;
#[cfg(all(windows, not(test)))]
mod napi_api;
// Test builds leave out napi_api, the only caller of `drag`.
#[cfg(windows)]
#[allow(unsafe_code, clippy::inline_always, clippy::ref_as_ptr)]
#[cfg_attr(test, allow(dead_code))]
mod source;
#[cfg(windows)]
#[allow(unsafe_code, clippy::inline_always, clippy::ref_as_ptr)]
mod stream;

/// What the data object reports to JS. Calls come from COM threads and must not block.
pub trait Events: Send + Sync {
    /// Explorer opened a stream for entry `index` under `ticket`; false when the call could not be queued.
    fn contents(&self, ticket: u32, index: u32) -> bool;
    /// Every stream of `ticket` was released.
    fn release(&self, ticket: u32);
    /// Explorer's async extraction ended (`EndOperation`), or the object went away without one after it started.
    fn operation_end(&self, result: OperationResult);
}

/// How Explorer's extraction ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OperationResult {
    Ok,
    /// `E_ABORT`: the user cancelled Explorer's copy.
    Aborted,
    Failed,
}

impl OperationResult {
    /// From `EndOperation`'s `HRESULT`: success, `E_ABORT`, anything else.
    #[must_use]
    pub fn from_hresult(succeeded: bool, abort: bool) -> Self {
        if succeeded {
            Self::Ok
        } else if abort {
            Self::Aborted
        } else {
            Self::Failed
        }
    }

    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ok => "ok",
            Self::Aborted => "aborted",
            Self::Failed => "failed",
        }
    }
}

/// What `DoDragDrop` returned.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DragReturn {
    Drop,
    Cancel,
    Error,
}

/// `begin`'s answer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DragOutcome {
    Dropped,
    Cancelled,
    /// A drop the target did not extract asynchronously (a sync-only target, refused), or `DoDragDrop` failed.
    Failed,
}

impl DragOutcome {
    /// `started`: the target called `StartOperation` (what `InOperation` answers right after the drop). The drop
    /// effect `DoDragDrop` reports is not used: targets set it inconsistently.
    #[must_use]
    pub fn of(returned: DragReturn, started: bool) -> Self {
        match returned {
            DragReturn::Drop if started => Self::Dropped,
            DragReturn::Cancel => Self::Cancelled,
            DragReturn::Drop | DragReturn::Error => Self::Failed,
        }
    }

    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Dropped => "dropped",
            Self::Cancelled => "cancelled",
            Self::Failed => "failed",
        }
    }
}

/// The drag image's largest side in pixels (the page's chip is at most 640 × 160 CSS px at scale 3).
pub const MAX_IMAGE_SIDE: u32 = 4096;

/// A premultiplied BGRA image of `width` × `height` pixels is exactly `len` bytes and within [`MAX_IMAGE_SIDE`].
#[must_use]
pub fn image_fits(len: usize, width: u32, height: u32) -> bool {
    (1..=MAX_IMAGE_SIDE).contains(&width)
        && (1..=MAX_IMAGE_SIDE).contains(&height)
        && u64::from(width) * u64::from(height) * 4 == len as u64
}

/// `BrowserWindow.getNativeWindowHandle()`'s bytes as an HWND: exactly 8 bytes, not zero.
#[must_use]
pub fn window_handle(bytes: &[u8]) -> Option<u64> {
    let handle = u64::from_le_bytes(bytes.try_into().ok()?);

    (handle != 0).then_some(handle)
}

#[cfg(test)]
mod tests {
    use super::{
        DragOutcome, DragReturn, MAX_IMAGE_SIDE, OperationResult, image_fits, window_handle,
    };

    #[test]
    fn a_window_handle_is_eight_non_zero_bytes() {
        assert_eq!(window_handle(&[1, 0, 0, 0, 0, 0, 0, 0]), Some(1));
        assert_eq!(window_handle(&[0; 8]), None);
        assert_eq!(window_handle(&[1, 0, 0, 0]), None);
        assert_eq!(window_handle(&[1; 9]), None);
    }

    #[test]
    fn an_image_must_match_its_size() {
        assert!(image_fits(2 * 3 * 4, 2, 3));
        assert!(!image_fits(2 * 3 * 4 - 1, 2, 3));
        assert!(!image_fits(0, 0, 0));
        assert!(!image_fits(4, 1, 0));
        let side = MAX_IMAGE_SIDE + 1;
        assert!(!image_fits((side * 4) as usize, side, 1));
    }

    #[test]
    fn a_drop_counts_only_with_an_async_operation() {
        assert_eq!(
            DragOutcome::of(DragReturn::Drop, true),
            DragOutcome::Dropped
        );
        assert_eq!(
            DragOutcome::of(DragReturn::Drop, false),
            DragOutcome::Failed
        );
        assert_eq!(
            DragOutcome::of(DragReturn::Cancel, false),
            DragOutcome::Cancelled
        );
        assert_eq!(
            DragOutcome::of(DragReturn::Cancel, true),
            DragOutcome::Cancelled
        );
        assert_eq!(
            DragOutcome::of(DragReturn::Error, true),
            DragOutcome::Failed
        );
        assert_eq!(DragOutcome::Dropped.as_str(), "dropped");
    }

    #[test]
    fn end_operation_results_name_success_abort_and_failure() {
        assert_eq!(
            OperationResult::from_hresult(true, false),
            OperationResult::Ok
        );
        assert_eq!(
            OperationResult::from_hresult(false, true),
            OperationResult::Aborted
        );
        assert_eq!(
            OperationResult::from_hresult(false, false),
            OperationResult::Failed
        );
        assert_eq!(OperationResult::Aborted.as_str(), "aborted");
    }
}
