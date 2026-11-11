//! The drag itself, on the main (STA) thread: the data object is created in the addon's MTA and reached through a
//! proxy, the drag image goes onto it through the shell's drag-drop helper, and `DoDragDrop` runs with a drop source
//! that refuses drops onto any of this process's windows.

use std::ffi::c_void;
use std::sync::atomic::{AtomicBool, Ordering};

use windows::Win32::Foundation::{
    COLORREF, DRAGDROP_S_CANCEL, DRAGDROP_S_DROP, DRAGDROP_S_USEDEFAULTCURSORS, HWND, POINT, S_OK,
    SIZE,
};
use windows::Win32::Graphics::Gdi::{
    BI_RGB, BITMAPINFO, BITMAPINFOHEADER, CreateDIBSection, DIB_RGB_COLORS, DeleteObject,
};
use windows::Win32::System::Com::{CLSCTX_INPROC_SERVER, CoCreateInstance, IDataObject};
use windows::Win32::System::Ole::{
    DROPEFFECT, DROPEFFECT_COPY, DoDragDrop, IDropSource, IDropSource_Impl, OleInitialize,
    OleUninitialize,
};
use windows::Win32::System::SystemServices::{MK_LBUTTON, MODIFIERKEYS_FLAGS};
use windows::Win32::System::Threading::GetCurrentProcessId;
use windows::Win32::UI::Shell::{CLSID_DragDropHelper, IDragSourceHelper, SHDRAGIMAGE};
use windows::Win32::UI::WindowsAndMessaging::{
    GA_ROOT, GetAncestor, GetCursorPos, GetWindowThreadProcessId, WindowFromPoint,
};
use windows_core::{BOOL, HRESULT, implement};

use crate::data_object::{DataObject, Session};
use crate::descriptor::{self, Entry};
use crate::slot::Registry;
use crate::{DragOutcome, DragReturn, Events, image_fits, mta};

/// A premultiplied BGRA bitmap, top row first.
pub(crate) struct Image<'a> {
    pub(crate) bgra: &'a [u8],
    pub(crate) width: u32,
    pub(crate) height: u32,
}

// One OS drag at a time: DoDragDrop's modal loop pumps messages, so a second begin cannot be ruled out otherwise.
static RUNNING: AtomicBool = AtomicBool::new(false);

struct Running;

impl Running {
    fn claim() -> Option<Self> {
        (!RUNNING.swap(true, Ordering::SeqCst)).then_some(Self)
    }
}

impl Drop for Running {
    fn drop(&mut self) {
        RUNNING.store(false, Ordering::SeqCst);
    }
}

fn process_of(window: HWND) -> u32 {
    let mut process = 0u32;
    // SAFETY: any handle value is accepted; an invalid one leaves `process` 0.
    unsafe { GetWindowThreadProcessId(window, Some(&raw mut process)) };
    process
}

// Whether the cursor is over a top-level window of this process (any of them, not only the drag's).
fn over_own_window() -> bool {
    let mut point = POINT::default();

    // SAFETY: writes the cursor position into `point`.
    if unsafe { GetCursorPos(&raw mut point) }.is_err() {
        return false;
    }

    // SAFETY: plain window queries; a null result is checked.
    let window = unsafe { WindowFromPoint(point) };
    if window.is_invalid() {
        return false;
    }

    // SAFETY: as above.
    let root = unsafe { GetAncestor(window, GA_ROOT) };
    // SAFETY: no arguments.
    process_of(root) == unsafe { GetCurrentProcessId() }
}

#[implement(IDropSource)]
struct DropSource;

impl IDropSource_Impl for DropSource_Impl {
    fn QueryContinueDrag(&self, escape: BOOL, keys: MODIFIERKEYS_FLAGS) -> HRESULT {
        if escape.as_bool() {
            return DRAGDROP_S_CANCEL;
        }

        if keys.0 & MK_LBUTTON.0 != 0 {
            return S_OK;
        }

        // Released over our own window: in-app drops are the page's, never a copy of the drag.
        if over_own_window() {
            DRAGDROP_S_CANCEL
        } else {
            DRAGDROP_S_DROP
        }
    }

    fn GiveFeedback(&self, _effect: DROPEFFECT) -> HRESULT {
        DRAGDROP_S_USEDEFAULTCURSORS
    }
}

