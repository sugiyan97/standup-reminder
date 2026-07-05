import { useEffect, useMemo, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";

// 2桁ゼロ埋め
const pad2 = (n: number) => String(n).padStart(2, "0");

// 秒を "MM:SS" へ変換
const fmtMMSS = (sec: number) => {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${pad2(m)}:${pad2(s)}`;
};

// 分の文字列入力を検証し、無効なら fallback を返す
const parseMinutes = (text: string, fallback: number): number => {
  const parsed = Math.floor(Number(text));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

// 前回の minutes を保存するキー（WebView ローカルストレージ）
const LS_KEY_DEFAULT_MINUTES = "defaultMinutes";

async function notifyStandUp() {
  try {
    let granted = await isPermissionGranted();
    if (!granted) {
      granted = (await requestPermission()) === "granted";
    }
    if (granted) {
      sendNotification({
        title: "StandUp Reminder",
        body: "Time to stand up and stretch!",
      });
    }
  } catch (error) {
    console.error("Error sending notification:", error);
  }
}

export default function App() {
  // ==== UI ステート ====
  const [running, setRunning] = useState<boolean>(false);
  const [minutes, setMinutes] = useState<number>(() => {
    const saved = Number(localStorage.getItem(LS_KEY_DEFAULT_MINUTES));
    return Number.isFinite(saved) && saved > 0 ? saved : 40;
  });
  const [minutesText, setMinutesText] = useState<string>(() => String(minutes));
  const [now, setNow] = useState<string>(new Date().toLocaleTimeString());
  const [elapsedDisplay, setElapsedDisplay] = useState<string>("00:00");
  const [totalDisplay, setTotalDisplay] = useState<string>(fmtMMSS(minutes * 60));
  const [showDoneOverlay, setShowDoneOverlay] = useState<boolean>(false);
  const unsubRef = useRef<(() => void) | undefined>(undefined);

  // minutes が変わったら入力欄・total 表示を更新（実行中は現在サイクルの表示を優先し上書きしない）
  useEffect(() => {
    setMinutesText(String(minutes));
    if (!running) {
      setTotalDisplay(fmtMMSS(minutes * 60));
    }
  }, [minutes, running]);

  // 現在時刻（1秒毎に更新）
  useEffect(() => {
    const id = setInterval(() => setNow(new Date().toLocaleTimeString()), 1000);
    return () => clearInterval(id);
  }, []);

  // Rust 側の状態と同期
  const refresh = useMemo(
    () => async () => {
      if (!isTauri()) return;
      try {
        const [r, m, elapsed, total] = await invoke<[boolean, number, number, number]>(
          "get_status"
        );
        setRunning(r);
        setMinutes(m);
        setElapsedDisplay(fmtMMSS(elapsed));
        setTotalDisplay(fmtMMSS(total));
      } catch (error) {
        console.error("Error calling get_status:", error);
      }
    },
    []
  );

  // Tauri イベント購読（tick / done）
  useEffect(() => {
    if (!isTauri()) return;

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

          notifyStandUp();
          setShowDoneOverlay(true);

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

  const dismissDoneOverlay = async () => {
    setShowDoneOverlay(false);
    try {
      const win = getCurrentWindow();
      await win.setAlwaysOnTop(false);
    } catch {}
  };

  // 変更をバックエンドへ反映 & 保存
  const apply = async () => {
    if (!isTauri()) return;
    const m = parseMinutes(minutesText, minutes);
    setMinutes(m);
    setMinutesText(String(m));
    try {
      localStorage.setItem(LS_KEY_DEFAULT_MINUTES, String(m));
      await invoke("set_interval_minutes", { minutes: m });
      await refresh();
    } catch (error) {
      console.error("Error in apply:", error);
    }
  };

  // 入力欄からフォーカスが外れたら値を正規化する
  const commitMinutesInput = () => {
    const m = parseMinutes(minutesText, minutes);
    setMinutes(m);
    setMinutesText(String(m));
  };

  // Start：現在の minutes を適用してから開始
  const start = async () => {
    if (!isTauri()) return;
    try {
      await apply();
      await invoke("start");
      await refresh();
    } catch (error) {
      console.error("Error starting timer:", error);
    }
  };

  // Stop：停止（経過・現在サイクルはバックエンド側でリセットされる）
  const stop = async () => {
    if (!isTauri()) return;
    try {
      await invoke("stop");
      await refresh();
    } catch (error) {
      console.error("Error stopping timer:", error);
    }
  };

  // Snooze：5分固定（Rust 側で即開始、設定インターバルには影響しない）
  const snooze = async () => {
    if (!isTauri()) return;
    try {
      await invoke("snooze");
      await refresh();
      await dismissDoneOverlay();
    } catch (error) {
      console.error("Error snoozing timer:", error);
    }
  };

  // 初回：保存 minutes を Rust 側へ同期
  useEffect(() => {
    if (!isTauri()) return;
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
          value={minutesText}
          onChange={(e) => setMinutesText(e.target.value)}
          onBlur={commitMinutesInput}
          style={{ width: 80, marginRight: 8 }}
        />
        <button
          onClick={apply}
          style={{ padding: "8px 12px", marginRight: 8 }}
          disabled={!isTauri()}
        >
          Apply
        </button>
        <button
          onClick={snooze}
          style={{ padding: "8px 12px" }}
          disabled={!isTauri()}
        >
          Snooze 5 min
        </button>
      </div>

      {/* 操作行 */}
      <div style={{ marginBottom: 12 }}>
        <button
          onClick={start}
          style={{ padding: "8px 12px", marginRight: 8 }}
          disabled={!isTauri()}
        >
          Start
        </button>
        <button
          onClick={stop}
          style={{ padding: "8px 12px", marginRight: 8 }}
          disabled={!isTauri()}
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

      {/* タイマー満了時の非ブロッキングオーバーレイ */}
      {showDoneOverlay && (
        <div
          role="alertdialog"
          aria-label="Time to stand up"
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.6)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <div
            style={{
              background: "#fff",
              borderRadius: 8,
              padding: 24,
              minWidth: 280,
              textAlign: "center",
            }}
          >
            <h2 style={{ marginTop: 0 }}>Time to stand up and stretch!</h2>
            <div style={{ display: "flex", gap: 8, justifyContent: "center", marginTop: 16 }}>
              <button style={{ padding: "8px 12px" }} onClick={snooze}>
                Snooze 5 min
              </button>
              <button style={{ padding: "8px 12px" }} onClick={dismissDoneOverlay}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
