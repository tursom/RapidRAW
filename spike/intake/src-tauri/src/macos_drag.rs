//! Experimental, main-HTML5-WebView-only drag observation. Apple target type
//! checking passes; native Mac build and runtime verification are pending.
//! Never treat diagnostic `nativePaths` as a
//! resolved import: only a one-shot `status: "paired"` reply's root `paths`
//! authorizes paths.
//!
//! Only the pinned app-owned Wry class's method slots are wrapped. Object isa,
//! public -class and Cocoa's KVO classes/metadata are never modified. Normal
//! dispatch reaches us through KVO; we call the saved Wry-level IMP once,
//! preserving its own super dispatch. Untracked instances only pass through.
use std::{
    cell::RefCell,
    collections::HashMap,
    ffi::{CStr, CString},
    panic::{AssertUnwindSafe, catch_unwind},
    sync::{
        OnceLock,
        atomic::{AtomicU64, Ordering},
    },
    time::Instant,
};

use block2::RcBlock;
use objc2::{
    ClassType, MainThreadMarker, msg_send,
    runtime::{AnyClass, AnyObject, Bool, Imp, Method, MethodImplementation, ProtocolObject, Sel},
    sel,
};
use objc2_app_kit::{
    NSDragOperation, NSDraggingInfo, NSPasteboardTypeURL, NSPasteboardURLReadingFileURLsOnlyKey,
};
use objc2_foundation::{NSArray, NSDictionary, NSError, NSNumber, NSString, NSURL};
use objc2_web_kit::WKWebView;
use rapidraw_intake_spike::drop_capture::{CaptureState, Reply};
use serde_json::{Value, json};
use tauri::{Emitter, Manager, WebviewWindow};

const EVENT: &str = "spike-macos-drop";
const DOCUMENT_KEY: &str = "__rapidrawIntakeNativeDocumentToken";
const MAX_ITEMS: usize = 1024;
const MAX_TYPES: usize = 128;
static NEXT_GENERATION: AtomicU64 = AtomicU64::new(1);
static NEXT_DOCUMENT: AtomicU64 = AtomicU64::new(1);
type DragOperationImp = unsafe extern "C-unwind" fn(
    &AnyObject,
    Sel,
    &ProtocolObject<dyn NSDraggingInfo>,
) -> NSDragOperation;
type DragBoolImp =
    unsafe extern "C-unwind" fn(&AnyObject, Sel, &ProtocolObject<dyn NSDraggingInfo>) -> Bool;
type DragVoidImp =
    unsafe extern "C-unwind" fn(&AnyObject, Sel, &ProtocolObject<dyn NSDraggingInfo>);
type DragExitImp =
    unsafe extern "C-unwind" fn(&AnyObject, Sel, Option<&ProtocolObject<dyn NSDraggingInfo>>);
type DeallocImp = unsafe extern "C-unwind" fn(&AnyObject, Sel);

struct OriginalImps {
    entered: DragOperationImp,
    perform: DragBoolImp,
    exited: DragExitImp,
    ended: Option<DragVoidImp>,
    prepare: Option<DragBoolImp>,
    dealloc: DeallocImp,
}

// Immutable process-lifetime IMPs, published before any method is replaced.
// No view retained, no lock or thread-local borrow is held across forwarding.
static ORIGINAL_IMPS: OnceLock<OriginalImps> = OnceLock::new();
// Cache failures too: a partial installation must never wrap our wrappers.
static HOOK_INSTALL: OnceLock<Result<(), String>> = OnceLock::new();

struct Instance {
    generation: u64,
    next_drop: u64,
    command_epoch: u64,
    active_drag: Option<i64>,
    clock: Instant,
    capture: CaptureState,
    sink: tauri::AppHandle,
}

thread_local! {
    // No Objective-C object is retained here; destruction can reach dealloc.
    static INSTANCES: RefCell<HashMap<usize, Instance>> = RefCell::new(HashMap::new());
}

fn key(this: &AnyObject) -> usize {
    this as *const AnyObject as usize
}

fn now(instance: &Instance) -> u64 {
    instance.clock.elapsed().as_millis().min(u64::MAX as u128) as u64
}

fn with_instance<T>(address: usize, f: impl FnOnce(&mut Instance) -> T) -> Option<T> {
    INSTANCES
        .try_with(|instances| {
            let mut instances = instances.try_borrow_mut().ok()?;
            instances.get_mut(&address).map(f)
        })
        .ok()
        .flatten()
}

// Observation failures must not skip or duplicate the original method call.
// Observation exceptions become diagnostics. The outer boundary rethrows an
// original Cocoa exception unchanged; it must not pass a foreign exception to
// Rust's catch_unwind. Rust panics abort instead of crossing Cocoa or inventing
// an NSDragOperation/BOOL result.
fn observation<T>(f: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    match catch_unwind(AssertUnwindSafe(|| {
        objc2::exception::catch(AssertUnwindSafe(f))
    })) {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => Err("Objective-C exception during drag observation".into()),
        Err(_) => Err("Rust panic during drag observation".into()),
    }
}

fn ffi_boundary<T>(f: impl FnOnce() -> T) -> T {
    match catch_unwind(AssertUnwindSafe(|| {
        objc2::exception::catch(AssertUnwindSafe(f))
    })) {
        Ok(Ok(value)) => value,
        Ok(Err(Some(exception))) => objc2::exception::throw(exception),
        // Preserve the unusual Objective-C `@throw nil` case too.
        Ok(Err(None)) => unsafe { objc2::ffi::objc_exception_throw(std::ptr::null_mut()) },
        Err(_) => std::process::abort(),
    }
}

fn original_imps() -> &'static OriginalImps {
    ORIGINAL_IMPS.get().unwrap_or_else(|| std::process::abort())
}

fn tracked(this: &AnyObject) -> bool {
    // Other Wry instances/threads get no observation or pasteboard access.
    MainThreadMarker::new().is_some()
        && INSTANCES
            .try_with(|instances| {
                instances
                    .try_borrow()
                    .is_ok_and(|instances| instances.contains_key(&key(this)))
            })
            .unwrap_or(false)
}

fn capture_stamp(instance: &Instance) -> class_policy::CaptureStamp {
    class_policy::CaptureStamp {
        generation: instance.generation,
        command_epoch: instance.command_epoch,
        capture_id: instance.capture.active_id().map(str::to_owned),
    }
}

fn capture_is_current(address: usize, stamp: &class_policy::CaptureStamp) -> bool {
    with_instance(address, |i| capture_stamp(i) == *stamp) == Some(true)
}

fn take_instance(address: usize, generation: Option<u64>) -> Option<Instance> {
    INSTANCES
        .try_with(|instances| {
            // No Cocoa call is made while the map is borrowed. A reentrant borrow
            // here would violate that invariant; never silently leave a stale key.
            let mut instances = instances
                .try_borrow_mut()
                .unwrap_or_else(|_| std::process::abort());
            class_policy::remove_generation(&mut instances, address, generation, |i| i.generation)
        })
        .ok()
        .flatten()
}

fn retire_window(address: usize, generation: u64) {
    if let Some(mut instance) = take_instance(address, Some(generation)) {
        instance.capture.close();
        install_trace(
            "instance-retired-on-destroy",
            json!({"object": address, "generation": generation}),
        );
    }
}

