import type { ForgeBridgeCommandRequest, ServiceEndpoint, ServiceId } from "./types";

export const STORAGE_KEY = "maibot-desktop.service-urls";
export const PROCESS_POLL_INTERVAL_MS = 12000;
export const SCREEN_CONTEXT_POLL_INTERVAL_MS = 6000;
export const CONSOLE_AUTO_SCROLL_THRESHOLD_PX = 32;
export const PROCESS_LOG_RENDER_LIMIT = 240;
export const PROCESS_ORDER = [
  "maibot-main",
  "adapter",
  "napcat",
  "tts-api",
  "bilibili-live",
  "maicraft-next",
  "forge-client",
  "forge-agent",
];
export const OFFLINE_ALERT_LOG_WINDOW = 40;

export const NAPCAT_OFFLINE_KEYWORDS = [
  "被踢下线",
  "掉线",
  "网络错误",
  "连接错误",
  "重新连接",
  "重新登录",
  "登录态已失效",
  "用户身份已失效",
  "ecconnrefused",
  "无法建立连接",
  "远程计算机拒绝",
];

export const ADAPTER_OFFLINE_KEYWORDS = [
  "平台 qq 的连接已断开",
  "连接不可用",
  "自动重连失败",
  "发送消息失败",
  "请检查与maibot之间的连接",
  "无法建立连接",
  "online\":false",
];

export const SERVICE_IDS: ServiceId[] = ["maibot", "napcat"];

export const SERVICE_WINDOW_LABELS: Record<ServiceId, string> = {
  maibot: "service-window-maibot",
  napcat: "service-window-napcat",
};

export const NATIVE_WEBVIEW_DATA_DIRECTORIES: Record<ServiceId, string> = {
  maibot: "embedded/maibot",
  napcat: "embedded/napcat",
};

export const fallbackEndpoints: ServiceEndpoint[] = [
  {
    id: "maibot",
    name: "MaiBot WebUI",
    description: "主控制台。后面会继续接入配置管理、日志、插件、知识库和运行状态。",
    defaultUrl: "http://127.0.0.1:8001",
    troubleshootingTip: "如果嵌入页空白或卡住，直接点“浏览器打开”。",
  },
  {
    id: "napcat",
    name: "NapCat WebUI",
    description: "QQ 登录、网络配置、Token 和协议状态。适合扫码、掉线排查和底层连接修复。",
    defaultUrl: "http://127.0.0.1:6099/webui",
    troubleshootingTip: "NapCat 的 token 或端口可能变化，必要时先在这里改成当前地址。",
  },
];

export const FORGE_RESOURCE_SCAN_TARGETS =
  "log,stone,cobblestone,dirt,coal_ore,iron_ore,copper_ore,furnace";

export const FORGE_WOOD_TARGETS = [
  "minecraft:oak_log",
  "minecraft:birch_log",
  "minecraft:spruce_log",
  "minecraft:jungle_log",
  "minecraft:acacia_log",
  "minecraft:dark_oak_log",
  "minecraft:mangrove_log",
  "minecraft:cherry_log",
].join(",");

export const FORGE_STONE_TARGETS = "minecraft:stone,minecraft:cobblestone";

export const FORGE_SMELT_INPUTS = [
  "minecraft:raw_iron",
  "minecraft:raw_copper",
  "minecraft:raw_gold",
  "minecraft:sand",
  "minecraft:beef",
  "minecraft:porkchop",
  "minecraft:chicken",
  "minecraft:mutton",
  "minecraft:cod",
  "minecraft:salmon",
  "minecraft:potato",
].join(",");

export const FORGE_SMELT_FUELS = [
  "minecraft:coal",
  "minecraft:charcoal",
  "minecraft:oak_planks",
  "minecraft:birch_planks",
  "minecraft:spruce_planks",
  "minecraft:oak_log",
  "minecraft:birch_log",
  "minecraft:spruce_log",
].join(",");

export const FORGE_BUILD_BLOCKS =
  "minecraft:cobblestone,minecraft:stone,minecraft:dirt,minecraft:oak_planks";

export const FORGE_DEBUG_COMMANDS = {
  moveForward: { action: "move", forward: true, sprint: true, duration: 1200 },
  moveLeft: { action: "move", left: true, duration: 500 },
  moveRight: { action: "move", right: true, duration: 500 },
  jump: { action: "jump" },
  attack: { action: "attack" },
  mineWood: { action: "mine_nearest", targets: FORGE_WOOD_TARGETS, radius: 8, timeout: 35000 },
  mineStone: { action: "mine_nearest", targets: FORGE_STONE_TARGETS, radius: 8, timeout: 35000 },
  collectNearby: { action: "collect_nearby", timeout: 15000 },
  mineTunnel: { action: "mine_tunnel", length: 8, width: 1, height: 2, timeout: 120000 },
  smeltNearby: {
    action: "smelt_nearby",
    input: FORGE_SMELT_INPUTS,
    fuel: FORGE_SMELT_FUELS,
    radius: 6,
    timeout: 45000,
  },
  buildPlatform: {
    action: "build_platform",
    block: FORGE_BUILD_BLOCKS,
    width: 3,
    depth: 3,
    timeout: 60000,
  },
  buildWall: {
    action: "build_wall",
    block: FORGE_BUILD_BLOCKS,
    width: 3,
    height: 2,
    timeout: 60000,
  },
  ysmOpenMenu: { action: "ysm_open_menu" },
  ysmReload: { action: "ysm_reload" },
  stop: { action: "stop" },
} satisfies Record<string, ForgeBridgeCommandRequest>;
