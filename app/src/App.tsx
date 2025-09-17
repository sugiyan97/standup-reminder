import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

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
  const unsubRef = useRef<(() => void) | undefined>(undefined);

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
      if (!isTauriAvailable()) return;
      try {
        const [r, m] = await invoke<[boolean, number]>("get_status");
        setRunning(r);
        setMinutes(m);
      } catch (error) {
        console.error("Error calling get_status:", error);
      }
    },
    []
  );

  // Tauri イベント購読（tick / done）
  useEffect(() => {
    if (!isTauriAvailable()) return;

    let unlistenTick: any = null;
    let unlistenDone: any = null;

    const setupListeners = async () => {
      try {
        unlistenTick = await listen<[number, number]>("standup:tick", (event) => {
          const [elapsed, total] = event.payload;
          setElapsedDisplay(fmtMMSS(elapsed));
          setTotalDisplay(fmtMMSS(total));
        });

        unlistenDone = await listen("standup:done", async () => {
          try {
            const win = getCurrentWindow();
            await win.setAlwaysOnTop(true);
            await win.setFocus();
          } catch {}
          
          alert("Time to stand up and stretch!");
          
          try {
            const win = getCurrentWindow();
            await win.setAlwaysOnTop(false);
          } catch {}

          refresh();
        });
      } catch (error) {
        console.error("Error setting up event listeners:", error);
      }
    };

    setupListeners();

    return () => {
      try {
        if (typeof unlistenTick === 'function') unlistenTick();
        if (typeof unlistenDone === 'function') unlistenDone();
      } catch (error) {
        console.error("Error during cleanup:", error);
      }
    };
  }, [refresh]);

  // 変更をバックエンドへ反映 & 保存
  const apply = async () => {
    if (!isTauriAvailable()) return;
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
    if (!isTauriAvailable()) return;
    try {
      await apply();
      await invoke("start");
      await refresh();
    } catch (error) {
      console.error("Error starting timer:", error);
    }
  };

  // Stop：停止 & 次回のために保存分をバックエンドへ戻す
  const stop = async () => {
    if (!isTauriAvailable()) return;
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
    if (!isTauriAvailable()) return;
    try {
      await invoke("snooze");
      await refresh();
    } catch (error) {
      console.error("Error snoozing timer:", error);
    }
  };

  // 初回：保存 minutes を Rust 側へ同期
  useEffect(() => {
    if (!isTauriAvailable()) return;
    (async () => {
      try {
        await invoke("set_interval_minutes", { minutes });
        await refresh();
      } catch (error) {
        console.error("Error initializing:", error);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div style={{ padding: 24, fontFamily: "system-ui, sans-serif" }}>
      <h1>StandUp Reminder</h1>


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
      </div>

      {/* ステータス */}
      <div style={{ color: "#555", fontSize: 18, marginTop: 8 }}>
        <div>Now(JST): <span style={{ fontVariantNumeric: "tabular-nums" }}>{now}</span></div>
        <div style={{ marginTop: 6 }}>
          Status: Running = <b>{String(running)}</b> | Interval = <b>{minutes}</b> min
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