fn emit(address: usize, phase: &str, mut details: Value) {
    let metadata = with_instance(address, |instance| {
        (
            instance.sink.clone(),
            instance.generation,
            instance.capture.active_id().map(str::to_owned),
        )
    });
    if let Some((sink, generation, capture_id)) = metadata {
        details["phase"] = json!(phase);
        details["generation"] = json!(generation);
        // A callback can retain its original captureId across reentrant Wry
        // dispatch. Do not overwrite that with a newly armed capture's ID.
        if details.get("captureId").is_none() {
            details["captureId"] = json!(capture_id);
        }
        if details.get("nativeDropId").is_none() {
            details["nativeDropId"] = Value::Null;
        }
        details["diagnosticOnly"] = json!(true);
        let _ = sink.emit_to("main", EVENT, details);
    }
}

fn observation_failed(address: usize, error: String) {
    let _ = observation(|| {
        with_instance(address, |i| {
            i.capture.invalidate("native-observation-failed")
        });
        emit(address, "observation-error", json!({"error": error}));
        Ok(())
    });
}

fn bounded_string(value: &NSString, limit: usize) -> Result<String, String> {
    if value.length() > limit {
        return Err("pasteboard string exceeds diagnostic limit".into());
    }
    Ok(value.to_string())
}

struct Snapshot {
    paths: Vec<String>,
    metadata: Value,
}

fn snapshot(sender: &ProtocolObject<dyn NSDraggingInfo>) -> Result<Snapshot, String> {
    // This is the sender's actual pasteboard. Never generalPasteboard(), a
    // globally named drag pasteboard, or a later lookup from an HTML callback.
    let pasteboard = sender.draggingPasteboard();
    let before = pasteboard.changeCount();
    let mut types = Vec::new();
    if let Some(all) = pasteboard.types() {
        if all.len() > MAX_TYPES {
            return Err("too many pasteboard types".into());
        }
        for value in &all {
            types.push(bounded_string(&value, 512)?);
        }
    }
    let mut items = Vec::new();
    let mut source_urls = Vec::new();
    if let Some(all) = pasteboard.pasteboardItems() {
        if all.len() > MAX_ITEMS {
            return Err("too many pasteboard items".into());
        }
        for (index, item) in all.iter().enumerate() {
            let item_types = item.types();
            if item_types.len() > MAX_TYPES {
                return Err("too many item types".into());
            }
            let mut names = Vec::new();
            for value in &item_types {
                names.push(bounded_string(&value, 512)?);
            }
            // Only URL text. No dataForType(), NSImage, file promise receiver,
            // network fetch or image decoding on the UI thread.
            if names.iter().any(|name| name == "public.url") {
                if let Some(url) = item.stringForType(unsafe { NSPasteboardTypeURL }) {
                    source_urls.push(
                        json!({"itemIndex": index, "value": bounded_string(&url, 4096)?,
                        "provenance": "draggingPasteboard/public.url"}),
                    );
                }
            }
            items.push(json!({"itemIndex": index, "types": names}));
        }
    }
    if items.is_empty() && types.iter().any(|name| name == "public.url") {
        if let Some(url) = pasteboard.stringForType(unsafe { NSPasteboardTypeURL }) {
            source_urls.push(
                json!({"itemIndex": null, "value": bounded_string(&url, 4096)?,
                "provenance": "draggingPasteboard/public.url"}),
            );
        }
    }
    let classes = NSArray::from_slice(&[NSURL::class()]);
    let yes = NSNumber::numberWithBool(true);
    let yes_object: &AnyObject = &yes;
    let options: objc2::rc::Retained<NSDictionary<NSString, AnyObject>> = NSDictionary::from_slices(
        &[unsafe { NSPasteboardURLReadingFileURLsOnlyKey }],
        &[yes_object],
    );
    // NSURL implements NSPasteboardReading. The only option is its documented
    // file-URLs-only NSNumber boolean; no promise materialization is requested.
    let urls = unsafe { pasteboard.readObjectsForClasses_options(&classes, Some(&options)) };
    let mut paths = Vec::new();
    let mut file_urls = Vec::new();
    if let Some(urls) = urls {
        if urls.len() > MAX_ITEMS {
            return Err("too many file URLs".into());
        }
        for object in &urls {
            let url = object
                .downcast_ref::<NSURL>()
                .ok_or("non-NSURL pasteboard object")?;
            if !url.isFileURL() {
                return Err("non-file URL from file-only reader".into());
            }
            let path = url.path().ok_or("file URL has no path")?;
            let path = bounded_string(&path, 32768)?;
            if !path.starts_with('/') || path.contains('\0') {
                return Err("file URL path is not an absolute filesystem path".into());
            }
            let absolute = url.absoluteString().ok_or("file URL has no absolute URL")?;
            file_urls.push(bounded_string(&absolute, 65536)?);
            paths.push(path);
        }
    }
    let after = pasteboard.changeCount();
    if before != after {
        return Err("drag pasteboard changed during metadata read".into());
    }
    Ok(Snapshot {
        paths,
        metadata: json!({
            "types": types, "items": items, "fileUrls": file_urls,
            "sourceUrlCandidates": source_urls, "changeCountBefore": before,
            "changeCountAfter": after, "imagePayloadRead": false,
            "fileListCorrespondence": "native-list-only-no-html-item-pairing"
        }),
    })
}

unsafe extern "C-unwind" fn entered(
    this: &AnyObject,
    cmd: Sel,
    sender: &ProtocolObject<dyn NSDraggingInfo>,
) -> NSDragOperation {
    ffi_boundary(|| {
        class_policy::forward(
            tracked(this),
            || {
                let address = key(this);
                let result = observation(|| {
                    let sequence = sender.draggingSequenceNumber() as i64;
                    let internal = sender.draggingSource().is_some();
                    with_instance(address, |i| {
                        i.active_drag = Some(sequence);
                        i.capture.enter(sequence, internal, now(i));
                    });
                    emit(
                        address,
                        "enter",
                        json!({"sequence": sequence, "internalDrag": internal}),
                    );
                    Ok(())
                });
                if let Err(error) = result {
                    observation_failed(address, error);
                }
            },
            || unsafe { (original_imps().entered)(this, cmd, sender) },
            |(), _| {},
        )
    })
}

