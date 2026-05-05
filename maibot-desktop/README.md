# MaiBot Desktop

桌面控制台项目，目标是把 `MaiBot WebUI`、`NapCat WebUI` 和后续的进程管理、日志、重启、状态检测整合进一个 `React + Tauri` 应用。

## 当前进度

- 已创建 `React + TypeScript + Vite + Tauri v2` 工程
- 已接入首页控制台
- 已接入 `MaiBot WebUI` 和 `NapCat WebUI` 的内嵌入口
- 已接入浏览器兜底打开
- 已接入 Tauri Rust 命令：
  - `get_service_endpoints`
  - `open_external_url`

## 当前默认地址

- `MaiBot WebUI`: `http://127.0.0.1:8001`
- `NapCat WebUI`: `http://127.0.0.1:6099/webui`

界面里可以直接改地址，修改结果保存在浏览器本地存储里，方便调试不同端口。

## 开发命令

```powershell
npm install
npm run dev
npm run tauri:dev
```

构建：

```powershell
npm run build
npm run tauri:build
```

## 下一阶段

1. 把 MaiBot 主程序、NapCat、适配器做成可启动/可停止/可重启的本地进程模块
2. 自动探测服务端口和 NapCat token，而不是手填
3. 增加状态检测、日志查看、故障恢复中心
4. 逐步把浏览器里常用的操作迁到桌面原生界面
