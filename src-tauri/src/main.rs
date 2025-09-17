use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::time::{sleep, Duration};
use tauri::{AppHandle, Emitter, Manager};

#[derive(Clone)]
struct AppState {
    // カウントダウン中かどうか
    running: Arc<AtomicBool>,
    // 現在サイクルの合計秒（スヌーズ中は 300）
    interval_secs: Arc<AtomicU64>,
    // タイマー開始時刻（UNIXタイムスタンプ秒）
    start_time: Arc<AtomicU64>,
}

#[tauri::command]
async fn start(app: AppHandle) -> Result<(), String> {
    println!("Start command called");
    let state = app.state::<AppState>();
    // 現在時刻を開始時刻として記録
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs();
    state.start_time.store(now, Ordering::SeqCst);
    state.running.store(true, Ordering::SeqCst);
    println!("Timer started - running: true, start_time: {}", now);
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
    // 現在時刻を開始時刻として記録
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs();
    state.start_time.store(now, Ordering::SeqCst);
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

/// テスト用イベント送信
#[tauri::command]
async fn test_emit_event(app: AppHandle) -> Result<(), String> {
    println!("🧪 Test emit event command called");
    match app.emit("standup:tick", (99u64, 120u64)) {
        Ok(_) => {
            println!("✅ Successfully emitted test tick event: elapsed=99, total=120");
            Ok(())
        }
        Err(e) => {
            println!("❌ Error emitting test event: {:?}", e);
            Err(format!("Failed to emit test event: {:?}", e))
        }
    }
}

#[tokio::main]
async fn main() {
    tauri::Builder::default()
        .setup(|app| {
            // 初期：停止、40分
            let state = AppState {
                running: Arc::new(AtomicBool::new(false)),
                interval_secs: Arc::new(AtomicU64::new(40 * 60)),
                start_time: Arc::new(AtomicU64::new(0)),
            };
            app.manage(state.clone());

            // バックグラウンドで毎秒 tick を送る
            let app_handle = app.handle().clone();
            println!("Setting up background timer task...");
            tokio::spawn(async move {
                println!("✅ Background timer task started successfully");
                loop {
                    let is_running = state.running.load(Ordering::SeqCst);
                    if is_running {
                        let interval = state.interval_secs.load(Ordering::SeqCst);
                        let start_time = state.start_time.load(Ordering::SeqCst);
                        
                        // 現在時刻を取得して経過秒数を計算
                        let now = SystemTime::now()
                            .duration_since(UNIX_EPOCH)
                            .unwrap()
                            .as_secs();
                        let elapsed = now.saturating_sub(start_time);
                        
                        println!("Timer tick - elapsed: {}, total: {}, running: {}", elapsed, interval, is_running);
                        
                        // 経過/合計（秒）をフロントへ
                        match app_handle.emit("standup:tick", (elapsed, interval)) {
                            Ok(_) => println!("✅ Successfully emitted tick event: elapsed={}, total={}", elapsed, interval),
                            Err(e) => println!("❌ Error emitting tick event: {:?}", e),
                        }
                        
                        // 時間切れチェック
                        if elapsed >= interval {
                            state.running.store(false, Ordering::SeqCst);
                            println!("Timer completed, emitting done event");
                            if let Err(e) = app_handle.emit("standup:done", ()) {
                                println!("Error emitting done event: {:?}", e);
                            }
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
            get_status,
            test_emit_event
        ])
        .run(tauri::generate_context!()) // v2 では Context が必須
        .expect("error while running tauri app");
}
