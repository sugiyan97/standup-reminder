use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::time::{sleep, Duration};
use tauri::{AppHandle, Emitter, Manager};
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

#[tauri::command]
async fn start(app: AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    let configured = state.configured_secs.load(Ordering::SeqCst);
    state.current_cycle_secs.store(configured, Ordering::SeqCst);
    state.start_time.store(now_unix(), Ordering::SeqCst);
    state.running.store(true, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
async fn stop(app: AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    state.running.store(false, Ordering::SeqCst);
    // 現在サイクルの合計も設定インターバルへ戻す（スヌーズ後 stop しても 40 分表示に戻る）
    let configured = state.configured_secs.load(Ordering::SeqCst);
    state.current_cycle_secs.store(configured, Ordering::SeqCst);
    state.start_time.store(0, Ordering::SeqCst);
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

            // バックグラウンドで毎秒 tick を送る
            let app_handle = app.handle().clone();
            tokio::spawn(async move {
                loop {
                    let is_running = state.running.load(Ordering::SeqCst);
                    if is_running {
                        let cycle_secs = state.current_cycle_secs.load(Ordering::SeqCst);
                        let start_time = state.start_time.load(Ordering::SeqCst);
                        let elapsed = now_unix().saturating_sub(start_time);

                        // 経過/合計（秒）をフロントへ
                        let _ = app_handle.emit("standup:tick", (elapsed, cycle_secs));

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