unsafe extern "C-unwind" fn perform(
    this: &AnyObject,
    cmd: Sel,
    sender: &ProtocolObject<dyn NSDraggingInfo>,
) -> Bool {
    ffi_boundary(|| {
        let address = key(this);
        class_policy::forward(
            tracked(this),
            || {
                let started = Instant::now();
                let observed = observation(|| {
                    let sequence = sender.draggingSequenceNumber() as i64;
                    let internal = sender.draggingSource().is_some();
                    let prepared = with_instance(address, |i| {
                        i.next_drop = i
                            .next_drop
                            .checked_add(1)
                            .ok_or("native drop ID exhausted")?;
                        let id = i.next_drop;
                        i.capture.native_begin(id, sequence, internal, now(i));
                        Ok::<_, String>((id, capture_stamp(i)))
                    })
                    .ok_or("observer instance missing")??;
                    let snapshot = snapshot(sender);
                    Ok((prepared.0, prepared.1, sequence, snapshot))
                });
                if let Err(error) = &observed {
                    observation_failed(address, error.clone());
                }
                if let Ok((_, _, _, Err(error))) = &observed {
                    observation_failed(address, error.clone());
                }
                (observed, started)
            },
            || unsafe { (original_imps().perform)(this, cmd, sender) },
            |(observed, started), accepted| {
                // No state borrow/lock spans the original IMP. It may reenter HTML IPC.
                let expected = observed.as_ref().ok().map(|(_, stamp, _, _)| stamp.clone());
                let result = observation(|| {
                    if let Ok((id, stamp, sequence, snapshot)) = observed {
                        let capture_matches = with_instance(address, |i| {
                            class_policy::finish_drag_and_match_capture(
                                &capture_stamp(i),
                                i.next_drop,
                                &mut i.active_drag,
                                &stamp,
                                id,
                                Some(sequence),
                            )
                        });
                        if capture_matches != Some(true) {
                            return Ok(());
                        }
                        let capture_id = stamp.capture_id;
                        let (mut details, paths) = match snapshot {
                            Ok(snapshot) => (snapshot.metadata, snapshot.paths),
                            Err(error) => (json!({"metadataError": error}), Vec::new()),
                        };
                        details["captureId"] = json!(capture_id);
                        details["nativeDropId"] = json!(id);
                        details["sequence"] = json!(sequence);
                        details["nativePaths"] = json!(paths);
                        details["originalAccepted"] = json!(accepted.as_bool());
                        details["observationAndForwardMs"] =
                            json!(started.elapsed().as_secs_f64() * 1000.0);
                        if let Some(capture_id) = capture_id {
                            with_instance(address, |i| {
                                i.capture.native_complete(
                                    &capture_id,
                                    id,
                                    paths,
                                    accepted.as_bool(),
                                    now(i),
                                );
                            });
                        }
                        emit(address, "drop", details);
                    }
                    Ok(())
                });
                if let Err(error) = result {
                    if expected
                        .as_ref()
                        .is_some_and(|stamp| capture_is_current(address, stamp))
                    {
                        observation_failed(address, error);
                    }
                }
            },
        )
    })
}

unsafe extern "C-unwind" fn exited(
    this: &AnyObject,
    cmd: Sel,
    sender: Option<&ProtocolObject<dyn NSDraggingInfo>>,
) {
    ffi_boundary(|| {
        class_policy::forward(
            tracked(this),
            || {
                let address = key(this);
                let _ = observation(|| {
                    with_instance(address, |i| {
                        i.active_drag = None;
                        i.capture.cancel_before_drop(now(i));
                    });
                    emit(address, "exit", json!({}));
                    Ok(())
                });
            },
            || unsafe { (original_imps().exited)(this, cmd, sender) },
            |(), _| {},
        )
    });
}

unsafe extern "C-unwind" fn ended(
    this: &AnyObject,
    cmd: Sel,
    sender: &ProtocolObject<dyn NSDraggingInfo>,
) {
    ffi_boundary(|| {
        let original = original_imps()
            .ended
            .unwrap_or_else(|| std::process::abort());
        class_policy::forward(
            tracked(this),
            || {
                let address = key(this);
                let _ = observation(|| {
                    with_instance(address, |i| {
                        i.active_drag = None;
                        i.capture.cancel_before_drop(now(i));
                    });
                    emit(address, "end", json!({}));
                    Ok(())
                });
            },
            || unsafe { original(this, cmd, sender) },
            |(), _| {},
        )
    });
}

unsafe extern "C-unwind" fn prepare(
    this: &AnyObject,
    cmd: Sel,
    sender: &ProtocolObject<dyn NSDraggingInfo>,
) -> Bool {
    ffi_boundary(|| {
        let original = original_imps()
            .prepare
            .unwrap_or_else(|| std::process::abort());
        let address = key(this);
        class_policy::forward(
            tracked(this),
            || {
                observation(|| {
                    Ok(with_instance(address, |i| {
                        (capture_stamp(i), i.next_drop, i.active_drag)
                    }))
                })
                .ok()
                .flatten()
            },
            || unsafe { original(this, cmd, sender) },
            |stamp, accepted| {
                if !accepted.as_bool() {
                    let _ = observation(|| {
                        with_instance(address, |i| {
                            if let Some((stamp, native_drop, sequence)) = &stamp {
                                if class_policy::finish_drag_and_match_capture(
                                    &capture_stamp(i),
                                    i.next_drop,
                                    &mut i.active_drag,
                                    stamp,
                                    *native_drop,
                                    *sequence,
                                ) {
                                    i.capture.cancel_before_drop(now(i));
                                }
                            }
                        });
                        Ok(())
                    });
                }
            },
        )
    })
}

unsafe extern "C-unwind" fn dealloc(this: &AnyObject, cmd: Sel) {
    ffi_boundary(|| {
        let original = original_imps().dealloc;
        class_policy::forward(
            tracked(this),
            || {
                // Removing state releases no WKWebView reference. No borrow survives
                // into the original Wry dealloc, which preserves its own super call.
                let address = key(this);
                let _ = observation(|| {
                    let removed = take_instance(address, None);
                    if let Some(mut instance) = removed {
                        instance.capture.close();
                        let _ = instance.sink.emit_to(
                            "main",
                            EVENT,
                            json!({
                                "phase": "dealloc", "generation": instance.generation,
                                "captureId": instance.capture.active_id(), "nativeDropId": null,
                                "diagnosticOnly": true
                            }),
                        );
                    }
                    Ok(())
                });
            },
            || unsafe { original(this, cmd) },
            |(), _| {},
        )
        // The receiver is invalid after the original IMP; never touch it here.
    });
}

fn validate_window(window: &WebviewWindow) -> Result<(), String> {
    if window.label() != "main" {
        return Err("observer is restricted to main".into());
    }
    let config = window.app_handle().config();
    let main = config
        .app
        .windows
        .iter()
        .find(|w| w.label == "main")
        .ok_or("main is not a configured window")?;
    if main.drag_drop_enabled {
        return Err("observer requires dragDropEnabled=false".into());
    }
    Ok(())
}

fn trusted(view: &WKWebView) -> Result<(), String> {
    if unsafe { view.isLoading() } {
        return Err("wait for the intake document to finish loading".into());
    }
    let url = unsafe { view.URL() }
        .and_then(|url| url.absoluteString())
        .ok_or("WebView URL unavailable")?;
    let url = tauri::Url::parse(&url.to_string()).map_err(|e| e.to_string())?;
    if url.scheme() != "tauri" || url.host_str() != Some("localhost") || url.port().is_some() {
        return Err("observer requires the embedded tauri://localhost document".into());
    }
    Ok(())
}

// Pure policy shared by runtime installation and host-runnable model tests.
mod class_policy {
    use std::{collections::HashMap, ffi::CStr};

    #[derive(Clone, Debug, PartialEq, Eq)]
    pub(super) struct CaptureStamp {
        pub generation: u64,
        pub command_epoch: u64,
        pub capture_id: Option<String>,
    }

