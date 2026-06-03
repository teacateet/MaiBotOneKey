# TeaBot 飞牛 (fnOS) Docker 部署

用本仓库 `modules/` 源码构建三个容器：**core（本体）+ adapter（NapCat 适配器）+ napcat（QQ）**，跑在飞牛的 x86_64 上。

> 为什么不用官方公共镜像：本仓库本体是 `0.11.6` 且带 28 个自定义插件，与官方 `7.x` 公共镜像是两套代码，公共镜像跑不了你的配置和插件。故必须源码构建。

## 目录结构

```
deploy/fnos/
├── docker-compose.yml        # 三容器编排
├── Dockerfile.core           # 本体镜像（跳过 LPMM 编译，因 bot_config 已禁用 LPMM）
├── Dockerfile.adapter        # 适配器镜像
├── config/
│   ├── .env                  # 容器专用 env（HOST=0.0.0.0，区别于 Windows 单机版的 127.0.0.1）
│   └── adapter-config.toml   # 容器专用（host 指向服务名 core/napcat，非 localhost）
└── data/                     # 运行后自动生成，持久化配置与数据
```

## 首次部署步骤

1. 把整个仓库（至少 `modules/` 和 `deploy/`）拷到飞牛，例如 `/vol1/1000/teabot/`。

2. 准备 core 的配置（首次需要把你的 bot/model 配置放进挂载目录）：
   ```bash
   cd deploy/fnos
   mkdir -p data/core/config data/core/data data/core/logs data/adapter \
            data/napcat/config data/napcat/qq
   cp ../../modules/MaiBot/config/bot_config.toml   data/core/config/
   cp ../../modules/MaiBot/config/model_config.toml data/core/config/
   # 如本体 data 目录已有数据库要迁移，也一并 cp 到 data/core/data/
   ```

3. 构建并启动：
   ```bash
   docker compose up -d --build
   ```
   首次构建会装 Python 依赖，需几分钟。

4. **NapCat 扫码登录**：浏览器开 `http://<飞牛IP>:6099`，进 NapCat WebUI：
   - 扫码登录 bot QQ；
   - 在「网络配置」加一个 **WebSocket 服务器**（反向 ws 指向适配器）：地址 `ws://adapter:8095`，或按你 adapter 的 onebot 协议设置；
   - NapCat 的 onebot 端口对外是 6099，容器间通过服务名互连。

5. **TeaBot / MaiBot WebUI**：浏览器开 `http://<飞牛IP>:8001` 管理 bot。

## 端口对外映射

| 服务   | 容器端口 | 宿主端口 | 用途              |
|--------|----------|----------|-------------------|
| core   | 8001     | 8001     | TeaBot WebUI      |
| napcat | 6099     | 6099     | NapCat 扫码/WebUI |
| adapter| 8095     | 不暴露   | 仅容器内部互连    |

## 容器间网络（关键，与单机版不同）

容器内 `localhost` 不通，已在容器专用配置里改好：
- `config/.env`：`HOST=0.0.0.0`（让 adapter 能连进本体）
- `config/adapter-config.toml`：`maibot_server.host=core`、`napcat_server.host=napcat`

**不要**把这两份覆盖配置同步回 Windows 单机版——单机版仍用 `127.0.0.1`/`localhost`。

## 常用运维

```bash
docker compose logs -f core      # 看本体日志
docker compose logs -f adapter   # 看适配器连接日志
docker compose restart core      # 改完 data/core/config 配置后重启生效
docker compose down              # 停止
docker compose up -d --build     # 改了源码后重新构建
```

## 已知约束

- **架构**：x86_64/amd64。napcat 镜像 `mlikiowa/napcat-docker` 同时有 arm64，但本方案按 x86 验证。
- **LPMM**：当前 `bot_config.toml` 中 `lpmm_knowledge.enable=false`，镜像不编译 quick_algo。若日后启用 LPMM，需改 Dockerfile.core 增加 build-essential 并编译 quick_algo。
- **语音/Forge/Minecraft**：这些是 Windows 桌面端专属功能，不在容器部署范围内。
