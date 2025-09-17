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