    // A rejected reentrant Arm still advances command_epoch. Finishing the
    // native drag must not depend on that capture stamp remaining current.
    // Only this same instance/drop/sequence may clear active_drag; the return
    // value separately authorizes capture completion/cancellation/diagnostics.
    pub(super) fn finish_drag_and_match_capture(
        current: &CaptureStamp,
        current_native_drop: u64,
        active_drag: &mut Option<i64>,
        saved: &CaptureStamp,
        saved_native_drop: u64,
        saved_sequence: Option<i64>,
    ) -> bool {
        if current.generation == saved.generation
            && current_native_drop == saved_native_drop
            && saved_sequence.is_some()
            && *active_drag == saved_sequence
        {
            *active_drag = None;
        }
        current == saved
    }

    pub(super) fn owned_slot<K: PartialEq, T>(
        selector: K,
        direct_methods: impl IntoIterator<Item = (K, T)>,
    ) -> Option<T> {
        direct_methods
            .into_iter()
            .find_map(|(name, method)| (name == selector).then_some(method))
    }

    pub(super) fn usable_original(original: Option<usize>, wrapper: usize) -> bool {
        original.is_some_and(|original| original != 0 && original != wrapper)
    }

    pub(super) fn remove_generation<T>(
        instances: &mut HashMap<usize, T>,
        address: usize,
        expected: Option<u64>,
        generation: impl FnOnce(&T) -> u64,
    ) -> Option<T> {
        let current = instances.get(&address)?;
        if expected.is_some_and(|expected| expected != generation(current)) {
            return None;
        }
        instances.remove(&address)
    }

    // Each native wrapper uses this exact orchestration. Observation closures
    // contain the existing exception boundary; the original is never retried.
    pub(super) fn forward<B, R>(
        tracked: bool,
        before: impl FnOnce() -> B,
        original: impl FnOnce() -> R,
        after: impl FnOnce(B, &R),
    ) -> R {
        if !tracked {
            return original();
        }
        let observation = before();
        let result = original();
        after(observation, &result);
        result
    }

    pub(super) fn public_class_matches(public: Option<usize>, registered: Option<usize>) -> bool {
        matches!((public, registered), (Some(public), Some(registered)) if public == registered)
    }

    // wry 0.57.0 has no #[name]; objc2 0.6.4 generates this from
    // module_path!() + "::" + class + CARGO_PKG_VERSION. Review on upgrade.
    pub(super) const WRY_NAME: &CStr = c"wry::wkwebview::class::wry_web_view::WryWebView0.57.0";

