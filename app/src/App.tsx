import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

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
  const unsubRef = useRef<() => void>();

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
      // get_status -> [running, minutes]
      const [r, m] = await invoke<[boolean, number]>("get_status");
      setRunning(r);
      setMinutes(m); // バックエンド側（スヌーズ等）で変更された値もUIへ反映
    },
    []
  );

  // Tauri イベント購読（tick / done）
  useEffect(() => {
    // 再購読時に解除するためのハンドラを一括保持
    unsubRef.current?.();

    const unlistenTick = listen<[number, number]>("standup:tick", (ev) => {
      const [elapsed, total] = ev.payload;
      setElapsedDisplay(fmtMMSS(elapsed));
      setTotalDisplay(fmtMMSS(total));
    });

    const unlistenDone = listen("standup:done", async () => {
      // ウィンドウを一瞬最前面にしてフォーカス後、Alert表示
      try {
        const win = getCurrentWindow();
        await win.setAlwaysOnTop(true);
        await win.setFocus();
      } catch {
        // 失敗しても Alert は出す
      }
      alert("Time to stand up and stretch!");
      try {
        const win = getCurrentWindow();
        await win.setAlwaysOnTop(false);
      } catch {}

      // Rust 側は停止済みなので最新状態を同期
      refresh();
    });

    unsubRef.current = async () => {
      (await unlistenTick)();
      (await unlistenDone)();
    };

    return () => {
      unsubRef.current?.();
    };
  }, [refresh]);

  // 変更をバックエンドへ反映 & 保存
  const apply = async () => {
    const m = Math.max(1, Math.floor(minutes));
    localStorage.setItem(LS_KEY_DEFAULT_MINUTES, String(m));
    await invoke("set_interval_minutes", { minutes: m });
    await refresh();
  };

  // Start：現在の minutes を適用してから開始
  const start = async () => {
    await apply();
    await invoke("start");
    await refresh();
  };

  // Stop：停止 & 次回のために保存分をバックエンドへ戻す
  const stop = async () => {
    await invoke("stop");
    const saved = Number(localStorage.getItem(LS_KEY_DEFAULT_MINUTES)) || 40;
    await invoke("set_interval_minutes", { minutes: saved });
    await refresh();
  };

  // Snooze：5分固定（Rust 側で即開始）
  const snooze = async () => {
    await invoke("snooze");
    await refresh();
  };

  // 初回：保存 minutes を Rust 側へ同期
  useEffect(() => {
    (async () => {
      await invoke("set_interval_minutes", { minutes });
      await refresh();
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
        <button onClick={apply} style={{ padding: "8px 12px", marginRight: 8 }}>
          Apply
        </button>
        <button onClick={snooze} style={{ padding: "8px 12px" }}>
          Snooze 5 min
        </button>
      </div>

      {/* 操作行 */}
      <div style={{ marginBottom: 12 }}>
        <button onClick={start} style={{ padding: "8px 12px", marginRight: 8 }}>
          Start
        </button>
        <button onClick={stop} style={{ padding: "8px 12px" }}>
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