// Best effort: without an image the drag still runs, with the system's default.
fn set_image(proxy: &IDataObject, image: &Image<'_>) {
    // SAFETY: creates the shell's in-process helper on this (STA) thread.
    let Ok(helper) = (unsafe {
        CoCreateInstance::<_, IDragSourceHelper>(&CLSID_DragDropHelper, None, CLSCTX_INPROC_SERVER)
    }) else {
        return;
    };
    // `image_fits` bounds both sides to 4096.
    let (Ok(width), Ok(height)) = (i32::try_from(image.width), i32::try_from(image.height)) else {
        return;
    };
    let info = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: u32::try_from(size_of::<BITMAPINFOHEADER>()).unwrap_or(40),
            biWidth: width,
            // Negative: top-down rows, as nativeImage.toBitmap() lays them out.
            biHeight: -height,
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            ..BITMAPINFOHEADER::default()
        },
        ..BITMAPINFO::default()
    };
    let mut bits: *mut c_void = std::ptr::null_mut();

    // SAFETY: `info` describes a 32-bit top-down DIB; `bits` receives its pixel memory.
    let Ok(bitmap) = (unsafe {
        CreateDIBSection(
            None,
            &raw const info,
            DIB_RGB_COLORS,
            &raw mut bits,
            None,
            0,
        )
    }) else {
        return;
    };

    if bits.is_null() {
        // SAFETY: the bitmap was created above and is owned here.
        let _ = unsafe { DeleteObject(bitmap.into()) };
        return;
    }

    // SAFETY: the DIB's memory is width × height × 4 bytes, exactly `image.bgra.len()` (checked by image_fits).
    unsafe {
        std::ptr::copy_nonoverlapping(image.bgra.as_ptr(), bits.cast::<u8>(), image.bgra.len());
    }
    let drag_image = SHDRAGIMAGE {
        sizeDragImage: SIZE {
            cx: width,
            cy: height,
        },
        ptOffset: POINT {
            x: width / 2,
            y: height / 2,
        },
        hbmpDragImage: bitmap,
        // CLR_NONE: the alpha channel, not a colour key, makes the image's transparency.
        crColorKey: COLORREF(0xFFFF_FFFF),
    };

    // SAFETY: on success the helper owns the bitmap; on failure it stays ours and is deleted.
    if unsafe { helper.InitializeFromBitmap(&raw const drag_image, proxy) }.is_err() {
        // SAFETY: as above.
        let _ = unsafe { DeleteObject(bitmap.into()) };
    }
}

/// Runs the OS drag of `entries` from `window` (one of this process's) and blocks until the drop or cancel.
///
/// # Errors
/// Invalid entries, image or window, another drag running, or COM refusing to set the drag up.
pub(crate) fn drag(
    registry: &'static Registry,
    window: u64,
    entries: Vec<Entry>,
    image: &Image<'_>,
    events: Box<dyn Events>,
) -> Result<DragOutcome, String> {
    if !image_fits(image.bgra.len(), image.width, image.height) {
        return Err("the image is not width × height × 4 bytes of at most 4096 × 4096".to_owned());
    }

    let window = HWND(usize::try_from(window).map_err(|error| error.to_string())? as *mut c_void);
    // SAFETY: no arguments.
    if process_of(window) != unsafe { GetCurrentProcessId() } {
        return Err("the window is not one of this process".to_owned());
    }

    let descriptor = descriptor::build(&entries).map_err(|error| error.to_string())?;
    let _running = Running::claim().ok_or_else(|| "a drag is already running".to_owned())?;
    let session = Session::new(registry, entries, descriptor, events)?;
    let object_session = session.clone();
    let proxy = mta::marshal(move || DataObject::new(object_session).into())?;

    // Electron's main thread is already an OLE STA; this only adds a reference, balanced below.
    // SAFETY: called on the thread that runs DoDragDrop.
    unsafe { OleInitialize(None) }.map_err(|error| format!("OleInitialize failed: {error}"))?;
    set_image(&proxy, image);

    let source: IDropSource = DropSource.into();
    let mut effect = DROPEFFECT(0);
    // SAFETY: both interfaces live for the call; `effect` outlives it.
    let returned = unsafe { DoDragDrop(&proxy, &source, DROPEFFECT_COPY, &raw mut effect) };
    let outcome = DragOutcome::of(
        if returned == DRAGDROP_S_DROP {
            DragReturn::Drop
        } else if returned == DRAGDROP_S_CANCEL {
            DragReturn::Cancel
        } else {
            DragReturn::Error
        },
        session.started(),
    );

    drop(proxy);
    // SAFETY: balances the OleInitialize above on the same thread.
    unsafe { OleUninitialize() };
    Ok(outcome)
}

#[cfg(test)]
mod tests {
    use windows::Win32::Foundation::{DRAGDROP_S_CANCEL, S_OK};
    use windows::Win32::System::Ole::IDropSource;
    use windows::Win32::System::SystemServices::{MK_LBUTTON, MODIFIERKEYS_FLAGS};

    use super::{DropSource, Running};

    #[test]
    fn escape_cancels_and_a_held_button_continues() {
        let source: IDropSource = DropSource.into();

        let ask = |escape, keys| {
            // SAFETY: an in-process call on a live object.
            unsafe { source.QueryContinueDrag(escape, keys) }
        };

        assert_eq!(ask(true, MK_LBUTTON), DRAGDROP_S_CANCEL);
        assert_eq!(ask(false, MK_LBUTTON), S_OK);
        assert_eq!(ask(true, MODIFIERKEYS_FLAGS(0)), DRAGDROP_S_CANCEL);
    }

    #[test]
    fn one_drag_at_a_time() {
        let first = Running::claim().expect("free");

        assert!(Running::claim().is_none());
        drop(first);
        assert!(Running::claim().is_some());
    }
}