    pub(super) struct Class<'a> {
        pub identity: usize,
        pub name: &'a [u8],
        pub parent: Option<usize>,
        pub size: usize,
    }

    pub(super) fn accepts(original: &Class<'_>, registered: Option<(usize, usize)>) -> bool {
        let Some((wry_identity, wry_size)) = registered else {
            return false;
        };
        original.identity == wry_identity
            || (original.name.strip_prefix(b"..NSKVONotifying_") == Some(WRY_NAME.to_bytes())
                && original.parent == Some(wry_identity)
                && original.size == wry_size)
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        const WRY: usize = 1;
        const KVO: usize = 2;
        const OTHER: usize = 3;
        const SIZE: usize = 1216;
        const OBSERVED_KVO: &[u8] =
            b"..NSKVONotifying_wry::wkwebview::class::wry_web_view::WryWebView0.57.0";

        fn observed() -> Class<'static> {
            Class {
                identity: KVO,
                name: OBSERVED_KVO,
                parent: Some(WRY),
                size: SIZE,
            }
        }

        #[test]
        fn accepts_registered_wry_and_observed_direct_kvo() {
            let direct = Class {
                identity: WRY,
                name: WRY_NAME.to_bytes(),
                parent: Some(OTHER),
                size: SIZE,
            };
            assert!(accepts(&direct, Some((WRY, SIZE))));
            assert!(accepts(&observed(), Some((WRY, SIZE))));
        }

        #[test]
        fn rejects_missing_registration_and_name_only_wry_impostor() {
            let impostor = Class {
                identity: OTHER,
                name: WRY_NAME.to_bytes(),
                ..observed()
            };
            assert!(!accepts(&impostor, Some((WRY, SIZE))));
            assert!(!accepts(&observed(), None));
            assert!(!accepts(
                &Class {
                    identity: WRY,
                    ..observed()
                },
                None
            ));
        }

        #[test]
        fn rejects_wrong_or_indirect_parent_and_layout_changes() {
            // OTHER may itself descend from Wry: only the direct parent counts.
            for parent in [None, Some(OTHER), Some(KVO)] {
                assert!(!accepts(
                    &Class {
                        parent,
                        ..observed()
                    },
                    Some((WRY, SIZE))
                ));
            }
            for size in [SIZE - 8, SIZE + 8] {
                assert!(!accepts(&Class { size, ..observed() }, Some((WRY, SIZE))));
            }
            // Identically spelled KVO over a different registered identity.
            assert!(!accepts(&observed(), Some((OTHER, SIZE))));
        }

        #[test]
        fn rejects_other_webviews_unknown_wrappers_and_name_variants() {
            for name in [
                b"WKWebView".as_slice(),
                b"WryWebView",
                b"CustomWrySubclass",
                b"NSKVONotifying_wry::wkwebview::class::wry_web_view::WryWebView0.57.0",
                b".NSKVONotifying_wry::wkwebview::class::wry_web_view::WryWebView0.57.0",
                b"..NSKVONotifying_wry::wkwebview::class::wry_web_view::WryWebView0.58.0",
                b"..NSKVONotifying_wry::wkwebview::class::wry_web_view::WryWebView0.57.0_extra",
                b"..NSKVONotifying_..NSKVONotifying_wry::wkwebview::class::wry_web_view::WryWebView0.57.0",
            ] {
                assert!(!accepts(&Class { name, ..observed() }, Some((WRY, SIZE))));
            }
        }

        #[test]
        fn public_identity_requires_non_nil_registered_wry() {
            assert!(public_class_matches(Some(WRY), Some(WRY)));
            for public in [None, Some(KVO), Some(OTHER)] {
                assert!(!public_class_matches(public, Some(WRY)));
            }
            assert!(!public_class_matches(None, None));
            assert!(!public_class_matches(Some(WRY), None));
        }

        #[test]
        fn untracked_never_observes_and_forwards_exactly_once() {
            let calls = std::cell::Cell::new(0);
            let value = forward(
                false,
                || panic!("untracked pasteboard read"),
                || {
                    calls.set(calls.get() + 1);
                    0x8000_0000_0000_0001_u64
                },
                |_: (), _| panic!("untracked event/state access"),
            );
            assert_eq!(calls.get(), 1);
            assert_eq!(value, 0x8000_0000_0000_0001);
        }

        #[test]
        fn tracked_observation_error_does_not_skip_retry_or_convert_return() {
            use std::cell::RefCell;
            for original_bool in [0_i8, 1, -1, 127] {
                let order = RefCell::new(Vec::new());
                let value = forward(
                    true,
                    || {
                        order.borrow_mut().push("before");
                        Err::<(), _>("observation failed")
                    },
                    || {
                        order.borrow_mut().push("original");
                        original_bool
                    },
                    |observed, result| {
                        assert!(observed.is_err());
                        assert_eq!(*result, original_bool);
                        order.borrow_mut().push("after");
                    },
                );
                assert_eq!(value, original_bool);
                assert_eq!(*order.borrow(), ["before", "original", "after"]);
            }
        }

        #[test]
        fn original_failure_is_not_retried_or_replaced_by_observation() {
            use std::{
                cell::Cell,
                panic::{AssertUnwindSafe, catch_unwind},
            };
            let calls = Cell::new(0);
            let after = Cell::new(0);
            let result = catch_unwind(AssertUnwindSafe(|| {
                forward(
                    true,
                    || (),
                    || {
                        calls.set(calls.get() + 1);
                        panic!("original failure")
                    },
                    |(), _: &()| after.set(after.get() + 1),
                )
            }));
            assert!(result.is_err());
            assert_eq!(calls.get(), 1);
            assert_eq!(after.get(), 0);
        }

        #[test]
        fn dealloc_removes_only_target_before_original_without_held_borrow() {
            use std::{
                cell::{Cell, RefCell},
                collections::HashMap,
            };
            let instances = RefCell::new(HashMap::from([(10, "armed"), (11, "armed")]));
            let calls = Cell::new(0);
            forward(
                true,
                || {
                    instances.borrow_mut().remove(&10);
                },
                || {
                    calls.set(calls.get() + 1);
                    let live = instances.borrow_mut(); // reentrant access must work
                    assert!(!live.contains_key(&10));
                    assert_eq!(live.get(&11), Some(&"armed"));
                },
                |(), _| {},
            );
            assert_eq!(calls.get(), 1);
            forward(
                false,
                || panic!("unknown instance cleanup"),
                || calls.set(calls.get() + 1),
                |(): (), _| panic!("post-dealloc access"),
            );
            assert_eq!(calls.get(), 2);
        }

        #[test]
        fn direct_method_list_never_authorizes_replacing_an_inherited_method() {
            // Effective lookup may find parent's 90, but the direct Wry list
            // has only other selectors. Runtime must take class_addMethod path.
            assert_eq!(
                owned_slot("prepare", [("enter", 10), ("dealloc", 11)]),
                None
            );
            assert_eq!(
                owned_slot("enter", [("enter", 10), ("dealloc", 11)]),
                Some(10)
            );
            assert_eq!(owned_slot("absent", [("enter", 10)]), None);
            assert!(!usable_original(None, 20));
            assert!(!usable_original(Some(0), 20));
            assert!(!usable_original(Some(20), 20));
            assert!(usable_original(Some(90), 20)); // inherited effective IMP
        }

        #[test]
        fn destroy_retirement_is_generation_scoped_and_dealloc_can_be_late() {
            let mut instances = HashMap::from([(10, 1_u64), (11, 7)]);
            assert_eq!(
                remove_generation(&mut instances, 10, Some(1), |g| *g),
                Some(1)
            );
            assert_eq!(remove_generation(&mut instances, 10, None, |g| *g), None);
            instances.insert(10, 2); // new lifetime may reuse the same address
            assert_eq!(remove_generation(&mut instances, 10, Some(1), |g| *g), None);
            assert_eq!(instances.get(&10), Some(&2));
            assert_eq!(
                remove_generation(&mut instances, 10, Some(2), |g| *g),
                Some(2)
            );
            assert_eq!(instances.get(&11), Some(&7));
        }

        #[test]
        fn post_forward_stamp_rejects_retired_rebuilt_and_rearmed_capture() {
            let stamp = CaptureStamp {
                generation: 1,
                command_epoch: 2,
                capture_id: Some("a".into()),
            };
            assert_eq!(Some(stamp.clone()), Some(stamp.clone()));
            assert_ne!(Some(&stamp), None);
            assert_ne!(
                stamp,
                CaptureStamp {
                    generation: 2,
                    ..stamp.clone()
                }
            );
            assert_ne!(
                stamp,
                CaptureStamp {
                    command_epoch: 3,
                    ..stamp.clone()
                }
            );
            assert_ne!(
                stamp,
                CaptureStamp {
                    capture_id: Some("b".into()),
                    ..stamp.clone()
                }
            );
            assert_ne!(
                stamp,
                CaptureStamp {
                    capture_id: None,
                    ..stamp.clone()
                }
            );
        }

        struct DragModel {
            stamp: CaptureStamp,
            native_drop: u64,
            active_drag: Option<i64>,
            invalidated: bool,
            capture_effects: usize,
        }

        impl DragModel {
            fn new(native_drop: u64) -> Self {
                Self {
                    stamp: CaptureStamp {
                        generation: 1,
                        command_epoch: 2,
                        capture_id: Some("old".into()),
                    },
                    native_drop,
                    active_drag: Some(7),
                    invalidated: false,
                    capture_effects: 0,
                }
            }

            // Models the existing Arm order: invalidate, advance epoch, then
            // reject active drag. The capture ID survives invalidate in source.
            fn arm(&mut self, id: &str) -> Result<(), &'static str> {
                self.invalidated = true;
                self.stamp.command_epoch += 1;
                if self.active_drag.is_some() {
                    return Err("active drag");
                }
                self.stamp.capture_id = Some(id.into());
                self.invalidated = false;
                Ok(())
            }

            fn finish(&mut self, saved: &CaptureStamp, drop: u64, sequence: Option<i64>) {
                if finish_drag_and_match_capture(
                    &self.stamp,
                    self.native_drop,
                    &mut self.active_drag,
                    saved,
                    drop,
                    sequence,
                ) {
                    // Represents native_complete/diagnostics for perform, or
                    // cancel_before_drop for rejected prepare. Never stale.
                    self.capture_effects += 1;
                }
            }
        }

        #[test]
        fn rejected_reentrant_arm_does_not_strand_perform_or_rejected_prepare() {
            use std::cell::{Cell, RefCell};
            for (native_drop, accepted) in [(1, true), (0, false)] {
                let model = RefCell::new(DragModel::new(native_drop));
                let calls = Cell::new(0);
                let result = forward(
                    true,
                    || {
                        let state = model.borrow();
                        (state.stamp.clone(), state.native_drop, state.active_drag)
                    },
                    || {
                        calls.set(calls.get() + 1);
                        assert_eq!(model.borrow_mut().arm("reentrant"), Err("active drag"));
                        accepted
                    },
                    |(saved, drop, sequence), _| {
                        model.borrow_mut().finish(&saved, drop, sequence);
                    },
                );
                let mut state = model.borrow_mut();
                assert_eq!(result, accepted);
                assert_eq!(calls.get(), 1);
                assert_eq!(state.active_drag, None);
                assert_eq!(state.capture_effects, 0); // stale write AND cancel denied
                assert!(state.invalidated);
                assert_eq!(state.arm("next"), Ok(())); // no extra exit/end needed
                assert_eq!(state.stamp.capture_id.as_deref(), Some("next"));
            }
        }

        #[test]
        fn old_callback_cannot_clear_new_generation_native_drop_or_sequence() {
            for native_drop in [0, 1] {
                // prepare snapshot and perform ID
                for changed in 0..3 {
                    let mut state = DragModel::new(native_drop);
                    let saved = state.stamp.clone();
                    match changed {
                        0 => state.stamp.generation += 1,
                        1 => state.native_drop += 1,
                        _ => state.active_drag = Some(8),
                    }
                    let active = state.active_drag;
                    state.finish(&saved, native_drop, Some(7));
                    assert_eq!(state.active_drag, active);
                }
            }
        }

        #[test]
        fn old_callback_can_finish_its_drag_but_never_write_or_cancel_new_capture() {
            for native_drop in [0, 1] {
                let mut state = DragModel::new(native_drop);
                let saved = state.stamp.clone();
                state.stamp.command_epoch += 1;
                state.stamp.capture_id = Some("new".into());
                let new_capture = state.stamp.clone();
                state.finish(&saved, native_drop, Some(7));
                assert_eq!(state.active_drag, None);
                assert_eq!(state.stamp, new_capture);
                assert_eq!(state.capture_effects, 0);
            }
        }

        #[test]
        fn matching_capture_still_completes_after_drag_already_exited() {
            let mut state = DragModel::new(1);
            let saved = state.stamp.clone();
            state.active_drag = None;
            state.finish(&saved, 1, Some(7));
            assert_eq!(state.active_drag, None);
            assert_eq!(state.capture_effects, 1);
            // A prepare snapshot without a drag cannot clear a later drag.
            state.active_drag = Some(8);
            state.finish(&saved, 1, None);
            assert_eq!(state.active_drag, Some(8));
        }

        #[test]
        fn typed_forward_preserves_receiver_selector_sender_and_scalar_bits() {
            unsafe extern "C-unwind" fn original(
                receiver: usize,
                selector: usize,
                sender: usize,
            ) -> u64 {
                assert_eq!((receiver, selector, sender), (100, 200, 0));
                u64::MAX
            }
            let saved: unsafe extern "C-unwind" fn(usize, usize, usize) -> u64 = original;
            for tracked in [false, true] {
                assert_eq!(
                    forward(
                        tracked,
                        || (),
                        || unsafe { saved(100, 200, 0) },
                        |(), result| assert_eq!(*result, u64::MAX)
                    ),
                    u64::MAX
                );
            }
        }
    }
}

