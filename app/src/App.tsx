import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

// 環境判定関数
const getEnvironmentInfo = () => {
  const userAgent = navigator.userAgent;
  const location = window.location.href;
  const isTauriUA = userAgent.includes('tauri') || userAgent.includes('wry');
  const isTauriProtocol = location.startsWith('tauri://') || location.startsWith('https://tauri.localhost/');
  const hasTauriAPI = typeof window !== 'undefined' && (window as any).__TAURI__ !== undefined;
  const hasTauriInternals = typeof window !== 'undefined' && (window as any).__TAURI_INTERNALS__ !== undefined;
  
  return {
    userAgent,
    location,
    isTauriUA,
    isTauriProtocol,
    hasTauriAPI,
    hasTauriInternals,
    isLikelyTauri: isTauriUA || isTauriProtocol || hasTauriAPI || hasTauriInternals
  };
};

// Tauriの利用可能性チェック
const isTauriAvailable = () => {
  try {
    return typeof window !== 'undefined' && 
           (window as any).__TAURI__ !== undefined;
  } catch {
    return false;
  }
};

// 2桁ゼロ埋め
const pad2 = (n: number) => String(n).padStart(2, "0");

// 秒を "MM:SS" へ変換
const fmtMMSS = (sec: number) => {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${pad2(m)}:${pad2(s)}`;
};

// 前回の minutes を保存するキー（WebView ローカルストレージ）
const LS_KEY_DEFAULT_MINUTES = "defaultMinutes";

export default function App() {
  // ==== UI ステート ====
  const [running, setRunning] = useState<boolean>(false);
  const [minutes, setMinutes] = useState<number>(() => {
    const saved = Number(localStorage.getItem(LS_KEY_DEFAULT_MINUTES));
    return Number.isFinite(saved) && saved > 0 ? saved : 40;
  });
  const [now, setNow] = useState<string>(new Date().toLocaleTimeString());
  const [elapsedDisplay, setElapsedDisplay] = useState<string>("00:00");
  const [totalDisplay, setTotalDisplay] = useState<string>(fmtMMSS(minutes * 60));
  const [tauriError, setTauriError] = useState<string>("");
  const unsubRef = useRef<(() => void) | undefined>(undefined);

  // Tauriの利用可能性チェック（定期的にチェック）
  const [tauriReady, setTauriReady] = useState(false);
  
  useEffect(() => {
    let mounted = true;
    let checkCount = 0;
    
    const checkTauri = () => {
      checkCount++;
      console.log(`🔍 Tauri check #${checkCount}`);
      
      if (!mounted) return;
      
      if (!isTauriAvailable()) {
        console.error(`❌ Tauri API not available (check #${checkCount}). window.__TAURI__:`, (window as any).__TAURI__);
        if (checkCount >= 50) { // 5秒後にあきらめる
          setTauriError("Tauri API is not available. Please run this app in Tauri environment.");
        } else {
          // 100ms後に再チェック
          setTimeout(checkTauri, 100);
        }
      } else {
        console.log(`✅ Tauri API is available (check #${checkCount})`);
        console.log("window.__TAURI__:", (window as any).__TAURI__);
        setTauriError("");
        setTauriReady(true);
      }
    };
    
    // 即座にチェック
    checkTauri();
    
    return () => {
      mounted = false;
    };
  }, []);

  // minutes が変わったら total 表示を更新
  useEffect(() => {
    setTotalDisplay(fmtMMSS(minutes * 60));
  }, [minutes]);

  // 現在時刻（1秒毎に更新）
  useEffect(() => {
    const id = setInterval(() => setNow(new Date().toLocaleTimeString()), 1000);
    return () => clearInterval(id);
  }, []);

  // Rust 側の状態と同期
  const refresh = useMemo(
    () => async () => {
      if (!isTauriAvailable()) {
        console.error("Cannot call invoke: Tauri API not available");
        return;
      }
      try {
        // get_status -> [running, minutes]
        const [r, m] = await invoke<[boolean, number]>("get_status");
        setRunning(r);
        setMinutes(m); // バックエンド側（スヌーズ等）で変更された値もUIへ反映
      } catch (error) {
        console.error("Error calling get_status:", error);
      }
    },
    []
  );

  // Tauri イベント購読（tick / done）- tauriReadyをトリガーに
  useEffect(() => {
    console.log("🔄 useEffect called for event listeners, tauriReady:", tauriReady);
    
    if (!tauriReady || !isTauriAvailable()) {
      console.error("❌ Cannot set up event listeners: Tauri API not ready");
      console.log("tauriReady:", tauriReady, "isTauriAvailable:", isTauriAvailable());
      return;
    }

    console.log("✅ Tauri is available, setting up event listeners...");

    let unlistenTick: any = null;
    let unlistenDone: any = null;

    const setupListeners = async () => {
      try {
        console.log("🎯 Setting up tick listener for 'standup:tick'...");
        
        // まず基本的なテストイベントをリッスン
        try {
          unlistenTick = await listen<[number, number]>("standup:tick", (event) => {
            console.log("🚀 RAW EVENT RECEIVED:", event);
            const [elapsed, total] = event.payload;
            console.log("🎉 ✅ TICK EVENT RECEIVED:", { elapsed, total, eventType: event.event });
            console.log("🎉 Setting elapsedDisplay from", elapsedDisplay, "to", fmtMMSS(elapsed));
            setElapsedDisplay(fmtMMSS(elapsed));
            setTotalDisplay(fmtMMSS(total));
          });
          console.log("✅ Tick listener created:", typeof unlistenTick);
          (window as any).__TAURI_TICK_LISTENER__ = unlistenTick;
        } catch (tickError) {
          console.error("❌ Error setting up tick listener:", tickError);
          console.error("This might be a permission issue. Check tauri.conf.json capabilities.");
        }

        console.log("🎯 Setting up done listener for 'standup:done'...");
        try {
          unlistenDone = await listen("standup:done", async (event) => {
            console.log("🚀 DONE EVENT RECEIVED:", event);
            alert("Time to stand up and stretch!");
            // 状態同期
            if (isTauriAvailable()) {
              try {
                const [r, m] = await invoke<[boolean, number]>("get_status");
                setRunning(r);
                setMinutes(m);
              } catch (error) {
                console.error("Error refreshing status:", error);
              }
            }
          });
          console.log("✅ Done listener created:", typeof unlistenDone);
          (window as any).__TAURI_DONE_LISTENER__ = unlistenDone;
        } catch (doneError) {
          console.error("❌ Error setting up done listener:", doneError);
          console.error("This might be a permission issue. Check tauri.conf.json capabilities.");
        }

        // 最終状態確認
        console.log("📊 Final listener status:", {
          tickListener: typeof unlistenTick,
          doneListener: typeof unlistenDone,
          tickListenerValue: unlistenTick,
          doneListenerValue: unlistenDone
        });

      } catch (error) {
        console.error("❌ Critical error in setupListeners:", error);
      }
    };

    setupListeners();

    // クリーンアップ関数
    return () => {
      console.log("🧹 Cleaning up event listeners...");
      try {
        if (typeof unlistenTick === 'function') {
          console.log("🧹 Cleaning up tick listener");
          unlistenTick();
        }
        if (typeof unlistenDone === 'function') {
          console.log("🧹 Cleaning up done listener");
          unlistenDone();
        }
      } catch (error) {
        console.error("❌ Error during cleanup:", error);
      }
    };
  }, [tauriReady]);

  // 変更をバックエンドへ反映 & 保存
  const apply = async () => {
    if (!isTauriAvailable()) {
      console.error("Cannot call apply: Tauri API not available");
      return;
    }
    try {
      const m = Math.max(1, Math.floor(minutes));
      localStorage.setItem(LS_KEY_DEFAULT_MINUTES, String(m));
      await invoke("set_interval_minutes", { minutes: m });
      await refresh();
    } catch (error) {
      console.error("Error in apply:", error);
    }
  };

  // Start：現在の minutes を適用してから開始
  const start = async () => {
    if (!isTauriAvailable()) {
      console.error("Cannot start timer: Tauri API not available");
      return;
    }
    try {
      console.log("Starting timer...");
      await apply();
      console.log("Calling invoke('start')...");
      await invoke("start");
      console.log("Start command completed, refreshing...");
      await refresh();
      console.log("Timer started successfully");
    } catch (error) {
      console.error("Error starting timer:", error);
    }
  };

  // Stop：停止 & 次回のために保存分をバックエンドへ戻す
  const stop = async () => {
    if (!isTauriAvailable()) {
      console.error("Cannot stop timer: Tauri API not available");
      return;
    }
    try {
      await invoke("stop");
      const saved = Number(localStorage.getItem(LS_KEY_DEFAULT_MINUTES)) || 40;
      await invoke("set_interval_minutes", { minutes: saved });
      await refresh();
    } catch (error) {
      console.error("Error stopping timer:", error);
    }
  };

  // Snooze：5分固定（Rust 側で即開始）
  const snooze = async () => {
    if (!isTauriAvailable()) {
      console.error("Cannot snooze timer: Tauri API not available");
      return;
    }
    try {
      await invoke("snooze");
      await refresh();
    } catch (error) {
      console.error("Error snoozing timer:", error);
    }
  };

  // 初回：保存 minutes を Rust 側へ同期 - tauriReadyをトリガーに
  useEffect(() => {
    if (!tauriReady || !isTauriAvailable()) {
      console.log("Cannot initialize: Tauri API not ready yet, tauriReady:", tauriReady);
      return;
    }
    
    console.log("🚀 Initializing with Tauri API...");
    (async () => {
      try {
        await invoke("set_interval_minutes", { minutes });
        await refresh();
        console.log("✅ Initialization completed");
      } catch (error) {
        console.error("Error initializing:", error);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tauriReady]);

  return (
    <div style={{ padding: 24, fontFamily: "system-ui, sans-serif" }}>
      <h1>StandUp Reminder</h1>

      {/* 環境情報表示 */}
      {(() => {
        const envInfo = getEnvironmentInfo();
        return (
          <div style={{ 
            backgroundColor: envInfo.isLikelyTauri ? "#e8f5e8" : "#fff3e0", 
            color: envInfo.isLikelyTauri ? "#2e7d32" : "#ef6c00", 
            padding: 12, 
            marginBottom: 16, 
            borderRadius: 4,
            border: envInfo.isLikelyTauri ? "1px solid #c8e6c9" : "1px solid #ffcc02",
            fontSize: 14
          }}>
            <div><strong>🔍 実行環境:</strong></div>
            <div>URL: {envInfo.location}</div>
            <div>User Agent: {envInfo.userAgent.includes('tauri') ? '✅ Tauri' : '❌ 通常ブラウザ'}</div>
            <div>Tauri API: {envInfo.hasTauriAPI ? '✅ 利用可能' : '❌ 利用不可'}</div>
            <div>推定環境: {envInfo.isLikelyTauri ? '✅ Tauriアプリ' : '❌ ブラウザ'}</div>
            {!envInfo.isLikelyTauri && (
              <div style={{ marginTop: 8, fontWeight: 'bold' }}>
                ⚠️ このアプリはTauriアプリとして起動してください：<br/>
                <code>cargo tauri dev</code> または <code>pnpm tauri dev</code>
              </div>
            )}
          </div>
        );
      })()}

      {/* エラー表示 */}
      {tauriError && (
        <div style={{ 
          backgroundColor: "#ffebee", 
          color: "#c62828", 
          padding: 12, 
          marginBottom: 16, 
          borderRadius: 4,
          border: "1px solid #ffcdd2"
        }}>
          {tauriError}
        </div>
      )}

      {/* 設定行 */}
      <div style={{ marginBottom: 12 }}>
        <label htmlFor="interval" style={{ display: "inline-block", width: 180 }}>
          Interval (minutes)
        </label>
        <input
          id="interval"
          type="number"
          min={1}
          value={minutes}
          onChange={(e) => setMinutes(Number(e.target.value))}
          style={{ width: 80, marginRight: 8 }}
        />
        <button 
          onClick={apply} 
          style={{ padding: "8px 12px", marginRight: 8 }}
          disabled={!isTauriAvailable()}
        >
          Apply
        </button>
        <button 
          onClick={snooze} 
          style={{ padding: "8px 12px" }}
          disabled={!isTauriAvailable()}
        >
          Snooze 5 min
        </button>
      </div>

      {/* 操作行 */}
      <div style={{ marginBottom: 12 }}>
        <button 
          onClick={start} 
          style={{ padding: "8px 12px", marginRight: 8 }}
          disabled={!isTauriAvailable()}
        >
          Start
        </button>
        <button 
          onClick={stop} 
          style={{ padding: "8px 12px", marginRight: 8 }}
          disabled={!isTauriAvailable()}
        >
          Stop
        </button>
        <button 
          onClick={() => {
            console.log("Manual test: setting elapsedDisplay to 01:23");
            setElapsedDisplay("01:23");
          }} 
          style={{ padding: "8px 12px", fontSize: 12, marginRight: 8 }}
        >
          Test UI Update
        </button>
        <button 
          onClick={() => {
            console.log("🔍 === EVENT LISTENER CHECK ===");
            console.log("Tauri API available:", isTauriAvailable());
            console.log("window.__TAURI__:", (window as any).__TAURI__);
            console.log("Tick listener type:", typeof (window as any).__TAURI_TICK_LISTENER__);
            console.log("Done listener type:", typeof (window as any).__TAURI_DONE_LISTENER__);
            console.log("Tick listener value:", (window as any).__TAURI_TICK_LISTENER__);
            console.log("Done listener value:", (window as any).__TAURI_DONE_LISTENER__);
            console.log("Current elapsedDisplay:", elapsedDisplay);
            console.log("Current totalDisplay:", totalDisplay);
            console.log("Current running state:", running);
            console.log("=== END CHECK ===");
          }} 
          style={{ padding: "8px 12px", fontSize: 12 }}
        >
          Check Listeners
        </button>
        <button 
          onClick={async () => {
            if (!isTauriAvailable()) {
              console.log("❌ Cannot test event - Tauri not available");
              return;
            }
            try {
              console.log("🧪 Testing manual event emit...");
              // 手動でテストイベントを送信
              await invoke("test_emit_event");
              console.log("✅ Test event emit command sent");
            } catch (error) {
              console.error("❌ Error testing event emit:", error);
            }
          }} 
          style={{ padding: "8px 12px", fontSize: 12, marginLeft: 8 }}
          disabled={!isTauriAvailable()}
        >
          Test Event
        </button>
        <button 
          onClick={() => {
            console.log("🔄 Manually triggering event listener setup...");
            setTauriReady(false);
            setTimeout(() => {
              if (isTauriAvailable()) {
                setTauriReady(true);
                console.log("✅ Manually triggered tauriReady");
              }
            }, 100);
          }} 
          style={{ padding: "8px 12px", fontSize: 12, marginLeft: 8 }}
        >
          Retry Setup
        </button>
      </div>

      {/* ステータス */}
      <div style={{ color: "#555", fontSize: 18, marginTop: 8 }}>
        <div>Now(JST): <span style={{ fontVariantNumeric: "tabular-nums" }}>{now}</span></div>
        <div style={{ marginTop: 6 }}>
          Status: Running = <b>{String(running)}</b> | Interval = <b>{minutes}</b> min
        </div>
        <div style={{ marginTop: 6, fontSize: 14 }}>
          Debug: elapsedDisplay = "{elapsedDisplay}" | totalDisplay = "{totalDisplay}"
        </div>
        <div style={{ marginTop: 6, fontSize: 14 }}>
          Tauri Available: {isTauriAvailable() ? "✅" : "❌"}
        </div>
        <div
          style={{
            fontFamily:
              'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
            fontVariantNumeric: "tabular-nums",
            fontSize: 28,
            fontWeight: 700,
            marginTop: 12,
          }}
        >
          {/* 表示は「経過/合計」= mm:ss/mm:ss */}
          {elapsedDisplay}/{totalDisplay}
        </div>
      </div>
    </div>
  );
}
