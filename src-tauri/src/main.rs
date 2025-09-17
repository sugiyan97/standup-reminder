use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use tokio::time::{sleep, Duration};
use tauri::{AppHandle, Emitter, Manager};

#[derive(Clone)]
struct AppState {
    // カウントダウン中かどうか
    running: Arc<AtomicBool>,
    // 現在サイクルの合計秒（スヌーズ中は 300）
    interval_secs: Arc<AtomicU64>,
}

#[tauri::command]
async fn start(app: AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    state.running.store(true, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
async fn stop(app: AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    state.running.store(false, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
async fn set_interval_minutes(app: AppHandle, minutes: u64) -> Result<(), String> {
    let state = app.state::<AppState>();
    let secs = minutes.max(1) * 60;
    state.interval_secs.store(secs, Ordering::SeqCst);
    Ok(())
}

/// 5分固定スヌーズ：現在サイクルを止め、300秒に設定して即再開
#[tauri::command]
async fn snooze(app: AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    state.running.store(false, Ordering::SeqCst);
    state.interval_secs.store(5 * 60, Ordering::SeqCst);
    state.running.store(true, Ordering::SeqCst);
    Ok(())
}

/// UI 初期同期用（running, minutes）
#[tauri::command]
async fn get_status(app: AppHandle) -> Result<(bool, u64), String> {
    let state = app.state::<AppState>();
    Ok((
        state.running.load(Ordering::SeqCst),
        state.interval_secs.load(Ordering::SeqCst) / 60,
    ))
}

#[tokio::main]
async fn main() {
    tauri::Builder::default()
        .setup(|app| {
            // 初期：停止、40分
            let state = AppState {
                running: Arc::new(AtomicBool::new(false)),
                interval_secs: Arc::new(AtomicU64::new(40 * 60)),
            };
            app.manage(state.clone());

            // バックグラウンドで毎秒 tick を送る
            let app_handle = app.handle().clone();
            tokio::spawn(async move {
                loop {
                    if state.running.load(Ordering::SeqCst) {
                        let interval = state.interval_secs.load(Ordering::SeqCst);
                        for sec in 0..=interval {
                            if !state.running.load(Ordering::SeqCst) {
                                break;
                            }
                            // 経過/合計（秒）をフロントへ
                            let _ = app_handle.emit("standup:tick", (sec, interval));
                            if sec == interval {
                                state.running.store(false, Ordering::SeqCst);
                                let _ = app_handle.emit("standup:done", ());
                            }
                            sleep(Duration::from_secs(1)).await;
                        }
                    } else {
                        sleep(Duration::from_secs(1)).await;
                    }
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