fn supported_original_class(original: &AnyClass) -> bool {
    class_policy::accepts(
        &class_policy::Class {
            identity: original as *const AnyClass as usize,
            name: original.name().to_bytes(),
            parent: original
                .superclass()
                .map(|parent| parent as *const AnyClass as usize),
            size: original.instance_size(),
        },
        AnyClass::get(class_policy::WRY_NAME)
            .map(|wry| (wry as *const AnyClass as usize, wry.instance_size())),
    )
}

fn original_class_diagnostic(original: &AnyClass) -> Value {
    let registered_name = class_policy::WRY_NAME;
    let registered_wry = AnyClass::get(registered_name);
    let mut chain = Vec::new();
    let mut class = Some(original);
    while let Some(candidate) = class {
        chain.push(json!({
            "name": candidate.name().to_string_lossy(),
            "instanceSize": candidate.instance_size(),
            "registeredWryMatch": registered_wry
                .is_some_and(|wry| std::ptr::eq(candidate, wry)),
        }));
        class = candidate.superclass();
    }
    json!({
        "diagnosticOnly": true,
        "registeredWryName": registered_name.to_string_lossy(),
        "registeredWryFound": registered_wry.is_some(),
        "classChain": chain,
    })
}

// Temporary native diagnostics: independent of renderer/AX/event delivery.
// Ignore only stderr I/O errors; Objective-C exceptions keep the existing
// installation observation boundary, with no retry or class reuse added here.
fn install_trace(stage: &str, details: Value) {
    use std::io::Write;
    let _ = writeln!(
        std::io::stderr().lock(),
        "[intake-macos-wry-imp-v1] {}",
        json!({"pid": std::process::id(), "stage": stage, "details": details})
    );
}

fn class_trace_details(class: &AnyClass) -> Value {
    json!({
        "name": class.name().to_string_lossy(),
        "identity": class as *const AnyClass as usize,
        "instanceSize": class.instance_size(),
        "parent": class.superclass().map(|parent| json!({
            "name": parent.name().to_string_lossy(),
            "identity": parent as *const AnyClass as usize,
            "instanceSize": parent.instance_size(),
        })),
    })
}

fn trace_view_classes(stage: &str, object: &AnyObject) -> Option<&'static AnyClass> {
    let raw = object.class(); // objc2 uses object_getClass, not -class.
    install_trace(
        stage,
        json!({
            "step": "before-public-class-query", "object": key(object),
            "rawClass": class_trace_details(raw),
        }),
    );
    let public: Option<&'static AnyClass> = unsafe { msg_send![object, class] };
    install_trace(
        stage,
        json!({
            "step": "after-public-class-query", "object": key(object),
            "rawClass": class_trace_details(raw),
            "publicClass": public.map(class_trace_details),
        }),
    );
    public
}

struct HookPlan {
    selector: Sel,
    original: Imp,
    wrapper: Imp,
    encoding: CString,
    owned: Option<&'static Method>,
}

impl HookPlan {
    fn capture<F: MethodImplementation>(
        wry: &'static AnyClass,
        selector: Sel,
        wrapper: F,
    ) -> Result<Self, String> {
        // The typed wrapper supplies the ABI contract. Lookup starts at Wry,
        // NEVER the object's raw KVO class. This includes objc2's Wry dealloc.
        wry.verify_sel::<F::Arguments, F::Return>(selector)
            .map_err(|e| e.to_string())?;
        let method = wry.instance_method(selector).ok_or("missing Wry method")?;
        let original = unsafe { objc2::ffi::method_getImplementation(method) };
        let wrapper = wrapper.__imp();
        if !class_policy::usable_original(original.map(|imp| imp as usize), wrapper as usize) {
            return Err("original Wry IMP is null or already our wrapper".into());
        }
        let original = original.ok_or("null original Wry IMP")?;
        let types = unsafe { objc2::ffi::method_getTypeEncoding(method) };
        if types.is_null() {
            return Err("missing Wry method encoding".into());
        }
        // Only this DIRECT list authorizes method_setImplementation. An
        // inherited Method returned by instance_method must never be mutated.
        let owned = class_policy::owned_slot(
            selector,
            wry.instance_methods()
                .iter()
                .copied()
                .map(|m| (m.name(), m)),
        );
        Ok(Self {
            selector,
            original,
            wrapper,
            owned,
            encoding: unsafe { CStr::from_ptr(types) }.to_owned(),
        })
    }

