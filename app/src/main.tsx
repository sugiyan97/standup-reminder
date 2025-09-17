import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";

// デバッグ用: 詳細な環境チェック
console.log("🔍 main.tsx: Detailed environment check...");
console.log("window.__TAURI__:", (window as any).__TAURI__);
console.log("window.__TAURI_INTERNALS__:", (window as any).__TAURI_INTERNALS__);
console.log("User agent:", navigator.userAgent);
console.log("Location:", window.location.href);
console.log("Protocol:", window.location.protocol);
console.log("Host:", window.location.host);
console.log("Is likely Tauri:", 
  navigator.userAgent.includes('tauri') || 
  navigator.userAgent.includes('wry') ||
  window.location.protocol.startsWith('tauri') ||
  window.location.href.includes('tauri.localhost')
);

// Tauri環境の待機
function waitForTauri() {
  return new Promise<void>((resolve) => {
    if ((window as any).__TAURI__) {
      console.log("✅ Tauri API is immediately available");
      resolve();
      return;
    }
    
    console.log("⏳ Waiting for Tauri API to become available...");
    const checkInterval = setInterval(() => {
      if ((window as any).__TAURI__) {
        console.log("✅ Tauri API became available after waiting");
        clearInterval(checkInterval);
        resolve();
      }
    }, 100);
    
    // 5秒でタイムアウト
    setTimeout(() => {
      console.log("⚠️ Tauri API timeout - proceeding anyway");
      clearInterval(checkInterval);
      resolve();
    }, 5000);
  });
}

// Reactアプリの初期化
async function initApp() {
  await waitForTauri();
  console.log("🚀 Initializing React app...");
  
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
}

initApp();
