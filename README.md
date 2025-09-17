# standup-reminder

## Install&Build

```shell
# Tauri CLI(v2) を入れる
$ cargo install tauri-cli@^2

# React + TS(Vite) のフロントを app/ に作成
$ pnpm create vite@latest app -- --template react-ts

# 必要な依存を追加 (Tauri v2)
$ pnpm -C app add @tauri-apps/api

# 依存を入れる
$ pnpm -C app install

# Rust 側をクリーン（念のため） Cargo.tomlがあるディレクトリに移動必須(何故？)
$ cd <targetFolder>
$ cargo clean

# 開発起動(Tauri が app の dev を呼ぶ)
$ cargo tauri dev

# 本番ビルド
$ cargo tauri build
```

## ⚠️ 重要な注意事項

**必ず `cargo tauri dev` でTauriアプリとして起動してください。**

❌ **間違った起動方法**: 
- `pnpm -C app dev` (これはブラウザ用)
- ブラウザで `http://localhost:5173/` にアクセス

✅ **正しい起動方法**:
- `cargo tauri dev` (これがTauriアプリを起動)

ブラウザで直接アクセスした場合、Tauri APIが利用できないため、タイマー機能は動作しません。