    fn install(&self, wry: &'static AnyClass) -> Result<(), String> {
        install_trace(
            "wry-method-install",
            json!({
                "selector": self.selector.name().to_string_lossy(),
                "owned": self.owned.is_some(), "encoding": self.encoding.to_string_lossy(),
            }),
        );
        if let Some(method) = self.owned {
            // Safety: own Wry slot, verified typed ABI, all originals published.
            let previous = unsafe { method.set_implementation(self.wrapper) };
            if !std::ptr::fn_addr_eq(previous, self.original) {
                // A concurrent foreign replacement invalidates the published
                // call chain. Do not guess, retry or keep forwarding a stale IMP.
                install_trace(
                    "wry-imp-conflict",
                    json!({"selector": self.selector.name().to_string_lossy()}),
                );
                std::process::abort();
            }
        } else {
            // Inherited selector: add an override ONLY on Wry. Never replace
            // the inherited WKWebView/NSView/NSObject Method itself.
            let added = unsafe {
                objc2::ffi::class_addMethod(
                    wry as *const AnyClass as *mut AnyClass,
                    self.selector,
                    self.wrapper,
                    self.encoding.as_ptr(),
                )
            };
            if !added.as_bool() {
                return Err(format!(
                    "cannot add Wry override for {}",
                    self.selector.name().to_string_lossy()
                ));
            }
        }
        let installed = wry
            .instance_methods()
            .iter()
            .copied()
            .find(|m| m.name() == self.selector)
            .ok_or("installed method is not owned by Wry")?;
        if !std::ptr::fn_addr_eq(installed.implementation(), self.wrapper) {
            return Err("Wry method installation readback mismatch".into());
        }
        Ok(())
    }
}

fn install_wry_hooks(wry: &'static AnyClass) -> Result<(), String> {
    MainThreadMarker::new().ok_or("Wry hooks must install on the main thread")?;
    if AnyClass::get(class_policy::WRY_NAME) != Some(wry) {
        return Err("method hooks require the exact registered Wry class".into());
    }
    // Installation's OnceLock is NEVER read by a wrapper. Its initializer
    // contains observation so a partial failure is cached, not retried.
    HOOK_INSTALL
        .get_or_init(|| {
            observation(|| {
                let entered = HookPlan::capture(
                    wry,
                    sel!(draggingEntered:),
                    entered as unsafe extern "C-unwind" fn(_, _, _) -> _,
                )?;
                let perform = HookPlan::capture(
                    wry,
                    sel!(performDragOperation:),
                    perform as unsafe extern "C-unwind" fn(_, _, _) -> _,
                )?;
                let exited = HookPlan::capture(
                    wry,
                    sel!(draggingExited:),
                    exited as unsafe extern "C-unwind" fn(_, _, _),
                )?;
                let dealloc = HookPlan::capture(
                    wry,
                    sel!(dealloc),
                    dealloc as unsafe extern "C-unwind" fn(_, _),
                )?;
                let ended = wry
                    .instance_method(sel!(draggingEnded:))
                    .map(|_| {
                        HookPlan::capture(
                            wry,
                            sel!(draggingEnded:),
                            ended as unsafe extern "C-unwind" fn(_, _, _),
                        )
                    })
                    .transpose()?;
                let prepare = wry
                    .instance_method(sel!(prepareForDragOperation:))
                    .map(|_| {
                        HookPlan::capture(
                            wry,
                            sel!(prepareForDragOperation:),
                            prepare as unsafe extern "C-unwind" fn(_, _, _) -> _,
                        )
                    })
                    .transpose()?;
                // Safety: each IMP's argument/return encodings were verified against
                // the exact function-pointer type above. None is nil or our wrapper.
                let originals = unsafe {
                    OriginalImps {
                        entered: std::mem::transmute::<Imp, DragOperationImp>(entered.original),
                        perform: std::mem::transmute::<Imp, DragBoolImp>(perform.original),
                        exited: std::mem::transmute::<Imp, DragExitImp>(exited.original),
                        dealloc: std::mem::transmute::<Imp, DeallocImp>(dealloc.original),
                        ended: ended
                            .as_ref()
                            .map(|p| std::mem::transmute::<Imp, DragVoidImp>(p.original)),
                        prepare: prepare
                            .as_ref()
                            .map(|p| std::mem::transmute::<Imp, DragBoolImp>(p.original)),
                    }
                };
                ORIGINAL_IMPS
                    .set(originals)
                    .map_err(|_| "original IMP table already published")?;
                install_trace(
                    "original-imps-published",
                    json!({"class": wry.name().to_string_lossy()}),
                );
                // A failure leaves any installed wrappers transparent: no instance is
                // registered until all slots and identity checks succeed. No uninstall.
                for plan in [&entered, &perform, &exited, &dealloc]
                    .into_iter()
                    .chain(ended.as_ref())
                    .chain(prepare.as_ref())
                {
                    plan.install(wry)?;
                }
                install_trace("wry-hooks-finish", json!({}));
                Ok(())
            })
        })
        .clone()
}

fn install_ui(view: &WKWebView, sink: tauri::AppHandle) -> Result<Value, String> {
    install_trace("install-ui-enter", json!({}));
    MainThreadMarker::new().ok_or("installation must run on the main thread")?;
    trusted(view)?;
    install_trace("trusted-document-checked", json!({}));
    let object: &AnyObject = view.as_ref();
    let address = key(object);
    if let Some(generation) = with_instance(address, |i| i.generation) {
        return Ok(json!({"installed": true, "generation": generation, "alreadyInstalled": true}));
    }
    // Eligibility stays narrow; no writes to this raw class or its KVO parent.
    let original = object.class();
    if !supported_original_class(original) {
        return Err(format!(
            "unsupported original WebView class: {}; classDiagnostic={}",
            original.name().to_string_lossy(),
            original_class_diagnostic(original)
        ));
    }
    install_trace("original-class-accepted", class_trace_details(original));
    original
        .verify_sel::<(), Option<&AnyClass>>(sel!(class))
        .map_err(|e| e.to_string())?;
    let wry = AnyClass::get(class_policy::WRY_NAME).ok_or("registered Wry missing")?;
    let size_before = original.instance_size();
    let public_before = trace_view_classes("before-wry-hooks", object);
    if !class_policy::public_class_matches(
        public_before.map(|class| class as *const AnyClass as usize),
        Some(wry as *const AnyClass as usize),
    ) {
        return Err("public WebView class must be the non-nil registered Wry class".into());
    }
    let public_before = public_before.ok_or("public WebView class is nil")?;
    install_wry_hooks(wry)?;
    let public_after = trace_view_classes("after-wry-hooks", object);
    let unchanged = std::ptr::eq(object.class(), original)
        && original.instance_size() == size_before
        && public_after.is_some_and(|class| std::ptr::eq(public_before, class));
    install_trace(
        "class-identity-comparison",
        json!({
            "rawUnchanged": std::ptr::eq(object.class(), original),
            "publicUnchanged": public_after.is_some_and(|class| std::ptr::eq(public_before, class)),
            "layoutUnchanged": original.instance_size() == size_before,
        }),
    );
    if !unchanged {
        return Err("WebView identity/layout changed during Wry hook installation".into());
    }
    let generation = NEXT_GENERATION.fetch_add(1, Ordering::Relaxed);
    INSTANCES.with(|instances| {
        instances.borrow_mut().insert(
            address,
            Instance {
                generation,
                next_drop: 0,
                command_epoch: 0,
                active_drag: None,
                clock: Instant::now(),
                capture: CaptureState::new(generation),
                sink,
            },
        )
    });
    install_trace(
        "instance-metadata-ready",
        json!({"generation": generation, "object": address}),
    );
    install_trace("install-event-begin", json!({"generation": generation}));
    emit(
        address,
        "install",
        json!({"installed": true, "originalClass": original.name().to_string_lossy()}),
    );
    install_trace("install-ui-finish", json!({"generation": generation}));
    Ok(
        json!({"installed": true, "generation": generation, "alreadyInstalled": false,
        "macCompileVerified": false, "macRuntimeVerified": false}),
    )
}

