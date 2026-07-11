use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::time::{sleep, Duration};
use tauri::{AppHandle, Emitter, Manager, WindowEvent};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri_plugin_notification::NotificationExt;

#[derive(Clone)]
struct AppState {
    // カウントダウン中かどうか
    running: Arc<AtomicBool>,
    // ユーザーが設定した本来のインターバル秒（スヌーズ中も変更しない）
    configured_secs: Arc<AtomicU64>,
    // 現在実行中のサイクルの合計秒（スヌーズ中は300、それ以外は configured_secs と同値）
    current_cycle_secs: Arc<AtomicU64>,
    // タイマー開始時刻（UNIXタイムスタンプ秒）
    start_time: Arc<AtomicU64>,
}

fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

// トレイメニューとコマンドの両方から呼べる共通ロジック
fn do_start(app: &AppHandle) {
    let state = app.state::<AppState>();
    let configured = state.configured_secs.load(Ordering::SeqCst);
    state.current_cycle_secs.store(configured, Ordering::SeqCst);
    state.start_time.store(now_unix(), Ordering::SeqCst);
    state.running.store(true, Ordering::SeqCst);
}

fn do_stop(app: &AppHandle) {
    let state = app.state::<AppState>();
    state.running.store(false, Ordering::SeqCst);
    // 現在サイクルの合計も設定インターバルへ戻す（スヌーズ後 stop しても 40 分表示に戻る）
    let configured = state.configured_secs.load(Ordering::SeqCst);
    state.current_cycle_secs.store(configured, Ordering::SeqCst);
    state.start_time.store(0, Ordering::SeqCst);
}

#[tauri::command]
async fn start(app: AppHandle) -> Result<(), String> {
    do_start(&app);
    Ok(())
}

#[tauri::command]
async fn stop(app: AppHandle) -> Result<(), String> {
    do_stop(&app);
    Ok(())
}

#[tauri::command]
async fn set_interval_minutes(app: AppHandle, minutes: u64) -> Result<(), String> {
    let state = app.state::<AppState>();
    let secs = minutes.max(1) * 60;
    state.configured_secs.store(secs, Ordering::SeqCst);
    // 実行中でなければ現在サイクルの長さにも即反映する
    if !state.running.load(Ordering::SeqCst) {
        state.current_cycle_secs.store(secs, Ordering::SeqCst);
    }
    Ok(())
}

/// 5分固定スヌーズ：設定インターバルには触れず、現在サイクルだけ 300 秒にして即再開
#[tauri::command]
async fn snooze(app: AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    state.current_cycle_secs.store(5 * 60, Ordering::SeqCst);
    state.start_time.store(now_unix(), Ordering::SeqCst);
    state.running.store(true, Ordering::SeqCst);
    Ok(())
}

/// UI 同期用（running, 設定インターバル分, 経過秒, 現在サイクルの合計秒）
#[tauri::command]
async fn get_status(app: AppHandle) -> Result<(bool, u64, u64, u64), String> {
    let state = app.state::<AppState>();
    let running = state.running.load(Ordering::SeqCst);
    let configured_minutes = state.configured_secs.load(Ordering::SeqCst) / 60;
    let cycle_secs = state.current_cycle_secs.load(Ordering::SeqCst);
    let elapsed = if running {
        now_unix().saturating_sub(state.start_time.load(Ordering::SeqCst))
    } else {
        0
    };
    Ok((running, configured_minutes, elapsed, cycle_secs))
}


#[tokio::main]
async fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            // 初期：停止、40分
            let state = AppState {
                running: Arc::new(AtomicBool::new(false)),
                configured_secs: Arc::new(AtomicU64::new(40 * 60)),
                current_cycle_secs: Arc::new(AtomicU64::new(40 * 60)),
                start_time: Arc::new(AtomicU64::new(0)),
            };
            app.manage(state.clone());

            // トレイメニュー：開く / Start / Stop / 残り時間表示 / 終了
            let open_item = MenuItem::with_id(app, "open", "開く", true, None::<&str>)?;
            let start_item = MenuItem::with_id(app, "start", "Start", true, None::<&str>)?;
            let stop_item = MenuItem::with_id(app, "stop", "Stop", true, None::<&str>)?;
            let remaining_item =
                MenuItem::with_id(app, "remaining", "残り時間: --:--", false, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "終了", true, None::<&str>)?;

            let tray_menu = Menu::with_items(
                app,
                &[
                    &open_item,
                    &PredefinedMenuItem::separator(app)?,
                    &start_item,
                    &stop_item,
                    &PredefinedMenuItem::separator(app)?,
                    &remaining_item,
                    &PredefinedMenuItem::separator(app)?,
                    &quit_item,
                ],
            )?;

            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&tray_menu)
                .show_menu_on_left_click(true)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "start" => do_start(app),
                    "stop" => do_stop(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;

            // ウィンドウを閉じてもプロセスは終了させず、非表示にするだけにする
            if let Some(window) = app.get_webview_window("main") {
                let window_to_hide = window.clone();
                window.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = window_to_hide.hide();
                    }
                });
            }

            // バックグラウンドで毎秒 tick を送る
            let app_handle = app.handle().clone();
            tokio::spawn(async move {
                loop {
                    let is_running = state.running.load(Ordering::SeqCst);
                    start_item.set_enabled(!is_running).ok();
                    stop_item.set_enabled(is_running).ok();

                    if is_running {
                        let cycle_secs = state.current_cycle_secs.load(Ordering::SeqCst);
                        let start_time = state.start_time.load(Ordering::SeqCst);
                        let elapsed = now_unix().saturating_sub(start_time);
                        let remaining = cycle_secs.saturating_sub(elapsed);

                        // 経過/合計（秒）をフロントへ
                        let _ = app_handle.emit("standup:tick", (elapsed, cycle_secs));
                        remaining_item
                            .set_text(format!(
                                "残り時間: {:02}:{:02}",
                                remaining / 60,
                                remaining % 60
                            ))
                            .ok();

                        // 時間切れチェック
                        if elapsed >= cycle_secs {
                            state.running.store(false, Ordering::SeqCst);
                            // 現在サイクルの合計を設定インターバルへ戻しておく
                            let configured = state.configured_secs.load(Ordering::SeqCst);
                            state.current_cycle_secs.store(configured, Ordering::SeqCst);
                            let _ = app_handle.emit("standup:done", ());

                            let _ = app_handle
                                .notification()
                                .builder()
                                .title("StandUp Reminder")
                                .body("Time to stand up and stretch!")
                                .show();
                        }
                    } else {
                        remaining_item.set_text("停止中").ok();
                    }

                    // 実行中でもそうでなくても1秒間隔でチェック
                    sleep(Duration::from_secs(1)).await;
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            start,
            stop,
            set_interval_minutes,
            snooze,
            get_status
        ])
        .run(tauri::generate_context!()) // v2 では Context が必須
        .expect("error while running tauri app");
}
