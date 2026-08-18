use tauri::{
    menu::{CheckMenuItemBuilder, Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Listener, Manager, WindowEvent,
};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

mod vault;

fn toggle_visibility(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    if window.is_visible().unwrap_or(false) {
        let _ = window.hide();
    } else {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

// Waking a click-through window can't rely on mouseenter, since a window
// that is ignoring cursor events never receives it. The global shortcut is
// the only way in, so it also cancels fade mode (via the `gp://wake` event)
// once it has focused the editor.
fn wake_or_hide(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let visible = window.is_visible().unwrap_or(false);
    let focused = window.is_focused().unwrap_or(false);
    if visible && focused {
        let _ = window.hide();
    } else {
        let _ = window.show();
        let _ = window.set_focus();
        let _ = window.emit("gp://wake", ());
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::SIZE
                        | tauri_plugin_window_state::StateFlags::POSITION,
                )
                .build(),
        )
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(vault::VaultState::default())
        .invoke_handler(tauri::generate_handler![
            vault::save_anthropic_key,
            vault::clear_anthropic_key,
            vault::has_anthropic_key,
            vault::organize_notes,
        ])
        .setup(|app| {
            app.global_shortcut()
                .on_shortcut("CmdOrCtrl+Shift+N", |app, _shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        wake_or_hide(app);
                    }
                })?;

            // The red traffic-light button is a real quit, unlike the window's
            // own close event (which only hides). The frontend flushes any
            // pending save synchronously before emitting this.
            let quit_handle = app.handle().clone();
            app.listen("gp://quit", move |_event| {
                quit_handle.exit(0);
            });

            let show_hide = MenuItem::with_id(app, "toggle", "Show/Hide", true, None::<&str>)?;
            let new_note = MenuItem::with_id(app, "new_note", "New note", true, None::<&str>)?;
            let autostart_enabled = app.autolaunch().is_enabled().unwrap_or(false);
            let autostart_item = CheckMenuItemBuilder::with_id("autostart", "Launch at Login")
                .checked(autostart_enabled)
                .build(app)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(
                app,
                &[
                    &show_hide,
                    &new_note,
                    &PredefinedMenuItem::separator(app)?,
                    &autostart_item,
                    &PredefinedMenuItem::separator(app)?,
                    &quit,
                ],
            )?;

            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .show_menu_on_left_click(true)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "toggle" => toggle_visibility(app),
                    "new_note" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                            let _ = window.emit("gp://new-note", ());
                        }
                    }
                    "autostart" => {
                        let mgr = app.autolaunch();
                        let enabled = mgr.is_enabled().unwrap_or(false);
                        let result = if enabled { mgr.disable() } else { mgr.enable() };
                        if let Err(err) = result {
                            eprintln!("autostart toggle failed: {err}");
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;

            // Only after the tray is confirmed working: with no dock icon and
            // a window that starts hidden or click-through, a broken tray is
            // the only way in or out of the app besides Activity Monitor.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