pub async fn install(window: WebviewWindow) -> Result<Value, String> {
    install_trace("install-request", json!({}));
    validate_window(&window)?;
    let sink = window.app_handle().clone();
    let event_window = window.clone();
    let (tx, mut rx) = tauri::async_runtime::channel(1);
    window
        .with_webview(move |platform| {
            install_trace("webview-callback-enter", json!({}));
            let result = observation(|| {
                MainThreadMarker::new().ok_or("not on main thread")?;
                let raw = platform.inner().cast::<WKWebView>();
                let view = unsafe { raw.as_ref() }.ok_or("null WKWebView")?;
                let result = install_ui(view, sink.clone())?;
                if result["alreadyInstalled"] == false {
                    let object: &AnyObject = view.as_ref();
                    let address = key(object);
                    let generation = result["generation"].as_u64().ok_or("missing generation")?;
                    event_window.on_window_event(move |event| {
                        if matches!(event, tauri::WindowEvent::Destroyed) {
                            // Wry can keep the view alive after the window dies.
                            // Retire immediately on UI thread, not only in dealloc.
                            if MainThreadMarker::new().is_some() {
                                retire_window(address, generation);
                            } else {
                                if sink
                                    .run_on_main_thread(move || retire_window(address, generation))
                                    .is_err()
                                {
                                    // Continuing would leave a dead-window address tracked.
                                    std::process::abort();
                                }
                            }
                        }
                    });
                }
                Ok(result)
            });
            install_trace(
                "webview-callback-finish",
                json!({
                    "ok": result.is_ok(), "error": result.as_ref().err(),
                }),
            );
            let sent = tx.try_send(result);
            install_trace("install-reply-send-finish", json!({"ok": sent.is_ok()}));
        })
        .map_err(|e| e.to_string())?;
    // Actual completion from the UI callback, NOT just successful enqueueing.
    rx.recv()
        .await
        .ok_or_else(|| "installation callback was dropped".to_owned())?
}

enum Command {
    Arm(String),
    Finish(String, String),
    Status(String),
}

fn reply_json(reply: Reply) -> Value {
    json!({"status": reply.phase.as_str(), "generation": reply.generation,
        "captureId": reply.capture_id, "nativeDropId": reply.native_drop_id,
        "sequence": reply.sequence, "htmlDropId": reply.html_drop_id,
        "nativeCount": reply.native_count, "htmlCount": reply.html_count,
        "reason": reply.reason, "paths": reply.resolved_paths,
        "fileListCorrespondence": "native-list-only-no-html-item-pairing"})
}

async fn command(window: WebviewWindow, command: Command) -> Result<Value, String> {
    validate_window(&window)?;
    let (tx, mut rx) = tauri::async_runtime::channel(1);
    window.with_webview(move |platform| {
        let start = observation(|| {
            MainThreadMarker::new().ok_or("not on main thread")?;
            let raw = platform.inner().cast::<WKWebView>();
            let view = unsafe { raw.as_ref() }.ok_or("null WKWebView")?;
            trusted(view)?;
            let object: &AnyObject = view.as_ref();
            let address = key(object);
            let (generation, command_epoch) = with_instance(address, |i| {
                if matches!(&command, Command::Arm(_)) {
                    // Invalidate before the asynchronous JS check, not after:
                    // old finish/status completions cannot resolve while a
                    // new preparation is in flight. Out-of-order arm callback
                    // completion must not overwrite a newer preparation.
                    i.capture.invalidate("capture-rearming");
                    i.command_epoch = i.command_epoch.checked_add(1).ok_or("command epoch exhausted")?;
                    if i.active_drag.is_some() { return Err("cannot prepare during an active drag"); }
                }
                if let Command::Finish(id, html_id) = &command {
                    // Count now, not in the delayed JS completion. A second
                    // finish received before that completion must invalidate
                    // the capture instead of arriving after paths are consumed.
                    i.capture.note_html(id, html_id.clone(), i.generation, now(i));
                }
                Ok((i.generation, i.command_epoch))
            }).ok_or("observer is not installed")?.map_err(str::to_owned)?;
            let script = match &command {
                Command::Arm(_) => {
                    let nonce = format!("{generation}-{}", NEXT_DOCUMENT.fetch_add(1, Ordering::Relaxed));
                    format!("(()=>{{const k='{DOCUMENT_KEY}'; if(!Object.prototype.hasOwnProperty.call(window,k)) Object.defineProperty(window,k,{{value:'{nonce}',configurable:false,writable:false}}); return window[k];}})()")
                }
                _ => format!("window.{DOCUMENT_KEY} || ''"),
            };
            let completion_tx = tx.clone();
            let completion = RcBlock::new(move |value: *mut AnyObject, error: *mut NSError| {
                ffi_boundary(|| {
                    let result = observation(|| {
                        MainThreadMarker::new().ok_or("JS completion is not on main thread")?;
                        if !error.is_null() { return Err("document identity evaluation failed".into()); }
                        let value = unsafe { value.as_ref() }.ok_or("missing document identity")?;
                        let value = value.downcast_ref::<NSString>().ok_or("invalid document identity")?;
                        let document = bounded_string(value, 128)?;
                        let reply = with_instance(address, |i| {
                            if i.generation != generation { return Err("WebView generation changed".into()); }
                            if i.command_epoch != command_epoch { return Err("capture preparation was superseded".into()); }
                            let now = now(i);
                            match &command {
                                Command::Arm(id) => i.capture.arm(id.clone(), document, now).map_err(str::to_owned),
                                Command::Finish(id, _) => Ok(i.capture.poll(id, &document, generation, now)),
                                Command::Status(id) => Ok(i.capture.poll(id, &document, generation, now)),
                            }
                        }).ok_or("WebView has been destroyed")??;
                        Ok(reply_json(reply))
                    });
                    // No event contains root paths. Only this command reply
                    // may consume a paired result; polling never adds HTML.
                    let _ = completion_tx.try_send(result);
                });
            });
            unsafe { view.evaluateJavaScript_completionHandler(&NSString::from_str(&script), Some(&completion)); }
            Ok(())
        });
        if let Err(error) = start { let _ = tx.try_send(Err(error)); }
    }).map_err(|e| e.to_string())?;
    rx.recv()
        .await
        .ok_or_else(|| "document identity callback was dropped".to_owned())?
}

pub async fn arm(window: WebviewWindow, capture_id: String) -> Result<Value, String> {
    command(window, Command::Arm(capture_id)).await
}

pub async fn finish_html(
    window: WebviewWindow,
    capture_id: String,
    html_drop_id: String,
) -> Result<Value, String> {
    command(window, Command::Finish(capture_id, html_drop_id)).await
}

pub async fn status(window: WebviewWindow, capture_id: String) -> Result<Value, String> {
    command(window, Command::Status(capture_id)).await
}
