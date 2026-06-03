use base64::{engine::general_purpose, Engine as _};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::Value;
#[cfg(target_os = "windows")]
use std::os::windows::{ffi::OsStringExt, process::CommandExt};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    ffi::OsString,
    fs,
    io::{BufRead, BufReader, Read},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex, OnceLock,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const MAX_LOG_LINES: usize = 1200;
const SYSTEM_SCAN_CACHE_TTL: Duration = Duration::from_secs(15);
const VOICE_TEMP_MAX_AGE: Duration = Duration::from_secs(24 * 60 * 60);
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
static SHARED_ROOT: OnceLock<PathBuf> = OnceLock::new();
static DESKTOP_ROOT: OnceLock<PathBuf> = OnceLock::new();
static SYSTEM_SCAN_CACHE: OnceLock<Mutex<Option<SystemScan>>> = OnceLock::new();
static VOICE_TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

#[cfg(target_os = "windows")]
fn hide_command_window(command: &mut Command) {
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(target_os = "windows"))]
fn hide_command_window(_command: &mut Command) {}

fn system_scan_cache() -> &'static Mutex<Option<SystemScan>> {
    SYSTEM_SCAN_CACHE.get_or_init(|| Mutex::new(None))
}

fn invalidate_system_scan_cache() {
    if let Ok(mut cache) = system_scan_cache().lock() {
        *cache = None;
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ServiceEndpoint {
    id: String,
    name: String,
    description: String,
    default_url: String,
    troubleshooting_tip: String,
}

#[derive(Clone)]
struct ProcessSpec {
    id: &'static str,
    name: &'static str,
    description: &'static str,
    cwd: PathBuf,
    program: PathBuf,
    args: Vec<String>,
    listen_port: Option<u16>,
    issue: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ProcessSnapshot {
    id: String,
    name: String,
    description: String,
    cwd: String,
    program: String,
    args: Vec<String>,
    command_line: String,
    available: bool,
    issue: Option<String>,
    running: bool,
    pid: Option<u32>,
    managed_by_app: bool,
    running_externally: bool,
    status_note: Option<String>,
    log_lines: Vec<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct LoginStabilityProcess {
    pid: u32,
    name: String,
    executable_path: String,
    command_line: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct LoginStabilityReport {
    qq_account: Option<String>,
    normal_qq_processes: Vec<LoginStabilityProcess>,
    napcat_qq_processes: Vec<LoginStabilityProcess>,
    napcat_boot_processes: Vec<LoginStabilityProcess>,
    risk_messages: Vec<String>,
    status: String,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(default, rename_all = "camelCase")]
struct LoginHelperConfig {
    recipient_email: String,
    smtp_host: String,
    smtp_port: u16,
    smtp_username: String,
    smtp_password: String,
    smtp_from: String,
    smtp_use_ssl: bool,
}

impl Default for LoginHelperConfig {
    fn default() -> Self {
        Self {
            recipient_email: "2418749618@qq.com".to_string(),
            smtp_host: String::new(),
            smtp_port: 587,
            smtp_username: String::new(),
            smtp_password: String::new(),
            smtp_from: String::new(),
            smtp_use_ssl: true,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LoginHelperStatus {
    maibot_webui_url: String,
    maibot_access_token: String,
    napcat_webui_url: String,
    napcat_token: String,
    qq_account: Option<String>,
    mail_configured: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SendLoginEmailRequest {
    config: LoginHelperConfig,
    include_maibot: bool,
    include_napcat: bool,
}

struct ManagedProcess {
    child: Option<Child>,
    logs: Arc<Mutex<VecDeque<String>>>,
}

impl ManagedProcess {
    fn new() -> Self {
        Self {
            child: None,
            logs: Arc::new(Mutex::new(VecDeque::new())),
        }
    }
}

#[derive(Default)]
struct ProcessRegistry {
    handles: Mutex<HashMap<String, ManagedProcess>>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct MaicraftConfig {
    host: String,
    port: u16,
    version: String,
    username: String,
    auth: String,
    forge_modern: bool,
    keep_alive_timeout: u32,
    goal: String,
    forge_client_path: String,
}

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct ForgeBridgeCommandRequest {
    action: String,
    forward: Option<bool>,
    back: Option<bool>,
    left: Option<bool>,
    right: Option<bool>,
    sprint: Option<bool>,
    sneak: Option<bool>,
    duration: Option<u64>,
    yaw: Option<f32>,
    pitch: Option<f32>,
    targets: Option<String>,
    radius: Option<u16>,
    timeout: Option<u64>,
    x: Option<i32>,
    y: Option<i32>,
    z: Option<i32>,
    length: Option<u16>,
    width: Option<u16>,
    height: Option<u16>,
    depth: Option<u16>,
    input: Option<String>,
    fuel: Option<String>,
    block: Option<String>,
    search: Option<String>,
    model: Option<String>,
    model_id: Option<String>,
    texture: Option<String>,
    texture_id: Option<String>,
    target: Option<String>,
    ignore_auth: Option<bool>,
    command: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(default, rename_all = "camelCase")]
struct VoiceChatConfig {
    asr_api_key: String,
    asr_base_url: String,
    asr_transcription_path: String,
    asr_model: String,
    volc_asr_app_id: String,
    volc_asr_api_key: String,
    volc_asr_access_token: String,
    volc_asr_secret_key: String,
    volc_asr_submit_url: String,
    volc_asr_query_url: String,
    volc_asr_url: String,
    volc_asr_resource_id: String,
    volc_asr_model: String,
    tts_api_url: String,
    tts_ref_audio_path: String,
    tts_prompt_text: String,
    tts_prompt_lang: String,
    output_language: String,
    input_device_id: String,
    input_device_label_pattern: String,
    output_device_id: String,
    output_device_label_pattern: String,
    max_history_turns: usize,
    bilibili_room_id: String,
    live_danmaku_reply_enabled: bool,
    live_danmaku_cooldown_seconds: u64,
    game_event_voice_enabled: bool,
    game_event_voice_cooldown_seconds: u64,
}

impl Default for VoiceChatConfig {
    fn default() -> Self {
        Self {
            asr_api_key: String::new(),
            asr_base_url: "https://ark.cn-beijing.volces.com/api/v3".to_string(),
            asr_transcription_path: "/audio/transcriptions".to_string(),
            asr_model: "doubao-seed-asr-1-0".to_string(),
            volc_asr_app_id: String::new(),
            volc_asr_api_key: String::new(),
            volc_asr_access_token: String::new(),
            volc_asr_secret_key: String::new(),
            volc_asr_submit_url: "https://openspeech.bytedance.com/api/v3/auc/bigmodel/submit"
                .to_string(),
            volc_asr_query_url: "https://openspeech.bytedance.com/api/v3/auc/bigmodel/query"
                .to_string(),
            volc_asr_url: "https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash"
                .to_string(),
            volc_asr_resource_id: "volc.seedasr.auc".to_string(),
            volc_asr_model: "bigmodel".to_string(),
            tts_api_url: "http://127.0.0.1:9880/tts".to_string(),
            tts_ref_audio_path: String::new(),
            tts_prompt_text:
                "視線を少し下にずらすと、門が見えました。私はそこにほうきを向かわせます。"
                    .to_string(),
            tts_prompt_lang: "ja".to_string(),
            output_language: "zh".to_string(),
            input_device_id: String::new(),
            input_device_label_pattern: String::new(),
            output_device_id: String::new(),
            output_device_label_pattern: "CABLE Input".to_string(),
            max_history_turns: 8,
            bilibili_room_id: String::new(),
            live_danmaku_reply_enabled: false,
            live_danmaku_cooldown_seconds: 18,
            game_event_voice_enabled: false,
            game_event_voice_cooldown_seconds: 18,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct VoiceChatRequest {
    audio_base64: String,
    mime_type: String,
    config: VoiceChatConfig,
    screen_context: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct VoiceTextTurnRequest {
    text: String,
    source_label: Option<String>,
    config: VoiceChatConfig,
    screen_context: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct VoiceChatResponse {
    transcript: String,
    reply_text: String,
    audio_base64: String,
    audio_mime: String,
    asr_model: String,
    reply_model: String,
}

#[derive(Serialize, Deserialize, Clone)]
struct VoiceChatMessage {
    role: String,
    content: String,
}

#[derive(Default)]
struct VoiceChatState {
    history: Mutex<Vec<VoiceChatMessage>>,
}

#[derive(Clone, Deserialize)]
struct WindowsProcessInfo {
    #[serde(rename = "ProcessId")]
    process_id: u32,
    #[serde(rename = "Name")]
    name: Option<String>,
    #[serde(rename = "ExecutablePath")]
    executable_path: Option<String>,
    #[serde(rename = "CommandLine")]
    command_line: Option<String>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum PortOwnerKind {
    Expected,
    Unexpected,
}

struct PortOwner {
    pid: u32,
    label: String,
    kind: PortOwnerKind,
}

#[derive(Clone)]
struct SystemScan {
    collected_at: Instant,
    listening_pids: HashMap<u16, u32>,
    process_map: HashMap<u32, WindowsProcessInfo>,
}

fn source_onekey_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("E:/cha shi bot/MaiBotOneKey"))
}

fn executable_dir() -> Option<PathBuf> {
    std::env::current_exe()
        .ok()
        .as_deref()
        .and_then(Path::parent)
        .map(Path::to_path_buf)
}

fn looks_like_shared_root(path: &Path) -> bool {
    path.join("MaiBot-GitHub/bot.py").exists()
        || path.join("MaiBot-Standalone/MaiBot/bot.py").exists()
        || path.join("Git/GPT-SoVITS-V2").exists()
        || path.join("MaiBotOneKey").exists()
}

fn resolve_shared_root() -> PathBuf {
    if let Some(exe_dir) = executable_dir() {
        if looks_like_shared_root(&exe_dir) {
            return exe_dir;
        }

        for ancestor in exe_dir.ancestors() {
            if looks_like_shared_root(ancestor) {
                return ancestor.to_path_buf();
            }
        }
    }

    source_onekey_root()
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("E:/cha shi bot"))
}

fn shared_root() -> PathBuf {
    SHARED_ROOT.get_or_init(resolve_shared_root).clone()
}

fn resolve_desktop_root() -> PathBuf {
    let root = shared_root().join("MaiBotOneKey");
    if root.exists() {
        root
    } else {
        source_onekey_root()
    }
}

fn desktop_root() -> PathBuf {
    DESKTOP_ROOT.get_or_init(resolve_desktop_root).clone()
}

fn standalone_root() -> PathBuf {
    shared_root().join("MaiBot-Standalone")
}

fn standalone_maibot_root() -> PathBuf {
    standalone_root().join("MaiBot")
}

fn standalone_adapter_root() -> PathBuf {
    standalone_root().join("MaiBot-Napcat-Adapter")
}

fn standalone_napcat_root() -> PathBuf {
    standalone_root().join("NapCat")
}

fn onekey_maibot_root() -> PathBuf {
    desktop_root().join("modules/MaiBot")
}

fn onekey_adapter_root() -> PathBuf {
    desktop_root().join("modules/MaiBot-Napcat-Adapter")
}

fn onekey_napcat_root() -> PathBuf {
    desktop_root().join("modules/napcat")
}

fn maibot_root() -> PathBuf {
    let github_root = shared_root().join("MaiBot-GitHub");
    if standalone_maibot_root().join("bot.py").exists() {
        standalone_maibot_root()
    } else if github_root.join("bot.py").exists() {
        github_root
    } else {
        onekey_maibot_root()
    }
}

fn adapter_root() -> PathBuf {
    if standalone_adapter_root().join("main.py").exists() {
        standalone_adapter_root()
    } else {
        onekey_adapter_root()
    }
}

fn napcat_root() -> PathBuf {
    if standalone_napcat_root()
        .join("NapCatWinBootMain.exe")
        .exists()
    {
        standalone_napcat_root()
    } else {
        onekey_napcat_root()
    }
}

fn bilibili_live_adapter_root() -> PathBuf {
    standalone_root().join("MaiBot-Bilibili-Live-Adapter")
}

fn maicraft_next_root() -> PathBuf {
    standalone_root().join("Maicraft-Next")
}

fn adapter_python_root(adapter: &Path) -> PathBuf {
    let standalone_python = standalone_maibot_root().join("runtime/python31211/bin/python.exe");
    if adapter.starts_with(standalone_root()) && standalone_python.exists() {
        standalone_python
    } else {
        desktop_root().join("runtime/python31211/bin/python.exe")
    }
}

fn windows_powershell_path() -> PathBuf {
    let local_pwsh = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .map(|path| path.join("Programs/PowerShell/7/pwsh.exe"));
    if let Some(path) = local_pwsh {
        if path.exists() {
            return path;
        }
    }

    let program_files = std::env::var_os("ProgramFiles")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("C:/Program Files"));
    let pwsh = program_files.join("PowerShell/7/pwsh.exe");
    if pwsh.exists() {
        return pwsh;
    }

    std::env::var_os("SystemRoot")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("C:/Windows"))
        .join("System32/WindowsPowerShell/v1.0/powershell.exe")
}

fn node_exe_path() -> PathBuf {
    let program_files = std::env::var_os("ProgramFiles")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("C:/Program Files"));
    let node = program_files.join("nodejs/node.exe");
    if node.exists() {
        node
    } else {
        PathBuf::from("node.exe")
    }
}

fn read_qq_account() -> Option<String> {
    let config_path = maibot_root().join("config/bot_config.toml");
    let content = fs::read_to_string(config_path).ok()?;

    for line in content.lines() {
        let trimmed = line.trim();
        if !trimmed.starts_with("qq_account") {
            continue;
        }

        let value = trimmed.split('=').nth(1)?.trim();
        let digits: String = value.chars().filter(|ch| ch.is_ascii_digit()).collect();
        if !digits.is_empty() {
            return Some(digits);
        }
    }

    None
}

fn build_process_specs() -> Vec<ProcessSpec> {
    let maibot = maibot_root();
    let adapter = adapter_root();
    let napcat = napcat_root();
    let shared = shared_root();
    let maibot_python = maibot.join("runtime/python31211/bin/python.exe");
    let adapter_python = adapter_python_root(&adapter);
    let qq = read_qq_account();
    let tts_dir = shared.join("Git/GPT-SoVITS-V2");
    let tts_launcher = tts_dir.join("start_elaina_api.ps1");
    let powershell = windows_powershell_path();
    let bilibili_live = bilibili_live_adapter_root();
    let bilibili_live_config = bilibili_live.join("config.toml");
    let maicraft_next = maicraft_next_root();
    let node = node_exe_path();
    let maicraft_entry = maicraft_next.join("src/main.ts");
    let forge_agent_entry = maicraft_next.join("src/forge_bridge_agent.ts");
    let maicraft_tsx = maicraft_next.join("node_modules/tsx/dist/cli.mjs");
    let maicraft_config = maicraft_next.join("config.toml");
    let forge_client_path = load_maicraft_config_inner().forge_client_path;
    let forge_client_work_dir = if forge_client_path.trim().is_empty() {
        PathBuf::from("D:/mc/.minecraft/versions/1.20.1-Forge_47.4.20")
    } else {
        PathBuf::from(forge_client_path.trim())
    };
    let forge_client_launcher = standalone_root().join("launch_forge_client.ps1");

    let make_issue = |program: &Path, qq_required: bool| -> Option<String> {
        if !program.exists() {
            return Some(format!("找不到可执行文件: {}", program.display()));
        }
        if qq_required && qq.is_none() {
            return Some(format!(
                "未在 {} 中读到 qq_account",
                maibot.join("config/bot_config.toml").display()
            ));
        }
        None
    };

    let mut specs = vec![
        ProcessSpec {
            id: "maibot-main",
            name: "MaiBot 主程序",
            description: "对应原来启动 bot.py 的主窗口，负责 WebUI、主聊天逻辑和插件系统。",
            cwd: maibot.clone(),
            program: maibot_python.clone(),
            args: vec!["bot.py".to_string()],
            listen_port: Some(8001),
            issue: make_issue(&maibot_python, false),
        },
        ProcessSpec {
            id: "adapter",
            name: "NapCat Adapter",
            description: "对应原来的适配器窗口，负责 QQ 消息桥接和与 MaiBot 的链路。",
            cwd: adapter.clone(),
            program: adapter_python.clone(),
            args: vec!["main.py".to_string()],
            listen_port: Some(8095),
            issue: make_issue(&adapter_python, false),
        },
        ProcessSpec {
            id: "napcat",
            name: "NapCat 主程序",
            description: "对应原来的 NapCat 窗口，负责 QQ 登录、OneBot 和 NapCat WebUI。",
            cwd: napcat.clone(),
            program: napcat.join("NapCatWinBootMain.exe"),
            args: qq.clone().into_iter().collect(),
            listen_port: Some(6099),
            issue: make_issue(&napcat.join("NapCatWinBootMain.exe"), true),
        },
    ];

    specs.push(ProcessSpec {
        id: "tts-api",
        name: "GPT-SoVITS 语音API",
        description: "对应伊蕾娜语音合成窗口，负责本地 GPT-SoVITS 语音推理与 API 服务。",
        cwd: tts_dir.clone(),
        program: powershell.clone(),
        args: vec![
            "-NoProfile".to_string(),
            "-ExecutionPolicy".to_string(),
            "Bypass".to_string(),
            "-File".to_string(),
            tts_launcher.display().to_string(),
        ],
        listen_port: Some(9880),
        issue: if !powershell.exists() {
            Some(format!("找不到 PowerShell: {}", powershell.display()))
        } else if !tts_dir.exists() {
            Some(format!("找不到语音目录: {}", tts_dir.display()))
        } else if !tts_launcher.exists() {
            Some(format!("找不到语音启动脚本: {}", tts_launcher.display()))
        } else {
            None
        },
    });

    specs.push(ProcessSpec {
        id: "bilibili-live",
        name: "B站直播监听",
        description:
            "连接 B 站直播间，监听弹幕、礼物和进房事件。第一阶段只输出日志，不会影响 QQ 聊天链路。",
        cwd: bilibili_live.clone(),
        program: maibot_python.clone(),
        args: vec!["main.py".to_string()],
        listen_port: None,
        issue: if !maibot_python.exists() {
            Some(format!("找不到 Python: {}", maibot_python.display()))
        } else if !bilibili_live.exists() {
            Some(format!("找不到直播适配器目录: {}", bilibili_live.display()))
        } else if !bilibili_live.join("main.py").exists() {
            Some(format!(
                "找不到直播适配器入口: {}",
                bilibili_live.join("main.py").display()
            ))
        } else if !bilibili_live_config.exists() {
            Some(format!(
                "找不到直播适配器配置: {}",
                bilibili_live_config.display()
            ))
        } else {
            None
        },
    });

    specs.push(ProcessSpec {
        id: "maicraft-next",
        name: "Maicraft Next 协议Bot（轻量）",
        description: "轻量无界面协议 Bot，只适合原版、Paper、Spigot、Purpur 或兼容原版协议的服务器；需要 Forge/FML 握手的整合包服不能用它进入。",
        cwd: maicraft_next.clone(),
        program: node.clone(),
        args: vec![
            maicraft_tsx.display().to_string(),
            maicraft_entry.display().to_string(),
        ],
        listen_port: Some(25114),
        issue: if !node.exists() && node.file_name().and_then(|value| value.to_str()) != Some("node.exe") {
            Some(format!("找不到 Node.js: {}", node.display()))
        } else if !maicraft_next.exists() {
            Some(format!("找不到 Maicraft Next 目录: {}", maicraft_next.display()))
        } else if !maicraft_entry.exists() {
            Some(format!("找不到 Maicraft Next 入口: {}", maicraft_entry.display()))
        } else if !maicraft_tsx.exists() {
            Some("Maicraft Next 依赖未安装，请先在游戏模块执行 npm install。".to_string())
        } else if !maicraft_config.exists() {
            Some(format!("找不到 Maicraft Next 配置: {}", maicraft_config.display()))
        } else {
            None
        },
    });

    specs.push(ProcessSpec {
        id: "forge-client",
        name: "Minecraft Forge 真客户端",
        description: "启动 D:\\mc\\.minecraft\\versions\\1.20.1-Forge_47.4.20 这个真实 Forge 客户端，并直连当前游戏服务器。需要 Forge/FML 握手的整合包服只能走这个入口。",
        cwd: forge_client_work_dir.clone(),
        program: powershell.clone(),
        args: vec![
            "-NoProfile".to_string(),
            "-ExecutionPolicy".to_string(),
            "Bypass".to_string(),
            "-File".to_string(),
            forge_client_launcher.display().to_string(),
        ],
        listen_port: None,
        issue: if !powershell.exists() {
            Some(format!("找不到 PowerShell: {}", powershell.display()))
        } else if !forge_client_work_dir.exists() {
            Some(format!(
                "找不到 Forge 客户端目录: {}",
                forge_client_work_dir.display()
            ))
        } else if !forge_client_launcher.exists() {
            Some(format!(
                "找不到 Forge 客户端启动脚本: {}",
                forge_client_launcher.display()
            ))
        } else {
            None
        },
    });

    specs.push(ProcessSpec {
        id: "forge-agent",
        name: "Forge 控制AI",
        description:
            "等待 Forge 真客户端里的本地桥接端口上线，然后把移动、转向、聊天等动作发给真实客户端。",
        cwd: maicraft_next.clone(),
        program: node.clone(),
        args: vec![
            maicraft_tsx.display().to_string(),
            forge_agent_entry.display().to_string(),
        ],
        listen_port: None,
        issue: if !node.exists()
            && node.file_name().and_then(|value| value.to_str()) != Some("node.exe")
        {
            Some(format!("找不到 Node.js: {}", node.display()))
        } else if !maicraft_next.exists() {
            Some(format!(
                "找不到 Maicraft Next 目录: {}",
                maicraft_next.display()
            ))
        } else if !forge_agent_entry.exists() {
            Some(format!(
                "找不到 Forge 控制AI入口: {}",
                forge_agent_entry.display()
            ))
        } else if !maicraft_tsx.exists() {
            Some("Maicraft Next 依赖未安装，请先在游戏模块执行 npm install。".to_string())
        } else if !maicraft_config.exists() {
            Some(format!(
                "找不到 Maicraft Next 配置: {}",
                maicraft_config.display()
            ))
        } else {
            None
        },
    });

    specs
}

fn read_json_value(path: &Path) -> Option<Value> {
    fs::read_to_string(path)
        .ok()
        .and_then(|content| serde_json::from_str::<Value>(&content).ok())
}

fn read_toml_value(path: &Path) -> Option<toml::Value> {
    fs::read_to_string(path)
        .ok()
        .and_then(|content| toml::from_str::<toml::Value>(&content).ok())
}

fn voice_config_path() -> PathBuf {
    shared_root().join("maibot_desktop_voice.json")
}

fn login_helper_config_path() -> PathBuf {
    shared_root().join("maibot_desktop_login_helper.json")
}

fn bilibili_live_config_path() -> PathBuf {
    bilibili_live_adapter_root().join("config.toml")
}

fn maicraft_next_config_path() -> PathBuf {
    maicraft_next_root().join("config.toml")
}

fn tts_plugin_config_path() -> PathBuf {
    maibot_root().join("plugins/gpt_sovits_v2_tts_plugin/config.toml")
}

fn maibot_database_path() -> PathBuf {
    maibot_root().join("data/MaiBot.db")
}

fn toml_lookup<'a>(value: &'a toml::Value, path: &[&str]) -> Option<&'a toml::Value> {
    let mut current = value;
    for key in path {
        current = current.get(*key)?;
    }
    Some(current)
}

fn toml_string(value: &toml::Value, path: &[&str]) -> Option<String> {
    toml_lookup(value, path)
        .and_then(toml::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn toml_string_array(value: &toml::Value, path: &[&str]) -> Vec<String> {
    toml_lookup(value, path)
        .and_then(toml::Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(toml::Value::as_str)
                .map(str::trim)
                .filter(|item| !item.is_empty())
                .map(ToOwned::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

fn toml_f64(value: &toml::Value, path: &[&str]) -> Option<f64> {
    toml_lookup(value, path).and_then(|item| {
        item.as_float()
            .or_else(|| item.as_integer().map(|value| value as f64))
    })
}

fn toml_i64(value: &toml::Value, path: &[&str]) -> Option<i64> {
    toml_lookup(value, path).and_then(toml::Value::as_integer)
}

fn default_maicraft_config() -> MaicraftConfig {
    MaicraftConfig {
        host: "localhost".to_string(),
        port: 25565,
        version: "1.20.1".to_string(),
        username: "MaicraftBot".to_string(),
        auth: "offline".to_string(),
        forge_modern: true,
        keep_alive_timeout: 120_000,
        goal: "在 Minecraft 服务器里安全生存，并听从管理员指令".to_string(),
        forge_client_path: "D:/mc/.minecraft/versions/1.20.1-Forge_47.4.20".to_string(),
    }
}

fn split_maicraft_host_port(host: &str, fallback_port: u16) -> (String, u16) {
    let trimmed = host.trim();
    if let Some(without_prefix) = trimmed.strip_prefix('[') {
        if let Some((addr, port_part)) = without_prefix.split_once("]:") {
            if let Ok(port) = port_part.parse::<u16>() {
                if port > 0 {
                    return (addr.trim().to_string(), port);
                }
            }
        }
    }

    if trimmed.matches(':').count() != 1 {
        return (trimmed.to_string(), fallback_port);
    }

    let Some((host_part, port_part)) = trimmed.rsplit_once(':') else {
        return (trimmed.to_string(), fallback_port);
    };
    let Ok(port) = port_part.parse::<u16>() else {
        return (trimmed.to_string(), fallback_port);
    };
    if port == 0 || host_part.trim().is_empty() {
        return (trimmed.to_string(), fallback_port);
    }

    (host_part.trim().to_string(), port)
}

fn normalize_maicraft_config_address(config: &mut MaicraftConfig) {
    let (host, port) = split_maicraft_host_port(&config.host, config.port);
    config.host = host;
    config.port = port;
}

fn load_maicraft_config_inner() -> MaicraftConfig {
    let mut config = default_maicraft_config();
    if let Some(root) = read_toml_value(&maicraft_next_config_path()) {
        if let Some(value) = toml_string(&root, &["minecraft", "host"]) {
            config.host = value;
        }
        if let Some(value) = toml_i64(&root, &["minecraft", "port"]) {
            if (1..=65535).contains(&value) {
                config.port = value as u16;
            }
        }
        if let Some(value) = toml_string(&root, &["minecraft", "username"]) {
            config.username = value;
        }
        if let Some(value) = toml_string(&root, &["minecraft", "version"]) {
            config.version = value;
        }
        if let Some(value) = toml_string(&root, &["minecraft", "auth"]) {
            config.auth = value;
        }
        if let Some(value) =
            toml_lookup(&root, &["minecraft", "forge_modern"]).and_then(toml::Value::as_bool)
        {
            config.forge_modern = value;
        }
        if let Some(value) = toml_i64(&root, &["minecraft", "keep_alive_timeout"]) {
            if (30_000..=600_000).contains(&value) {
                config.keep_alive_timeout = value as u32;
            }
        }
        if let Some(value) = toml_string(&root, &["agent", "goal"]) {
            config.goal = value;
        }
        if let Some(value) = toml_string(&root, &["forge", "client_path"]) {
            config.forge_client_path = value;
        }
    }
    normalize_maicraft_config_address(&mut config);
    config
}

fn ensure_toml_table<'a>(
    table: &'a mut toml::map::Map<String, toml::Value>,
    key: &str,
) -> Result<&'a mut toml::map::Map<String, toml::Value>, String> {
    let value = table
        .entry(key.to_string())
        .or_insert_with(|| toml::Value::Table(toml::map::Map::new()));
    if !value.is_table() {
        *value = toml::Value::Table(toml::map::Map::new());
    }
    value
        .as_table_mut()
        .ok_or_else(|| format!("Maicraft 配置段 [{key}] 结构无效。"))
}

fn save_maicraft_config_inner(mut config: MaicraftConfig) -> Result<MaicraftConfig, String> {
    config.host = config.host.trim().to_string();
    config.version = config.version.trim().to_string();
    config.username = config.username.trim().to_string();
    config.auth = config.auth.trim().to_ascii_lowercase();
    config.goal = config.goal.trim().to_string();
    config.forge_client_path = config.forge_client_path.trim().to_string();
    normalize_maicraft_config_address(&mut config);

    if config.host.is_empty() {
        return Err("Minecraft 服务器地址不能为空。".to_string());
    }
    if config.port == 0 {
        return Err("Minecraft 端口必须在 1 到 65535 之间。".to_string());
    }
    if config.username.is_empty() {
        return Err("Bot 游戏名不能为空。".to_string());
    }
    if !matches!(config.auth.as_str(), "offline" | "mojang" | "microsoft") {
        return Err("登录模式只能是 offline、mojang 或 microsoft。".to_string());
    }
    if config.goal.is_empty() {
        config.goal = default_maicraft_config().goal;
    }
    config.keep_alive_timeout = config.keep_alive_timeout.clamp(30_000, 600_000);

    let path = maicraft_next_config_path();
    let content = fs::read_to_string(&path).unwrap_or_default();
    let mut root = content
        .parse::<toml::Value>()
        .unwrap_or_else(|_| toml::Value::Table(toml::map::Map::new()));

    if !root.is_table() {
        root = toml::Value::Table(toml::map::Map::new());
    }

    let table = root
        .as_table_mut()
        .ok_or_else(|| "Maicraft 配置结构无效。".to_string())?;
    let minecraft = ensure_toml_table(table, "minecraft")?;
    minecraft.insert("host".to_string(), toml::Value::String(config.host.clone()));
    minecraft.insert(
        "port".to_string(),
        toml::Value::Integer(i64::from(config.port)),
    );
    minecraft.insert(
        "version".to_string(),
        toml::Value::String(config.version.clone()),
    );
    minecraft.insert(
        "username".to_string(),
        toml::Value::String(config.username.clone()),
    );
    minecraft.insert("auth".to_string(), toml::Value::String(config.auth.clone()));
    minecraft.insert(
        "forge_modern".to_string(),
        toml::Value::Boolean(config.forge_modern),
    );
    minecraft.insert(
        "keep_alive_timeout".to_string(),
        toml::Value::Integer(i64::from(config.keep_alive_timeout)),
    );
    minecraft
        .entry("forge_fml_version".to_string())
        .or_insert_with(|| toml::Value::String("FML3".to_string()));
    minecraft
        .entry("forge_mirror_server_mods".to_string())
        .or_insert(toml::Value::Boolean(true));
    minecraft
        .entry("forge_mirror_server_channels".to_string())
        .or_insert(toml::Value::Boolean(true));
    minecraft
        .entry("forge_extra_mods".to_string())
        .or_insert_with(|| toml::Value::Array(Vec::new()));
    minecraft
        .entry("forge_extra_channels".to_string())
        .or_insert_with(|| toml::Value::Table(toml::map::Map::new()));

    let agent = ensure_toml_table(table, "agent")?;
    agent.insert("goal".to_string(), toml::Value::String(config.goal.clone()));

    if !config.forge_client_path.is_empty() {
        let forge = ensure_toml_table(table, "forge")?;
        forge.insert(
            "client_path".to_string(),
            toml::Value::String(config.forge_client_path.clone()),
        );
    }

    let updated =
        toml::to_string_pretty(&root).map_err(|err| format!("序列化 Maicraft 配置失败: {err}"))?;
    fs::write(&path, updated).map_err(|err| format!("写入 Maicraft 配置失败: {err}"))?;
    Ok(config)
}

fn default_voice_chat_config() -> VoiceChatConfig {
    let mut config = VoiceChatConfig::default();
    if let Some(tts_config) = read_toml_value(&tts_plugin_config_path()) {
        if let Some(value) = toml_string(&tts_config, &["vits", "api_url"]) {
            config.tts_api_url = value;
        }
        if let Some(value) = toml_string(&tts_config, &["vits", "ref_audio_path"]) {
            config.tts_ref_audio_path = value;
        }
        if let Some(value) = toml_string(&tts_config, &["vits", "prompt_text"]) {
            config.tts_prompt_text = value;
        }
        if let Some(value) = toml_string(&tts_config, &["vits", "prompt_lang"]) {
            config.tts_prompt_lang = value;
        }
    }
    if let Some(live_config) = read_toml_value(&bilibili_live_config_path()) {
        if let Some(room_id) = toml_i64(&live_config, &["bilibili", "room_id"]) {
            if room_id > 0 {
                config.bilibili_room_id = room_id.to_string();
            }
        }
    }
    config.output_language = "zh".to_string();
    config
}

fn load_voice_chat_config_inner() -> VoiceChatConfig {
    let path = voice_config_path();
    if let Ok(content) = fs::read_to_string(&path) {
        if let Ok(mut config) = serde_json::from_str::<VoiceChatConfig>(&content) {
            if config.asr_base_url.trim().is_empty() {
                config.asr_base_url = VoiceChatConfig::default().asr_base_url;
            }
            if config.asr_transcription_path.trim().is_empty() {
                config.asr_transcription_path = VoiceChatConfig::default().asr_transcription_path;
            }
            if config.asr_model.trim().is_empty() {
                config.asr_model = VoiceChatConfig::default().asr_model;
            }
            if config.volc_asr_url.trim().is_empty() {
                config.volc_asr_url = VoiceChatConfig::default().volc_asr_url;
            }
            if config.volc_asr_submit_url.trim().is_empty() {
                config.volc_asr_submit_url = VoiceChatConfig::default().volc_asr_submit_url;
            }
            if config.volc_asr_query_url.trim().is_empty() {
                config.volc_asr_query_url = VoiceChatConfig::default().volc_asr_query_url;
            }
            if config.volc_asr_resource_id.trim().is_empty() {
                config.volc_asr_resource_id = VoiceChatConfig::default().volc_asr_resource_id;
            }
            if config.volc_asr_model.trim().is_empty() {
                config.volc_asr_model = VoiceChatConfig::default().volc_asr_model;
            }
            if config.tts_api_url.trim().is_empty() {
                config.tts_api_url = default_voice_chat_config().tts_api_url;
            }
            if config.output_language.trim().is_empty() {
                config.output_language = "zh".to_string();
            }
            if config.input_device_id.trim().is_empty() {
                config.input_device_id = String::new();
            }
            if config.output_device_id.trim().is_empty() {
                config.output_device_id = String::new();
            }
            if config.output_device_label_pattern.trim().is_empty() {
                config.output_device_label_pattern =
                    VoiceChatConfig::default().output_device_label_pattern;
            }
            if config.max_history_turns == 0 {
                config.max_history_turns = 8;
            }
            if config.live_danmaku_cooldown_seconds == 0 {
                config.live_danmaku_cooldown_seconds = 18;
            }
            if config.game_event_voice_cooldown_seconds == 0 {
                config.game_event_voice_cooldown_seconds = 18;
            }
            if config.bilibili_room_id.trim().is_empty() {
                if let Some(live_config) = read_toml_value(&bilibili_live_config_path()) {
                    if let Some(room_id) = toml_i64(&live_config, &["bilibili", "room_id"]) {
                        if room_id > 0 {
                            config.bilibili_room_id = room_id.to_string();
                        }
                    }
                }
            }
            return config;
        }
    }
    default_voice_chat_config()
}

fn save_voice_chat_config_inner(config: &VoiceChatConfig) -> Result<(), String> {
    let content =
        serde_json::to_string_pretty(config).map_err(|err| format!("序列化语音配置失败: {err}"))?;
    fs::write(voice_config_path(), content).map_err(|err| format!("写入语音配置失败: {err}"))?;
    sync_bilibili_live_config(config)?;
    Ok(())
}

fn load_login_helper_config_inner() -> LoginHelperConfig {
    let path = login_helper_config_path();
    if let Ok(content) = fs::read_to_string(&path) {
        if let Ok(mut config) = serde_json::from_str::<LoginHelperConfig>(&content) {
            if config.recipient_email.trim().is_empty() {
                config.recipient_email = LoginHelperConfig::default().recipient_email;
            }
            if config.smtp_port == 0 {
                config.smtp_port = LoginHelperConfig::default().smtp_port;
            }
            return config;
        }
    }
    LoginHelperConfig::default()
}

fn save_login_helper_config_inner(config: &LoginHelperConfig) -> Result<(), String> {
    let mut normalized = config.clone();
    normalized.recipient_email = normalize_owner_email(&normalized.recipient_email);
    if normalized.smtp_from.trim().is_empty() && !normalized.smtp_username.trim().is_empty() {
        normalized.smtp_from = normalized.smtp_username.trim().to_string();
    }
    if normalized.smtp_port == 0 {
        normalized.smtp_port = LoginHelperConfig::default().smtp_port;
    }

    let content = serde_json::to_string_pretty(&normalized)
        .map_err(|err| format!("序列化登录助手配置失败: {err}"))?;
    fs::write(login_helper_config_path(), content)
        .map_err(|err| format!("写入登录助手配置失败: {err}"))?;
    Ok(())
}

fn sync_bilibili_live_config(config: &VoiceChatConfig) -> Result<(), String> {
    let room_id_text = config.bilibili_room_id.trim();
    if room_id_text.is_empty() {
        return Ok(());
    }
    let room_id = room_id_text
        .parse::<i64>()
        .map_err(|_| "B站房间号必须是数字。".to_string())?;
    if room_id <= 0 {
        return Err("B站房间号必须大于 0。".to_string());
    }

    let path = bilibili_live_config_path();
    if !path.exists() {
        return Ok(());
    }
    let content =
        fs::read_to_string(&path).map_err(|err| format!("读取直播适配器配置失败: {err}"))?;
    let mut root = content
        .parse::<toml::Value>()
        .unwrap_or_else(|_| toml::Value::Table(toml::map::Map::new()));

    if !root.is_table() {
        root = toml::Value::Table(toml::map::Map::new());
    }
    let table = root
        .as_table_mut()
        .ok_or_else(|| "直播适配器配置结构无效。".to_string())?;
    let bilibili = table
        .entry("bilibili".to_string())
        .or_insert_with(|| toml::Value::Table(toml::map::Map::new()));
    if !bilibili.is_table() {
        *bilibili = toml::Value::Table(toml::map::Map::new());
    }
    bilibili
        .as_table_mut()
        .ok_or_else(|| "直播适配器 bilibili 配置结构无效。".to_string())?
        .insert("room_id".to_string(), toml::Value::Integer(room_id));

    let updated =
        toml::to_string_pretty(&root).map_err(|err| format!("序列化直播适配器配置失败: {err}"))?;
    fs::write(&path, updated).map_err(|err| format!("写入直播适配器配置失败: {err}"))
}

fn strip_data_url_prefix(value: &str) -> &str {
    value
        .split_once(',')
        .map(|(_, encoded)| encoded)
        .unwrap_or(value)
}

fn unique_voice_temp_path(extension: &str) -> PathBuf {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default();
    let sequence = VOICE_TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    std::env::temp_dir()
        .join("maibot-desktop-voice")
        .join(format!(
            "voice-{millis}-{}-{sequence}.{extension}",
            std::process::id()
        ))
}

fn cleanup_stale_voice_temp_files(temp_dir: &Path) {
    let Ok(entries) = fs::read_dir(temp_dir) else {
        return;
    };
    let now = SystemTime::now();

    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        if !name.starts_with("voice-") {
            continue;
        }
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        let Ok(modified) = metadata.modified() else {
            continue;
        };
        if now
            .duration_since(modified)
            .map(|age| age > VOICE_TEMP_MAX_AGE)
            .unwrap_or(false)
        {
            let _ = fs::remove_file(path);
        }
    }
}

fn audio_extension_from_mime(mime_type: &str) -> &'static str {
    let lowered = mime_type.to_ascii_lowercase();
    if lowered.contains("wav") {
        "wav"
    } else if lowered.contains("ogg") {
        "ogg"
    } else if lowered.contains("mp4") || lowered.contains("m4a") {
        "m4a"
    } else {
        "webm"
    }
}

fn ffmpeg_path() -> PathBuf {
    let shared = shared_root();
    let candidates = [
        shared.join("Git/GPT-SoVITS-V2/runtime/ffmpeg.exe"),
        shared.join("_tmp/gpt_sovits_extract/GPT-SoVITS-v2pro-20250604/runtime/ffmpeg.exe"),
        shared.join("Git/GPT-SoVITS-V2/ffmpeg.exe"),
    ];
    candidates
        .into_iter()
        .find(|path| path.exists())
        .unwrap_or_else(|| PathBuf::from("ffmpeg"))
}

fn convert_audio_to_wav(audio_bytes: &[u8], mime_type: &str) -> Result<Vec<u8>, String> {
    let temp_dir = std::env::temp_dir().join("maibot-desktop-voice");
    fs::create_dir_all(&temp_dir).map_err(|err| format!("创建临时目录失败: {err}"))?;
    cleanup_stale_voice_temp_files(&temp_dir);

    let input_path = unique_voice_temp_path(audio_extension_from_mime(mime_type));
    let output_path = unique_voice_temp_path("wav");
    fs::write(&input_path, audio_bytes).map_err(|err| format!("写入录音临时文件失败: {err}"))?;

    let mut command = Command::new(ffmpeg_path());
    hide_command_window(&mut command);
    let output = command
        .args([
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            &input_path.display().to_string(),
            "-vn",
            "-ac",
            "1",
            "-ar",
            "16000",
            &output_path.display().to_string(),
        ])
        .output()
        .map_err(|err| format!("调用 ffmpeg 转码失败: {err}"))?;

    let _ = fs::remove_file(&input_path);

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let _ = fs::remove_file(&output_path);
        return Err(if stderr.is_empty() {
            "ffmpeg 转码失败，没有返回详细错误。".to_string()
        } else {
            format!("ffmpeg 转码失败: {stderr}")
        });
    }

    let wav_audio = fs::read(&output_path).map_err(|err| format!("读取 WAV 文件失败: {err}"))?;
    let _ = fs::remove_file(&output_path);
    if wav_audio.is_empty() {
        return Err("录音转码后为空，请确认麦克风有输入。".to_string());
    }
    Ok(wav_audio)
}

fn normalize_api_url(base_url: &str, endpoint: &str) -> String {
    let base = base_url.trim().trim_end_matches('/');
    if base.ends_with(endpoint) {
        base.to_string()
    } else {
        format!("{base}{endpoint}")
    }
}

fn language_display(language: &str) -> &'static str {
    match language {
        "ja" => "日语",
        "en" => "英语",
        _ => "中文",
    }
}

fn build_voice_system_prompt(output_language: &str) -> String {
    let bot_config_path = maibot_root().join("config/bot_config.toml");
    let bot_config = read_toml_value(&bot_config_path);
    let nickname = bot_config
        .as_ref()
        .and_then(|value| toml_string(value, &["bot", "nickname"]))
        .unwrap_or_else(|| "茶夕莳".to_string());
    let aliases = bot_config
        .as_ref()
        .map(|value| toml_string_array(value, &["bot", "alias_names"]))
        .unwrap_or_default();
    let personality = bot_config
        .as_ref()
        .and_then(|value| toml_string(value, &["personality", "personality"]))
        .unwrap_or_else(|| "你是一个正在和用户语音对话的AI。".to_string());
    let reply_style = bot_config
        .as_ref()
        .and_then(|value| toml_string(value, &["personality", "reply_style"]))
        .unwrap_or_else(|| "回复自然、简短、口语化。".to_string());
    let alias_text = if aliases.is_empty() {
        String::new()
    } else {
        format!("，也有人叫你{}", aliases.join("、"))
    };

    format!(
        "你的名字是{nickname}{alias_text}。{personality}\n\
        你现在正在桌面端和用户进行实时语音对话，不是在QQ群里发消息。\n\
        说话风格：{reply_style}\n\
        输出语言：{}。\n\
        要求：只输出要说出口的内容；口语、自然、简短；不要输出 Markdown、列表、前后缀、引号、表情包标记或动作说明。",
        language_display(output_language)
    )
}

fn bot_nickname() -> String {
    read_toml_value(&maibot_root().join("config/bot_config.toml"))
        .and_then(|value| toml_string(&value, &["bot", "nickname"]))
        .unwrap_or_else(|| "茶夕莳".to_string())
}

#[derive(Clone)]
struct ReplyModelConfig {
    base_url: String,
    api_key: String,
    wire_api: String,
    model_identifier: String,
    model_name: String,
    temperature: f64,
    max_tokens: i64,
}

fn resolve_reply_model_config() -> Result<ReplyModelConfig, String> {
    let config_path = maibot_root().join("config/model_config.toml");
    let root = read_toml_value(&config_path)
        .ok_or_else(|| format!("无法读取模型配置: {}", config_path.display()))?;

    let model_list = toml_string_array(&root, &["model_task_config", "replyer", "model_list"]);
    let model_name = model_list
        .first()
        .cloned()
        .ok_or_else(|| "model_task_config.replyer.model_list 为空".to_string())?;
    let task_temperature = toml_f64(&root, &["model_task_config", "replyer", "temperature"]);
    let task_max_tokens = toml_i64(&root, &["model_task_config", "replyer", "max_tokens"]);

    let models = root
        .get("models")
        .and_then(toml::Value::as_array)
        .ok_or_else(|| "model_config.toml 中没有 [[models]]".to_string())?;
    let model = models
        .iter()
        .find(|item| toml_string(item, &["name"]).as_deref() == Some(model_name.as_str()))
        .ok_or_else(|| format!("找不到回复模型配置: {model_name}"))?;
    let provider_name = toml_string(model, &["api_provider"])
        .ok_or_else(|| format!("模型 {model_name} 未配置 api_provider"))?;
    let model_identifier = toml_string(model, &["model_identifier"])
        .ok_or_else(|| format!("模型 {model_name} 未配置 model_identifier"))?;

    let providers = root
        .get("api_providers")
        .and_then(toml::Value::as_array)
        .ok_or_else(|| "model_config.toml 中没有 [[api_providers]]".to_string())?;
    let provider = providers
        .iter()
        .find(|item| toml_string(item, &["name"]).as_deref() == Some(provider_name.as_str()))
        .ok_or_else(|| format!("找不到 API Provider: {provider_name}"))?;

    Ok(ReplyModelConfig {
        base_url: toml_string(provider, &["base_url"])
            .ok_or_else(|| "Provider 缺少 base_url".to_string())?,
        api_key: toml_string(provider, &["api_key"])
            .ok_or_else(|| "Provider 缺少 api_key".to_string())?,
        wire_api: toml_string(provider, &["wire_api"])
            .unwrap_or_else(|| "chat_completions".to_string()),
        model_identifier,
        model_name,
        temperature: task_temperature
            .or_else(|| toml_f64(model, &["temperature"]))
            .unwrap_or(0.3),
        max_tokens: task_max_tokens
            .or_else(|| toml_i64(model, &["max_tokens"]))
            .unwrap_or(1024),
    })
}

fn clean_reply_text(text: &str) -> String {
    let mut cleaned = text
        .trim()
        .trim_matches('"')
        .trim_matches('“')
        .trim_matches('”')
        .to_string();
    if cleaned.starts_with("```") && cleaned.ends_with("```") {
        cleaned = cleaned
            .lines()
            .filter(|line| !line.trim_start().starts_with("```"))
            .collect::<Vec<_>>()
            .join("\n");
    }
    cleaned.trim().to_string()
}

fn build_voice_reply_context(transcript: &str, screen_context: Option<&str>) -> String {
    let mut parts = Vec::new();
    if let Some(memory) = load_voice_memory_context(transcript) {
        parts.push(format!(
            "【可参考的 MaiBot 正常聊天记忆】\n{memory}\n这些是背景参考，不要硬塞进回复；只有相关时才自然使用。"
        ));
    }
    if let Some(screen) = screen_context
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        parts.push(format!(
            "【当前桌面屏幕上下文】\n{screen}\n这是实时语音对话的强参考信息。如果这里显示的是游戏或软件窗口，可以自然点出用户当前正在玩/操作的内容；当用户说“这个、这里、刚才、现在、怎么打、怎么弄”等指代时，优先结合这个上下文回答。不要频繁硬塞，也不要主动暴露无关隐私窗口。"
        ));
    }
    parts.join("\n\n")
}

fn load_voice_memory_context(transcript: &str) -> Option<String> {
    let db_path = maibot_database_path();
    if !db_path.exists() {
        return None;
    }
    let conn = Connection::open(db_path).ok()?;
    let _ = conn.busy_timeout(Duration::from_millis(800));

    let mut snippets = Vec::new();
    for keyword in extract_memory_keywords(transcript).into_iter().take(4) {
        let pattern = format!("%{keyword}%");
        if let Ok(mut stmt) = conn.prepare(
            "SELECT theme, summary, original_text
             FROM chat_history
             WHERE chat_id != 'desktop_voice_chat'
               AND (theme LIKE ?1 OR summary LIKE ?1 OR original_text LIKE ?1 OR keywords LIKE ?1)
             ORDER BY end_time DESC
             LIMIT 2",
        ) {
            let rows = stmt.query_map(params![pattern], |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?.unwrap_or_default(),
                    row.get::<_, Option<String>>(1)?.unwrap_or_default(),
                    row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                ))
            });
            if let Ok(rows) = rows {
                for row in rows.flatten() {
                    let item = format_memory_snippet(&row.0, &row.1, &row.2);
                    if !item.is_empty() && !snippets.contains(&item) {
                        snippets.push(item);
                    }
                }
            }
        }
    }

    if snippets.len() < 3 {
        if let Ok(mut stmt) = conn.prepare(
            "SELECT theme, summary, original_text
             FROM chat_history
             WHERE chat_id != 'desktop_voice_chat'
             ORDER BY end_time DESC
             LIMIT 4",
        ) {
            if let Ok(rows) = stmt.query_map([], |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?.unwrap_or_default(),
                    row.get::<_, Option<String>>(1)?.unwrap_or_default(),
                    row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                ))
            }) {
                for row in rows.flatten() {
                    let item = format_memory_snippet(&row.0, &row.1, &row.2);
                    if !item.is_empty() && !snippets.contains(&item) {
                        snippets.push(item);
                    }
                }
            }
        }
    }

    if snippets.is_empty() {
        None
    } else {
        Some(snippets.into_iter().take(6).collect::<Vec<_>>().join("\n"))
    }
}

fn extract_memory_keywords(text: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    for ch in text.chars() {
        if ch.is_ascii_alphanumeric() || ('\u{4e00}'..='\u{9fff}').contains(&ch) {
            current.push(ch);
        } else if current.chars().count() >= 2 {
            tokens.push(current.clone());
            current.clear();
        } else {
            current.clear();
        }
    }
    if current.chars().count() >= 2 {
        tokens.push(current);
    }
    tokens.sort_by_key(|item| std::cmp::Reverse(item.chars().count()));
    tokens.dedup();
    tokens
}

fn format_memory_snippet(theme: &str, summary: &str, original_text: &str) -> String {
    let title = theme.trim();
    let body = if !summary.trim().is_empty() {
        summary.trim()
    } else {
        original_text.trim()
    };
    if title.is_empty() && body.is_empty() {
        String::new()
    } else if title.is_empty() {
        format!("- {}", truncate_chars(body, 180))
    } else if body.is_empty() {
        format!("- {}", truncate_chars(title, 80))
    } else {
        format!(
            "- {}：{}",
            truncate_chars(title, 80),
            truncate_chars(body, 180)
        )
    }
}

async fn call_reply_model(
    transcript: &str,
    output_language: &str,
    history: &[VoiceChatMessage],
    screen_context: Option<&str>,
) -> Result<(String, String), String> {
    let model = resolve_reply_model_config()?;
    let client = reqwest::Client::new();
    let extra_context = build_voice_reply_context(transcript, screen_context);
    let system_prompt = if extra_context.is_empty() {
        build_voice_system_prompt(output_language)
    } else {
        format!(
            "{}\n\n{}",
            build_voice_system_prompt(output_language),
            extra_context
        )
    };

    if model.wire_api.eq_ignore_ascii_case("responses") {
        let mut input = vec![serde_json::json!({"role": "system", "content": system_prompt})];
        for item in history {
            input.push(serde_json::json!({"role": item.role, "content": item.content}));
        }
        input.push(serde_json::json!({"role": "user", "content": transcript}));
        let url = normalize_api_url(&model.base_url, "/responses");
        let payload = serde_json::json!({
            "model": model.model_identifier,
            "input": input,
            "temperature": model.temperature,
            "max_output_tokens": model.max_tokens,
        });
        let response = client
            .post(url)
            .bearer_auth(&model.api_key)
            .json(&payload)
            .send()
            .await
            .map_err(|err| format!("回复模型请求失败: {err}"))?;
        let status = response.status();
        let body = response
            .text()
            .await
            .map_err(|err| format!("读取回复模型响应失败: {err}"))?;
        if !status.is_success() {
            return Err(format!("回复模型 HTTP {status}: {body}"));
        }
        let value: Value =
            serde_json::from_str(&body).map_err(|err| format!("解析回复模型响应失败: {err}"))?;
        let text = value
            .get("output_text")
            .and_then(Value::as_str)
            .or_else(|| {
                value
                    .get("output")
                    .and_then(Value::as_array)
                    .and_then(|items| {
                        items.iter().find_map(|item| {
                            item.get("content")
                                .and_then(Value::as_array)
                                .and_then(|parts| {
                                    parts
                                        .iter()
                                        .find_map(|part| part.get("text").and_then(Value::as_str))
                                })
                        })
                    })
            })
            .ok_or_else(|| format!("回复模型响应中没有文本: {body}"))?;
        return Ok((clean_reply_text(text), model.model_name));
    }

    let mut messages = vec![serde_json::json!({"role": "system", "content": system_prompt})];
    for item in history {
        messages.push(serde_json::json!({"role": item.role, "content": item.content}));
    }
    messages.push(serde_json::json!({"role": "user", "content": transcript}));

    let url = normalize_api_url(&model.base_url, "/chat/completions");
    let payload = serde_json::json!({
        "model": model.model_identifier,
        "messages": messages,
        "temperature": model.temperature,
        "max_tokens": model.max_tokens,
    });
    let response = client
        .post(url)
        .bearer_auth(&model.api_key)
        .json(&payload)
        .send()
        .await
        .map_err(|err| format!("回复模型请求失败: {err}"))?;
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|err| format!("读取回复模型响应失败: {err}"))?;
    if !status.is_success() {
        return Err(format!("回复模型 HTTP {status}: {body}"));
    }
    let value: Value =
        serde_json::from_str(&body).map_err(|err| format!("解析回复模型响应失败: {err}"))?;
    let text = value
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
        .and_then(|choice| choice.get("message"))
        .and_then(|message| message.get("content"))
        .and_then(Value::as_str)
        .ok_or_else(|| format!("回复模型响应中没有 choices[0].message.content: {body}"))?;
    Ok((clean_reply_text(text), model.model_name))
}

async fn call_doubao_asr(wav_audio: Vec<u8>, config: &VoiceChatConfig) -> Result<String, String> {
    if !config.volc_asr_api_key.trim().is_empty() {
        return call_volcengine_submit_asr(wav_audio, config).await;
    }
    if !config.volc_asr_app_id.trim().is_empty() && !config.volc_asr_access_token.trim().is_empty()
    {
        return call_volcengine_flash_asr(wav_audio, config).await;
    }

    if config.asr_api_key.trim().is_empty() {
        return Err("豆包 ASR API Key 为空，请先在语音对话菜单里保存配置。".to_string());
    }
    let transcription_path = config.asr_transcription_path.trim();
    let endpoint = if transcription_path.is_empty() {
        "/audio/transcriptions"
    } else if transcription_path.starts_with('/') {
        transcription_path
    } else {
        return Err("ASR 转写路径必须以 / 开头，例如 /audio/transcriptions。".to_string());
    };
    let url = normalize_api_url(&config.asr_base_url, endpoint);
    let file_part = reqwest::multipart::Part::bytes(wav_audio)
        .file_name("recording.wav")
        .mime_str("audio/wav")
        .map_err(|err| format!("构造 ASR 文件上传失败: {err}"))?;
    let form = reqwest::multipart::Form::new()
        .text("model", config.asr_model.trim().to_string())
        .text("response_format", "json".to_string())
        .part("file", file_part);
    let response = reqwest::Client::new()
        .post(url)
        .bearer_auth(config.asr_api_key.trim())
        .multipart(form)
        .send()
        .await
        .map_err(|err| format!("豆包 ASR 请求失败: {err}"))?;
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|err| format!("读取 ASR 响应失败: {err}"))?;
    if !status.is_success() {
        if status.as_u16() == 404 {
            return Err(format!(
                "豆包 ASR HTTP 404：当前 Base URL 未找到转写接口 {endpoint}。/models 已可用不代表账号已开通 ASR，请在火山控制台确认语音识别模型/接入点，或在语音配置里改正确的转写路径。响应: {body}"
            ));
        }
        return Err(format!("豆包 ASR HTTP {status}: {body}"));
    }
    let value: Value = serde_json::from_str(&body)
        .map_err(|err| format!("解析 ASR 响应失败: {err}; body={body}"))?;
    let text = value
        .get("text")
        .and_then(Value::as_str)
        .or_else(|| {
            value
                .get("result")
                .and_then(|result| result.get("text"))
                .and_then(Value::as_str)
        })
        .or_else(|| {
            value
                .get("data")
                .and_then(|data| data.get("text"))
                .and_then(Value::as_str)
        })
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .ok_or_else(|| format!("ASR 响应里没有识别文本: {body}"))?;
    Ok(text.to_string())
}

async fn call_volcengine_submit_asr(
    wav_audio: Vec<u8>,
    config: &VoiceChatConfig,
) -> Result<String, String> {
    let submit_url = config.volc_asr_submit_url.trim();
    let query_url = config.volc_asr_query_url.trim();
    if submit_url.is_empty() || query_url.is_empty() {
        return Err("火山 ASR submit/query URL 为空。".to_string());
    }
    let request_id = format!("maibot-desktop-{}", uuid_like_id());
    let client = reqwest::Client::new();
    let payload = serde_json::json!({
        "user": {
            "uid": if config.volc_asr_app_id.trim().is_empty() {
                "maibot-desktop"
            } else {
                config.volc_asr_app_id.trim()
            }
        },
        "audio": {
            "data": general_purpose::STANDARD.encode(&wav_audio),
            "format": "wav",
            "codec": "raw",
            "rate": 16000,
            "bits": 16,
            "channel": 1
        },
        "request": {
            "model_name": config.volc_asr_model.trim(),
            "enable_itn": true,
            "enable_punc": false,
            "enable_ddc": false,
            "enable_speaker_info": false,
            "enable_channel_split": false,
            "show_utterances": false,
            "vad_segment": false,
            "sensitive_words_filter": ""
        }
    });

    let response = client
        .post(submit_url)
        .header("x-api-key", config.volc_asr_api_key.trim())
        .header("X-Api-Resource-Id", config.volc_asr_resource_id.trim())
        .header("X-Api-Request-Id", &request_id)
        .header("X-Api-Sequence", "-1")
        .json(&payload)
        .send()
        .await
        .map_err(|err| format!("火山 ASR 提交失败: {err}"))?;
    validate_volc_asr_response(response, "提交").await?;

    let query_body = serde_json::json!({});
    let mut last_message = String::new();
    for _ in 0..30 {
        tokio::time::sleep(Duration::from_millis(600)).await;
        let response = client
            .post(query_url)
            .header("x-api-key", config.volc_asr_api_key.trim())
            .header("X-Api-Resource-Id", config.volc_asr_resource_id.trim())
            .header("X-Api-Request-Id", &request_id)
            .json(&query_body)
            .send()
            .await
            .map_err(|err| format!("火山 ASR 查询失败: {err}"))?;
        let status = response.status();
        let headers = response.headers().clone();
        let body = response
            .text()
            .await
            .map_err(|err| format!("读取火山 ASR 查询响应失败: {err}"))?;
        if !status.is_success() {
            return Err(format!("火山 ASR 查询 HTTP {status}: {body}"));
        }
        let api_status = headers
            .get("X-Api-Status-Code")
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default();
        let api_message = headers
            .get("X-Api-Message")
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default();
        last_message = api_message.to_string();
        if api_status == "20000000" {
            let value: Value = serde_json::from_str(&body)
                .map_err(|err| format!("解析火山 ASR 查询响应失败: {err}; body={body}"))?;
            if let Some(text) = extract_asr_text(&value) {
                return Ok(text);
            }
            return Err(format!("火山 ASR 查询响应里没有识别文本: {body}"));
        }
        if api_status != "20000001" && api_status != "20000002" && api_status != "20000003" {
            return Err(format!(
                "火山 ASR 查询失败: code={api_status}, message={api_message}, body={body}"
            ));
        }
    }

    Err(format!("火山 ASR 查询超时，最后状态: {last_message}"))
}

async fn validate_volc_asr_response(
    response: reqwest::Response,
    stage: &str,
) -> Result<(), String> {
    let status = response.status();
    let headers = response.headers().clone();
    let body = response
        .text()
        .await
        .map_err(|err| format!("读取火山 ASR {stage}响应失败: {err}"))?;
    if !status.is_success() {
        return Err(format!("火山 ASR {stage} HTTP {status}: {body}"));
    }
    let api_status = headers
        .get("X-Api-Status-Code")
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    if api_status != "20000000" {
        let api_message = headers
            .get("X-Api-Message")
            .and_then(|value| value.to_str().ok())
            .unwrap_or("未知错误");
        let log_id = headers
            .get("X-Tt-Logid")
            .and_then(|value| value.to_str().ok())
            .unwrap_or("无 logid");
        return Err(format!(
            "火山 ASR {stage}失败: code={api_status}, message={api_message}, logid={log_id}, body={body}"
        ));
    }
    Ok(())
}

fn uuid_like_id() -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default();
    format!("{millis}-{}", std::process::id())
}

fn store_voice_turn_to_maibot_db(transcript: &str, reply_text: &str) -> Result<(), String> {
    let db_path = maibot_database_path();
    if !db_path.exists() {
        return Err(format!("找不到 MaiBot 数据库: {}", db_path.display()));
    }

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs_f64())
        .unwrap_or_default();
    let bot_name = bot_nickname();
    let bot_id = read_qq_account().unwrap_or_else(|| "3955291569".to_string());
    let chat_id = "desktop_voice_chat";
    let chat_platform = "desktop_voice";
    let owner_id = "desktop_owner";
    let owner_name = "老大";
    let conn =
        Connection::open(&db_path).map_err(|err| format!("打开 MaiBot 数据库失败: {err}"))?;
    conn.busy_timeout(Duration::from_millis(1500))
        .map_err(|err| format!("设置数据库等待超时失败: {err}"))?;

    conn.execute(
        "INSERT INTO chat_streams (
            stream_id, create_time, group_platform, group_id, group_name, last_active_time,
            platform, user_platform, user_id, user_nickname, user_cardname
        ) VALUES (?1, ?2, NULL, NULL, NULL, ?2, ?3, ?3, ?4, ?5, NULL)
        ON CONFLICT(stream_id) DO UPDATE SET last_active_time=excluded.last_active_time",
        params![chat_id, now, chat_platform, owner_id, owner_name],
    )
    .map_err(|err| format!("写入语音聊天流失败: {err}"))?;

    insert_voice_message(
        &conn,
        VoiceMessageInsert {
            message_id: &format!("desktop_voice_user_{}", unique_message_suffix(now)),
            timestamp: now,
            chat_id,
            chat_platform,
            chat_user_id: owner_id,
            chat_user_name: owner_name,
            sender_id: owner_id,
            sender_name: owner_name,
            text: transcript,
        },
    )?;
    insert_voice_message(
        &conn,
        VoiceMessageInsert {
            message_id: &format!("desktop_voice_bot_{}", unique_message_suffix(now + 0.001)),
            timestamp: now + 0.001,
            chat_id,
            chat_platform,
            chat_user_id: owner_id,
            chat_user_name: owner_name,
            sender_id: &bot_id,
            sender_name: &bot_name,
            text: reply_text,
        },
    )?;
    insert_voice_memory(
        &conn,
        VoiceMemoryInsert {
            start_time: now,
            end_time: now + 0.001,
            chat_id,
            owner_name,
            bot_name: &bot_name,
            transcript,
            reply_text,
        },
    )?;
    Ok(())
}

fn unique_message_suffix(time_value: f64) -> String {
    format!("{:.0}", time_value * 1000.0)
}

struct VoiceMessageInsert<'a> {
    message_id: &'a str,
    timestamp: f64,
    chat_id: &'a str,
    chat_platform: &'a str,
    chat_user_id: &'a str,
    chat_user_name: &'a str,
    sender_id: &'a str,
    sender_name: &'a str,
    text: &'a str,
}

fn insert_voice_message(conn: &Connection, message: VoiceMessageInsert<'_>) -> Result<(), String> {
    conn.execute(
        "INSERT OR REPLACE INTO messages (
            message_id, time, chat_id, reply_to, interest_value, key_words, key_words_lite,
            is_mentioned, is_at, reply_probability_boost,
            chat_info_stream_id, chat_info_platform, chat_info_user_platform, chat_info_user_id,
            chat_info_user_nickname, chat_info_user_cardname, chat_info_group_platform,
            chat_info_group_id, chat_info_group_name, chat_info_create_time, chat_info_last_active_time,
            user_platform, user_id, user_nickname, user_cardname,
            processed_plain_text, display_message, priority_mode, priority_info, additional_config,
            is_emoji, is_picid, is_command, intercept_message_level, is_notify, selected_expressions
        ) VALUES (
            ?1, ?2, ?3, '', 0.0, '[]', '[]',
            0, 0, 0.0,
            ?3, ?4, ?4, ?5,
            ?6, NULL, NULL,
            NULL, NULL, ?2, ?2,
            ?4, ?7, ?8, NULL,
            ?9, '', '', '{}', NULL,
            0, 0, 0, 0, 0, ''
        )",
        params![
            message.message_id,
            message.timestamp,
            message.chat_id,
            message.chat_platform,
            message.chat_user_id,
            message.chat_user_name,
            message.sender_id,
            message.sender_name,
            message.text,
        ],
    )
    .map_err(|err| format!("写入语音聊天消息失败: {err}"))?;
    Ok(())
}

struct VoiceMemoryInsert<'a> {
    start_time: f64,
    end_time: f64,
    chat_id: &'a str,
    owner_name: &'a str,
    bot_name: &'a str,
    transcript: &'a str,
    reply_text: &'a str,
}

fn insert_voice_memory(conn: &Connection, memory: VoiceMemoryInsert<'_>) -> Result<(), String> {
    let owner_name = memory.owner_name;
    let bot_name = memory.bot_name;
    let transcript = memory.transcript;
    let reply_text = memory.reply_text;
    let original_text = format!("{owner_name}: {transcript}\n{bot_name}: {reply_text}");
    let theme = format!("桌面语音对话：{}", truncate_chars(transcript, 36));
    let keywords = serde_json::json!(["桌面语音", "语音对话", owner_name, bot_name]).to_string();
    let participants = serde_json::json!([owner_name, bot_name]).to_string();
    let summary = format!(
        "{owner_name}通过桌面语音说：“{}”。{bot_name}回复：“{}”。",
        truncate_chars(transcript, 180),
        truncate_chars(reply_text, 180)
    );
    let key_point = serde_json::json!([
        format!("{owner_name}: {}", truncate_chars(transcript, 180)),
        format!("{bot_name}: {}", truncate_chars(reply_text, 180))
    ])
    .to_string();

    conn.execute(
        "INSERT INTO chat_history (
            chat_id, start_time, end_time, original_text, participants,
            theme, keywords, summary, key_point, count, forget_times
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 0, 0)",
        params![
            memory.chat_id,
            memory.start_time,
            memory.end_time,
            original_text,
            participants,
            theme,
            keywords,
            summary,
            key_point,
        ],
    )
    .map_err(|err| format!("写入语音聊天记忆失败: {err}"))?;
    Ok(())
}

fn truncate_chars(value: &str, max_chars: usize) -> String {
    let mut chars = value.chars();
    let truncated: String = chars.by_ref().take(max_chars).collect();
    if chars.next().is_some() {
        format!("{truncated}...")
    } else {
        truncated
    }
}

async fn call_volcengine_flash_asr(
    wav_audio: Vec<u8>,
    config: &VoiceChatConfig,
) -> Result<String, String> {
    let request_id = format!("maibot-desktop-{}", uuid_like_id());
    let url = config.volc_asr_url.trim();
    if url.is_empty() {
        return Err("火山 ASR URL 为空。".to_string());
    }
    let payload = serde_json::json!({
        "user": {
            "uid": config.volc_asr_app_id.trim()
        },
        "audio": {
            "data": general_purpose::STANDARD.encode(&wav_audio),
            "format": "wav",
            "codec": "raw",
            "rate": 16000,
            "bits": 16,
            "channel": 1
        },
        "request": {
            "model_name": config.volc_asr_model.trim()
        }
    });

    let response = reqwest::Client::new()
        .post(url)
        .header("X-Api-App-Key", config.volc_asr_app_id.trim())
        .header("X-Api-Access-Key", config.volc_asr_access_token.trim())
        .header("X-Api-Resource-Id", config.volc_asr_resource_id.trim())
        .header("X-Api-Request-Id", request_id)
        .header("X-Api-Sequence", "-1")
        .json(&payload)
        .send()
        .await
        .map_err(|err| format!("火山 ASR 请求失败: {err}"))?;
    let status = response.status();
    let headers = response.headers().clone();
    let body = response
        .bytes()
        .await
        .map_err(|err| format!("读取火山 ASR 响应失败: {err}"))?;
    if !status.is_success() {
        let preview = String::from_utf8_lossy(&body);
        return Err(format!("火山 ASR HTTP {status}: {preview}"));
    }
    let api_status = headers
        .get("X-Api-Status-Code")
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    if !api_status.is_empty() && api_status != "20000000" {
        let api_message = headers
            .get("X-Api-Message")
            .and_then(|value| value.to_str().ok())
            .unwrap_or("未知错误");
        let log_id = headers
            .get("X-Tt-Logid")
            .and_then(|value| value.to_str().ok())
            .unwrap_or("无 logid");
        return Err(format!(
            "火山 ASR 失败: code={api_status}, message={api_message}, logid={log_id}"
        ));
    }

    let body_text = String::from_utf8_lossy(&body);
    if let Ok(value) = serde_json::from_str::<Value>(&body_text) {
        if let Some(text) = extract_asr_text(&value) {
            return Ok(text);
        }
        return Err(format!("火山 ASR 响应里没有识别文本: {body_text}"));
    }

    if let Some(text) = headers
        .get("X-Api-Result")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| serde_json::from_str::<Value>(value).ok())
        .and_then(|value| extract_asr_text(&value))
    {
        return Ok(text);
    }

    Err(format!("火山 ASR 响应无法解析: {body_text}"))
}

fn extract_asr_text(value: &Value) -> Option<String> {
    let candidates = [
        value.get("text"),
        value.get("result").and_then(|result| result.get("text")),
        value.get("data").and_then(|data| data.get("text")),
        value
            .get("payload_msg")
            .and_then(|payload| payload.get("result"))
            .and_then(|result| result.get("text")),
    ];

    candidates
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::trim)
        .find(|text| !text.is_empty())
        .map(ToString::to_string)
        .or_else(|| {
            value
                .get("result")
                .and_then(|result| result.get("utterances"))
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(|item| item.get("text").and_then(Value::as_str))
                        .map(str::trim)
                        .filter(|text| !text.is_empty())
                        .collect::<Vec<_>>()
                        .join("")
                })
                .filter(|text| !text.is_empty())
        })
}

async fn call_elaina_tts(text: &str, config: &VoiceChatConfig) -> Result<Vec<u8>, String> {
    let api_url = if config.tts_api_url.trim().ends_with("/tts") {
        config.tts_api_url.trim().to_string()
    } else {
        format!("{}/tts", config.tts_api_url.trim().trim_end_matches('/'))
    };
    let payload = serde_json::json!({
        "text": text,
        "text_lang": config.output_language.trim(),
        "prompt_lang": config.tts_prompt_lang.trim(),
        "prompt_text": config.tts_prompt_text.trim(),
        "ref_audio_path": config.tts_ref_audio_path.trim(),
        "media_type": "wav",
        "streaming_mode": false,
        "speed_factor": 1.0,
    });
    let response = reqwest::Client::new()
        .post(api_url)
        .json(&payload)
        .send()
        .await
        .map_err(|err| format!("伊蕾娜语音 API 请求失败: {err}"))?;
    let status = response.status();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_string();
    let bytes = response
        .bytes()
        .await
        .map_err(|err| format!("读取语音响应失败: {err}"))?;
    if !status.is_success() {
        return Err(format!(
            "伊蕾娜语音 API HTTP {status}: {}",
            String::from_utf8_lossy(&bytes)
        ));
    }
    if !content_type.to_ascii_lowercase().contains("audio") && bytes.len() < 1024 {
        return Err(format!(
            "伊蕾娜语音 API 没有返回有效音频: {}",
            String::from_utf8_lossy(&bytes)
        ));
    }
    Ok(bytes.to_vec())
}

fn normalize_local_url(url: &str) -> String {
    let trimmed = url.trim();
    let lowered = trimmed.to_ascii_lowercase();
    let prefixes = [
        ("http://0.0.0.0:", "http://127.0.0.1:"),
        ("http://localhost:", "http://127.0.0.1:"),
        ("http://[::1]:", "http://127.0.0.1:"),
        ("http://[::]:", "http://127.0.0.1:"),
    ];

    for (prefix, replacement) in prefixes {
        if lowered.starts_with(prefix) {
            return format!("{replacement}{}", &trimmed[prefix.len()..]);
        }
    }

    trimmed.to_string()
}

fn detect_napcat_webui_url() -> String {
    let versions_root = napcat_root().join("versions");
    let versions_config_path = versions_root.join("config.json");
    let default_url = "http://127.0.0.1:6099/webui".to_string();

    let Some(versions_config) = read_json_value(&versions_config_path) else {
        return default_url;
    };

    let version = versions_config
        .get("curVersion")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .or_else(|| versions_config.get("baseVersion").and_then(Value::as_str))
        .unwrap_or_default()
        .trim()
        .to_string();

    if version.is_empty() {
        return default_url;
    }

    let webui_config_path = versions_root
        .join(version)
        .join("resources/app/napcat/config/webui.json");
    let Some(webui_config) = read_json_value(&webui_config_path) else {
        return default_url;
    };

    let host = webui_config
        .get("host")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("127.0.0.1");
    let normalized_host = match host {
        "0.0.0.0" | "localhost" | "::" | "::1" => "127.0.0.1",
        other => other,
    };
    let port = webui_config
        .get("port")
        .and_then(Value::as_u64)
        .filter(|value| *value > 0 && *value <= u16::MAX as u64)
        .map(|value| value as u16)
        .unwrap_or(6099);
    let token = webui_config
        .get("token")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default();

    let base = format!("http://{normalized_host}:{port}/webui");
    if token.is_empty() {
        base
    } else {
        format!("{base}?token={token}")
    }
}

fn parse_env_line(content: &str, key: &str) -> Option<String> {
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let (left, right) = trimmed.split_once('=')?;
        if left.trim() != key {
            continue;
        }
        let value = right
            .trim()
            .trim_matches('"')
            .trim_matches('\'')
            .trim()
            .to_string();
        if !value.is_empty() {
            return Some(value);
        }
    }
    None
}

fn detect_maibot_webui_url() -> String {
    let default_host = "127.0.0.1".to_string();
    let default_port = 8001u16;
    let env_path = maibot_root().join(".env");
    let content = fs::read_to_string(env_path).unwrap_or_default();
    let host = parse_env_line(&content, "WEBUI_HOST").unwrap_or(default_host);
    let normalized_host = match host.trim() {
        "0.0.0.0" | "localhost" | "::" | "::1" => "127.0.0.1",
        "" => "127.0.0.1",
        other => other,
    };
    let port = parse_env_line(&content, "WEBUI_PORT")
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(default_port);
    format!("http://{normalized_host}:{port}")
}

fn detect_maibot_webui_access_token() -> String {
    let token_path = maibot_root().join("data/webui.json");
    read_json_value(&token_path)
        .and_then(|value| {
            value
                .get("access_token")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|token| !token.is_empty())
                .map(str::to_string)
        })
        .unwrap_or_default()
}

fn extract_query_param(url: &str, key: &str) -> String {
    let Some(query) = url.split_once('?').map(|(_, query)| query) else {
        return String::new();
    };
    for pair in query.split('&') {
        let (left, right) = pair.split_once('=').unwrap_or((pair, ""));
        if left == key {
            return right.trim().to_string();
        }
    }
    String::new()
}

fn normalize_owner_email(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.eq_ignore_ascii_case("2418749618qq.com") {
        "2418749618@qq.com".to_string()
    } else {
        trimmed.to_string()
    }
}

fn login_helper_mail_configured(config: &LoginHelperConfig) -> bool {
    let recipient = normalize_owner_email(&config.recipient_email);
    !recipient.is_empty()
        && recipient.contains('@')
        && !config.smtp_host.trim().is_empty()
        && config.smtp_port > 0
        && !config.smtp_username.trim().is_empty()
        && !config.smtp_password.trim().is_empty()
        && !config.smtp_from.trim().is_empty()
}

fn build_login_helper_status(config: &LoginHelperConfig) -> LoginHelperStatus {
    let napcat_webui_url = detect_napcat_webui_url();
    LoginHelperStatus {
        maibot_webui_url: detect_maibot_webui_url(),
        maibot_access_token: detect_maibot_webui_access_token(),
        napcat_token: extract_query_param(&napcat_webui_url, "token"),
        napcat_webui_url,
        qq_account: read_qq_account(),
        mail_configured: login_helper_mail_configured(config),
    }
}

fn login_helper_email_body(
    status: &LoginHelperStatus,
    include_maibot: bool,
    include_napcat: bool,
) -> String {
    let mut lines = Vec::new();
    lines.push("MaiBot 登录助手检测到你可能需要远程处理登录或 WebUI Token。".to_string());
    lines.push(String::new());
    lines.push("注意：下面的 127.0.0.1 地址只适合在运行 bot 的这台电脑或远控窗口里打开，不能直接在手机浏览器打开。".to_string());
    lines.push(
        "如果 QQ / NapCat 要求手机确认，登录助手不能绕过 QQ 安全验证，只能帮你更快找到入口。"
            .to_string(),
    );
    lines.push(String::new());
    lines.push(format!(
        "Bot QQ：{}",
        status.qq_account.as_deref().unwrap_or("未读取")
    ));
    if include_maibot {
        lines.push(String::new());
        lines.push("[MaiBot WebUI]".to_string());
        lines.push(format!("地址：{}", status.maibot_webui_url));
        lines.push(format!(
            "Access Token：{}",
            if status.maibot_access_token.is_empty() {
                "未读取"
            } else {
                &status.maibot_access_token
            }
        ));
    }
    if include_napcat {
        lines.push(String::new());
        lines.push("[NapCat WebUI]".to_string());
        lines.push(format!("地址：{}", status.napcat_webui_url));
        lines.push(format!(
            "Token：{}",
            if status.napcat_token.is_empty() {
                "未读取"
            } else {
                &status.napcat_token
            }
        ));
    }
    lines.push(String::new());
    lines.push("建议流程：远控电脑 -> 打开桌面端登录助手或上面的本机地址 -> 扫码 / 输入 Token -> 必要时执行“稳态重登准备”。".to_string());
    lines.join("\n")
}

fn send_login_helper_email_inner(request: SendLoginEmailRequest) -> Result<String, String> {
    let mut config = request.config;
    config.recipient_email = normalize_owner_email(&config.recipient_email);
    if config.smtp_from.trim().is_empty() && !config.smtp_username.trim().is_empty() {
        config.smtp_from = config.smtp_username.trim().to_string();
    }

    if !request.include_maibot && !request.include_napcat {
        return Err("至少选择 MaiBot WebUI 或 NapCat WebUI 中的一项。".to_string());
    }
    if !config.recipient_email.contains('@') {
        return Err("收件邮箱格式不正确。".to_string());
    }
    if !login_helper_mail_configured(&config) {
        return Err(
            "邮件配置不完整：需要 SMTP 主机、端口、账号、授权码/密码、发件人和收件人。".to_string(),
        );
    }

    save_login_helper_config_inner(&config)?;
    let status = build_login_helper_status(&config);
    let subject = format!(
        "MaiBot 登录助手 - {}",
        status.qq_account.as_deref().unwrap_or("未知QQ")
    );
    let body = login_helper_email_body(&status, request.include_maibot, request.include_napcat);

    #[cfg(target_os = "windows")]
    {
        let script = r#"
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$message = [System.Net.Mail.MailMessage]::new()
try {
  $message.From = [System.Net.Mail.MailAddress]::new($env:MAIBOT_LOGIN_SMTP_FROM)
  $message.To.Add($env:MAIBOT_LOGIN_SMTP_TO)
  $message.Subject = $env:MAIBOT_LOGIN_MAIL_SUBJECT
  $message.SubjectEncoding = [System.Text.Encoding]::UTF8
  $message.Body = $env:MAIBOT_LOGIN_MAIL_BODY
  $message.BodyEncoding = [System.Text.Encoding]::UTF8
  $client = [System.Net.Mail.SmtpClient]::new($env:MAIBOT_LOGIN_SMTP_HOST, [int]$env:MAIBOT_LOGIN_SMTP_PORT)
  try {
    $client.EnableSsl = [System.Convert]::ToBoolean($env:MAIBOT_LOGIN_SMTP_SSL)
    $client.Timeout = 15000
    $client.Credentials = [System.Net.NetworkCredential]::new($env:MAIBOT_LOGIN_SMTP_USER, $env:MAIBOT_LOGIN_SMTP_PASS)
    $client.Send($message)
  } finally {
    $client.Dispose()
  }
} finally {
  $message.Dispose()
}
"#;
        let mut command = Command::new(windows_powershell_path());
        hide_command_window(&mut command);
        let output = command
            .args([
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                script,
            ])
            .env("MAIBOT_LOGIN_SMTP_TO", &config.recipient_email)
            .env("MAIBOT_LOGIN_SMTP_HOST", config.smtp_host.trim())
            .env("MAIBOT_LOGIN_SMTP_PORT", config.smtp_port.to_string())
            .env("MAIBOT_LOGIN_SMTP_USER", config.smtp_username.trim())
            .env("MAIBOT_LOGIN_SMTP_PASS", config.smtp_password.trim())
            .env("MAIBOT_LOGIN_SMTP_FROM", config.smtp_from.trim())
            .env(
                "MAIBOT_LOGIN_SMTP_SSL",
                if config.smtp_use_ssl { "true" } else { "false" },
            )
            .env("MAIBOT_LOGIN_MAIL_SUBJECT", &subject)
            .env("MAIBOT_LOGIN_MAIL_BODY", &body)
            .output()
            .map_err(|err| format!("调用 PowerShell 发送邮件失败: {err}"))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let stdout = String::from_utf8_lossy(&output.stdout);
            let detail = [stderr.trim(), stdout.trim()]
                .into_iter()
                .filter(|value| !value.is_empty())
                .collect::<Vec<_>>()
                .join("；");
            return Err(if detail.is_empty() {
                "SMTP 发送失败，但 PowerShell 没有返回详细错误。".to_string()
            } else {
                format!("SMTP 发送失败: {detail}")
            });
        }

        Ok(format!("登录邮件已发送到 {}", config.recipient_email))
    }

    #[cfg(not(target_os = "windows"))]
    {
        Err("当前登录助手邮件发送只实现了 Windows 版本。".to_string())
    }
}

fn parse_port(local_address: &str) -> Option<u16> {
    local_address
        .rsplit(':')
        .next()
        .and_then(|value| value.parse::<u16>().ok())
}

fn collect_listening_pids() -> HashMap<u16, u32> {
    let mut ports = HashMap::new();
    let mut command = Command::new("netstat");
    hide_command_window(&mut command);
    let output = match command.args(["-ano", "-p", "tcp"]).output() {
        Ok(output) => output,
        Err(_) => return ports,
    };

    let stdout = String::from_utf8_lossy(&output.stdout);
    for line in stdout.lines() {
        let columns: Vec<&str> = line.split_whitespace().collect();
        if columns.len() < 5 {
            continue;
        }

        if !columns[3].eq_ignore_ascii_case("LISTENING") {
            continue;
        }

        let Some(port) = parse_port(columns[1]) else {
            continue;
        };
        let Ok(pid) = columns[4].parse::<u32>() else {
            continue;
        };
        ports.insert(port, pid);
    }

    ports
}

fn normalize_match_text(value: impl AsRef<str>) -> String {
    value
        .as_ref()
        .replace('/', "\\")
        .trim()
        .to_ascii_lowercase()
}

fn collect_windows_processes() -> Result<Vec<WindowsProcessInfo>, String> {
    #[cfg(target_os = "windows")]
    {
        let powershell = windows_powershell_path();
        let script = r#"[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Get-CimInstance Win32_Process | Select-Object ProcessId, Name, ExecutablePath, CommandLine | ConvertTo-Json -Compress"#;

        let mut command = Command::new(powershell);
        hide_command_window(&mut command);
        let output = command
            .args(["-NoProfile", "-Command", script])
            .output()
            .map_err(|err| format!("读取系统进程列表失败: {err}"))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let detail = stderr.trim();
            return Err(if detail.is_empty() {
                "读取系统进程列表失败，PowerShell 返回了非零状态。".to_string()
            } else {
                format!("读取系统进程列表失败: {detail}")
            });
        }

        let stdout = String::from_utf8_lossy(&output.stdout);
        let trimmed = stdout.trim();
        if trimmed.is_empty() || trimmed.eq_ignore_ascii_case("null") {
            return Ok(Vec::new());
        }

        let json_value: Value =
            serde_json::from_str(trimmed).map_err(|err| format!("解析系统进程列表失败: {err}"))?;

        match json_value {
            Value::Array(values) => values
                .into_iter()
                .map(|value| {
                    serde_json::from_value::<WindowsProcessInfo>(value)
                        .map_err(|err| format!("解析进程信息失败: {err}"))
                })
                .collect(),
            Value::Object(_) => serde_json::from_value::<WindowsProcessInfo>(json_value)
                .map(|value| vec![value])
                .map_err(|err| format!("解析进程信息失败: {err}")),
            _ => Ok(Vec::new()),
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        Err("当前仅实现了 Windows 平台的进程扫描逻辑".to_string())
    }
}

fn collect_windows_process_map() -> Result<HashMap<u32, WindowsProcessInfo>, String> {
    Ok(collect_windows_processes()?
        .into_iter()
        .map(|process| (process.process_id, process))
        .collect())
}

fn collect_system_scan(force_refresh: bool) -> Result<SystemScan, String> {
    let mut cache = system_scan_cache()
        .lock()
        .map_err(|_| "系统扫描缓存锁定失败".to_string())?;

    if !force_refresh {
        if let Some(snapshot) = cache.as_ref() {
            if snapshot.collected_at.elapsed() < SYSTEM_SCAN_CACHE_TTL {
                return Ok(snapshot.clone());
            }
        }
    }

    let scan = SystemScan {
        collected_at: Instant::now(),
        listening_pids: collect_listening_pids(),
        process_map: collect_windows_process_map().unwrap_or_default(),
    };
    *cache = Some(scan.clone());
    Ok(scan)
}

fn build_process_label(process: Option<&WindowsProcessInfo>, pid: u32) -> String {
    let Some(process) = process else {
        return format!("未知进程 (PID {pid})");
    };

    let display_name = process
        .name
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("未知进程");
    let executable_path = process
        .executable_path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("");

    if executable_path.is_empty() {
        format!("{display_name} (PID {pid})")
    } else {
        format!("{display_name} ({executable_path}, PID {pid})")
    }
}

fn command_line_contains_any(command_line: &str, tokens: &[String]) -> bool {
    tokens
        .iter()
        .any(|token| !token.is_empty() && command_line.contains(token))
}

fn process_matches_spec(process: &WindowsProcessInfo, spec: &ProcessSpec) -> bool {
    let name = normalize_match_text(process.name.as_deref().unwrap_or_default());
    let executable_path =
        normalize_match_text(process.executable_path.as_deref().unwrap_or_default());
    let command_line = normalize_match_text(process.command_line.as_deref().unwrap_or_default());
    let expected_program = normalize_match_text(spec.program.display().to_string());
    let expected_cwd = normalize_match_text(spec.cwd.display().to_string());
    let normalized_args = spec
        .args
        .iter()
        .map(normalize_match_text)
        .collect::<Vec<_>>();

    match spec.id {
        "maibot-main" => {
            (name == "python.exe" || name == "pythonw.exe")
                && executable_path == expected_program
                && command_line_contains_any(&command_line, &normalized_args)
        }
        "adapter" => {
            (name == "python.exe" || name == "pythonw.exe")
                && executable_path == expected_program
                && command_line_contains_any(&command_line, &normalized_args)
        }
        "napcat" => {
            executable_path == expected_program
                || name == "napcatwinbootmain.exe"
                || (name == "qq.exe"
                    && !expected_cwd.is_empty()
                    && (executable_path.contains(&expected_cwd)
                        || command_line.contains(&expected_cwd)))
        }
        "tts-api" => {
            ((name == "powershell.exe"
                || name == "pwsh.exe"
                || name == "python.exe"
                || name == "pythonw.exe")
                && executable_path == expected_program
                && command_line_contains_any(&command_line, &normalized_args))
                || (!expected_cwd.is_empty()
                    && (executable_path.contains(&expected_cwd)
                        || command_line.contains(&expected_cwd)))
        }
        _ => executable_path == expected_program,
    }
}

fn get_port_owner(
    spec: &ProcessSpec,
    listening_pids: &HashMap<u16, u32>,
    process_map: &HashMap<u32, WindowsProcessInfo>,
) -> Option<PortOwner> {
    let port = spec.listen_port?;
    let pid = listening_pids.get(&port).copied()?;
    let process = process_map.get(&pid);
    let kind = if process.is_some_and(|item| process_matches_spec(item, spec)) {
        PortOwnerKind::Expected
    } else {
        PortOwnerKind::Unexpected
    };

    Some(PortOwner {
        pid,
        label: build_process_label(process, pid),
        kind,
    })
}

fn collect_related_processes() -> Result<Vec<(u32, String)>, String> {
    let maibot = maibot_root();
    let adapter = adapter_root();
    let napcat = napcat_root();
    let shared = shared_root();
    let napcat_root = normalize_match_text(napcat.display().to_string());
    let napcat_boot =
        normalize_match_text(napcat.join("NapCatWinBootMain.exe").display().to_string());
    let maibot_script = normalize_match_text(maibot.join("bot.py").display().to_string());
    let adapter_script = normalize_match_text(adapter.join("main.py").display().to_string());
    let tts_root = normalize_match_text(shared.join("Git/GPT-SoVITS-V2").display().to_string());
    let tts_script = normalize_match_text(
        shared
            .join("Git/GPT-SoVITS-V2/start_elaina_api.ps1")
            .display()
            .to_string(),
    );

    let mut matches = Vec::new();
    let mut seen = HashSet::new();

    for process in collect_windows_processes()? {
        if process.process_id == std::process::id() {
            continue;
        }

        let name = normalize_match_text(process.name.as_deref().unwrap_or_default());
        let executable_path =
            normalize_match_text(process.executable_path.as_deref().unwrap_or_default());
        let command_line =
            normalize_match_text(process.command_line.as_deref().unwrap_or_default());

        let reason = if executable_path == napcat_boot
            || (name == "napcatwinbootmain.exe" && command_line.contains(&napcat_root))
        {
            Some("NapCat 主进程残留")
        } else if name == "qq.exe"
            && (!napcat_root.is_empty()
                && (executable_path.contains(&napcat_root) || command_line.contains(&napcat_root)))
        {
            Some("NapCat 附带 QQ 残留")
        } else if (name == "python.exe" || name == "pythonw.exe")
            && (!maibot_script.is_empty() && command_line.contains(&maibot_script))
        {
            Some("MaiBot 主程序残留")
        } else if (name == "python.exe" || name == "pythonw.exe")
            && (!adapter_script.is_empty() && command_line.contains(&adapter_script))
        {
            Some("NapCat Adapter 残留")
        } else if (name == "powershell.exe"
            || name == "pwsh.exe"
            || name == "python.exe"
            || name == "pythonw.exe")
            && ((!tts_script.is_empty() && command_line.contains(&tts_script))
                || (!tts_root.is_empty()
                    && (executable_path.contains(&tts_root) || command_line.contains(&tts_root))))
        {
            Some("GPT-SoVITS 语音链路残留")
        } else {
            None
        };

        if let Some(reason) = reason {
            if seen.insert(process.process_id) {
                let display_name = process
                    .name
                    .as_deref()
                    .filter(|value| !value.trim().is_empty())
                    .unwrap_or("未知进程");
                matches.push((process.process_id, format!("{display_name} | {reason}")));
            }
        }
    }

    Ok(matches)
}

fn process_to_login_stability_process(process: &WindowsProcessInfo) -> LoginStabilityProcess {
    LoginStabilityProcess {
        pid: process.process_id,
        name: process
            .name
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or("未知进程")
            .to_string(),
        executable_path: process
            .executable_path
            .as_deref()
            .unwrap_or_default()
            .to_string(),
        command_line: process
            .command_line
            .as_deref()
            .unwrap_or_default()
            .to_string(),
    }
}

fn process_contains_normalized(process: &WindowsProcessInfo, needle: &str) -> bool {
    if needle.is_empty() {
        return false;
    }

    let executable_path =
        normalize_match_text(process.executable_path.as_deref().unwrap_or_default());
    let command_line = normalize_match_text(process.command_line.as_deref().unwrap_or_default());
    executable_path.contains(needle) || command_line.contains(needle)
}

fn is_napcat_qq_process(process: &WindowsProcessInfo, napcat_root: &str) -> bool {
    let name = normalize_match_text(process.name.as_deref().unwrap_or_default());
    name == "qq.exe" && process_contains_normalized(process, napcat_root)
}

fn is_napcat_boot_process(
    process: &WindowsProcessInfo,
    napcat_root: &str,
    napcat_boot: &str,
) -> bool {
    let name = normalize_match_text(process.name.as_deref().unwrap_or_default());
    name == "napcatwinbootmain.exe"
        || process_contains_normalized(process, napcat_boot)
        || (name.contains("napcat") && process_contains_normalized(process, napcat_root))
}

fn build_login_stability_report<I>(processes: I) -> LoginStabilityReport
where
    I: IntoIterator<Item = WindowsProcessInfo>,
{
    let qq_account = read_qq_account();
    let napcat = napcat_root();
    let napcat_root = normalize_match_text(napcat.display().to_string());
    let napcat_boot =
        normalize_match_text(napcat.join("NapCatWinBootMain.exe").display().to_string());
    let mut normal_qq_processes = Vec::new();
    let mut napcat_qq_processes = Vec::new();
    let mut napcat_boot_processes = Vec::new();

    for process in processes {
        let name = normalize_match_text(process.name.as_deref().unwrap_or_default());
        if is_napcat_boot_process(&process, &napcat_root, &napcat_boot) {
            napcat_boot_processes.push(process_to_login_stability_process(&process));
            continue;
        }

        if name != "qq.exe" {
            continue;
        }

        if is_napcat_qq_process(&process, &napcat_root) {
            napcat_qq_processes.push(process_to_login_stability_process(&process));
        } else {
            normal_qq_processes.push(process_to_login_stability_process(&process));
        }
    }

    let mut risk_messages = Vec::new();
    if !normal_qq_processes.is_empty()
        && (!napcat_qq_processes.is_empty() || !napcat_boot_processes.is_empty())
    {
        let account_tip = qq_account
            .as_deref()
            .map(|value| format!(" bot 号 {value}"))
            .unwrap_or_else(|| " bot 号".to_string());
        risk_messages.push(format!(
            "检测到普通 QQ 和 NapCat 同时运行。如果普通 QQ 登录的是{account_tip}，很容易触发互踢、心跳 online:false 或登录态失效。"
        ));
    }

    if napcat_boot_processes.len() > 1 {
        risk_messages.push(format!(
            "检测到 {} 个 NapCat 启动器实例，可能存在重复启动或残留进程。",
            napcat_boot_processes.len()
        ));
    }

    if napcat_boot_processes.is_empty() && !napcat_qq_processes.is_empty() {
        risk_messages.push(
            "检测到 NapCat QQ 子进程还在，但启动器不在；这通常是残留状态，建议执行稳态重登准备。"
                .to_string(),
        );
    }

    if !napcat_boot_processes.is_empty() && napcat_qq_processes.is_empty() {
        risk_messages.push(
            "NapCat 启动器存在但没有检测到 NapCat QQ 主进程；如果日志长时间停在快速登录，建议扫码重登。"
                .to_string(),
        );
    }

    let status = if risk_messages.is_empty() {
        "未发现明显 QQ 并行登录或 NapCat 残留风险。".to_string()
    } else {
        format!("发现 {} 个 QQ 登录稳定性风险。", risk_messages.len())
    };

    LoginStabilityReport {
        qq_account,
        normal_qq_processes,
        napcat_qq_processes,
        napcat_boot_processes,
        risk_messages,
        status,
    }
}

fn collect_login_stability_report(force_refresh: bool) -> Result<LoginStabilityReport, String> {
    let scan = collect_system_scan(force_refresh)?;
    Ok(build_login_stability_report(scan.process_map.into_values()))
}

fn collect_napcat_login_cleanup_processes() -> Result<Vec<(u32, String)>, String> {
    let adapter = adapter_root();
    let napcat = napcat_root();
    let napcat_root = normalize_match_text(napcat.display().to_string());
    let napcat_boot =
        normalize_match_text(napcat.join("NapCatWinBootMain.exe").display().to_string());
    let adapter_script = normalize_match_text(adapter.join("main.py").display().to_string());
    let mut matches = Vec::new();
    let mut seen = HashSet::new();

    for process in collect_windows_processes()? {
        if process.process_id == std::process::id() {
            continue;
        }

        let name = normalize_match_text(process.name.as_deref().unwrap_or_default());
        let command_line =
            normalize_match_text(process.command_line.as_deref().unwrap_or_default());

        let reason = if is_napcat_boot_process(&process, &napcat_root, &napcat_boot) {
            Some("NapCat 启动器")
        } else if is_napcat_qq_process(&process, &napcat_root) {
            Some("NapCat 附带 QQ")
        } else if (name == "python.exe" || name == "pythonw.exe")
            && !adapter_script.is_empty()
            && command_line.contains(&adapter_script)
        {
            Some("NapCat Adapter")
        } else {
            None
        };

        if let Some(reason) = reason {
            if seen.insert(process.process_id) {
                let display_name = process
                    .name
                    .as_deref()
                    .filter(|value| !value.trim().is_empty())
                    .unwrap_or("未知进程");
                matches.push((process.process_id, format!("{display_name} | {reason}")));
            }
        }
    }

    Ok(matches)
}

fn push_log_line(logs: &Arc<Mutex<VecDeque<String>>>, line: impl Into<String>) {
    if let Ok(mut guard) = logs.lock() {
        if guard.len() >= MAX_LOG_LINES {
            guard.pop_front();
        }
        guard.push_back(line.into());
    }
}

fn clear_logs(logs: &Arc<Mutex<VecDeque<String>>>) {
    if let Ok(mut guard) = logs.lock() {
        guard.clear();
    }
}

fn clone_logs(logs: &Arc<Mutex<VecDeque<String>>>) -> Vec<String> {
    logs.lock()
        .map(|guard| guard.iter().cloned().collect())
        .unwrap_or_default()
}

fn attach_log_reader<R: Read + Send + 'static>(
    reader: R,
    logs: Arc<Mutex<VecDeque<String>>>,
    prefix: &'static str,
) {
    thread::spawn(move || {
        let mut buffered = BufReader::new(reader);
        let mut bytes = Vec::new();

        loop {
            bytes.clear();
            match buffered.read_until(b'\n', &mut bytes) {
                Ok(0) => break,
                Ok(_) => {
                    let line = String::from_utf8_lossy(&bytes);
                    let clean = line.trim_end_matches(&['\r', '\n'][..]).trim();
                    if !clean.is_empty() {
                        push_log_line(&logs, format!("{prefix} {clean}"));
                    }
                }
                Err(err) => {
                    push_log_line(&logs, format!("[reader] 日志读取失败: {err}"));
                    break;
                }
            }
        }
    });
}

fn sync_process_state(handle: &mut ManagedProcess) -> (bool, Option<u32>) {
    let mut running = false;
    let mut pid = None;

    if let Some(child) = handle.child.as_mut() {
        match child.try_wait() {
            Ok(None) => {
                running = true;
                pid = Some(child.id());
            }
            Ok(Some(status)) => {
                push_log_line(&handle.logs, format!("[system] 进程已退出: {status}"));
                handle.child = None;
            }
            Err(err) => {
                push_log_line(&handle.logs, format!("[system] 查询进程状态失败: {err}"));
                handle.child = None;
            }
        }
    }

    (running, pid)
}

fn build_process_snapshots(handles: &mut HashMap<String, ManagedProcess>) -> Vec<ProcessSnapshot> {
    let scan = collect_system_scan(false).unwrap_or_else(|_| SystemScan {
        collected_at: Instant::now(),
        listening_pids: HashMap::new(),
        process_map: HashMap::new(),
    });

    build_process_specs()
        .into_iter()
        .map(|spec| {
            let mut running = false;
            let mut pid = None;
            let mut log_lines = Vec::new();
            let mut managed_by_app = false;
            let mut running_externally = false;
            let mut status_note = None;

            if let Some(handle) = handles.get_mut(spec.id) {
                let state = sync_process_state(handle);
                running = state.0;
                pid = state.1;
                managed_by_app = running;
                log_lines = clone_logs(&handle.logs);
            }

            let mut runtime_issue = if !spec.cwd.exists() {
                Some(format!("工作目录不存在: {}", spec.cwd.display()))
            } else {
                spec.issue.clone()
            };

            if !running {
                if let Some(port_owner) =
                    get_port_owner(&spec, &scan.listening_pids, &scan.process_map)
                {
                    if port_owner.kind == PortOwnerKind::Expected {
                        running = true;
                        pid = Some(port_owner.pid);
                        running_externally = true;
                        status_note = Some(format!(
                            "检测到已有外部实例运行 {}，端口 {} -> {}。",
                            spec.name,
                            spec.listen_port.unwrap_or_default(),
                            port_owner.label
                        ));
                    } else {
                        let conflict_message = format!(
                            "端口 {} 被其他程序占用：{}",
                            spec.listen_port.unwrap_or_default(),
                            port_owner.label
                        );
                        if runtime_issue.is_none() {
                            runtime_issue = Some(conflict_message.clone());
                        }
                        status_note = Some(format!(
                            "{conflict_message}，桌面端不会再误判为 {}。",
                            spec.name
                        ));
                    }
                }
            }

            if managed_by_app {
                status_note = Some("当前实例由桌面端启动并接管。".to_string());
            }

            let available = runtime_issue.is_none() && spec.program.exists() && spec.cwd.exists();
            let issue = runtime_issue;

            let command_line = if spec.args.is_empty() {
                spec.program.display().to_string()
            } else {
                format!("{} {}", spec.program.display(), spec.args.join(" "))
            };

            ProcessSnapshot {
                id: spec.id.to_string(),
                name: spec.name.to_string(),
                description: spec.description.to_string(),
                cwd: spec.cwd.display().to_string(),
                program: spec.program.display().to_string(),
                args: spec.args.clone(),
                command_line,
                available,
                issue,
                running,
                pid,
                managed_by_app,
                running_externally,
                status_note,
                log_lines,
            }
        })
        .collect()
}

fn start_spec(spec: &ProcessSpec, handle: &mut ManagedProcess) -> Result<(), String> {
    if let Some(issue) = &spec.issue {
        return Err(issue.clone());
    }
    if !spec.cwd.exists() {
        return Err(format!("工作目录不存在: {}", spec.cwd.display()));
    }
    if !spec.program.exists() {
        return Err(format!("找不到可执行文件: {}", spec.program.display()));
    }

    let (already_running, _) = sync_process_state(handle);
    if already_running {
        return Ok(());
    }

    if spec.listen_port.is_some() {
        let scan = collect_system_scan(false).unwrap_or_else(|_| SystemScan {
            collected_at: Instant::now(),
            listening_pids: HashMap::new(),
            process_map: HashMap::new(),
        });
        if let Some(port_owner) = get_port_owner(spec, &scan.listening_pids, &scan.process_map) {
            let port = spec.listen_port.unwrap_or_default();
            if port_owner.kind == PortOwnerKind::Expected {
                push_log_line(
                    &handle.logs,
                    format!(
                        "[system] 检测到 {} 已由外部实例运行，端口 {} -> {}，跳过重复启动",
                        spec.name, port, port_owner.label
                    ),
                );
                return Ok(());
            }

            return Err(format!(
                "端口 {port} 已被其他程序占用：{}",
                port_owner.label
            ));
        }
    }

    clear_logs(&handle.logs);
    push_log_line(&handle.logs, format!("[system] 正在启动 {} ...", spec.name));
    push_log_line(
        &handle.logs,
        format!(
            "[system] 命令: {} {}",
            spec.program.display(),
            spec.args.join(" ")
        ),
    );
    if spec.id == "napcat" {
        if let Ok(report) = collect_login_stability_report(false) {
            for message in report.risk_messages {
                push_log_line(&handle.logs, format!("[stability] {message}"));
            }
            if !report.normal_qq_processes.is_empty() {
                push_log_line(
                    &handle.logs,
                    format!(
                        "[stability] 当前检测到 {} 个普通 QQ 进程；如果里面登录了 bot 账号，建议先退出该账号再启动 NapCat。",
                        report.normal_qq_processes.len()
                    ),
                );
            }
        }
    }

    let mut command = Command::new(&spec.program);
    command
        .args(&spec.args)
        .current_dir(&spec.cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("PYTHONIOENCODING", "utf-8")
        .env("PYTHONUTF8", "1")
        .env("FORCE_COLOR", "1")
        .env("CLICOLOR_FORCE", "1")
        .env("PY_COLORS", "1")
        .env("TERM", "xterm-256color")
        .env("MAIBOT_LEGACY_0X_UPGRADE_CONFIRMED", "1")
        .env("MAIBOT_WEBUI_USE_LOCAL_DASHBOARD", "1");

    #[cfg(target_os = "windows")]
    {
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = command
        .spawn()
        .map_err(|err| format!("启动 {} 失败: {err}", spec.name))?;

    push_log_line(
        &handle.logs,
        format!("[system] {} 已启动，PID={}", spec.name, child.id()),
    );

    if let Some(stdout) = child.stdout.take() {
        attach_log_reader(stdout, Arc::clone(&handle.logs), "[out]");
    }
    if let Some(stderr) = child.stderr.take() {
        attach_log_reader(stderr, Arc::clone(&handle.logs), "[err]");
    }

    handle.child = Some(child);
    Ok(())
}

fn stop_handle(handle: &mut ManagedProcess, process_name: &str) -> Result<(), String> {
    let (running, _) = sync_process_state(handle);
    if !running {
        push_log_line(&handle.logs, "[system] 进程当前未运行");
        return Ok(());
    }

    if let Some(mut child) = handle.child.take() {
        child
            .kill()
            .map_err(|err| format!("停止 {process_name} 失败: {err}"))?;
        let _ = child.wait();
        push_log_line(&handle.logs, format!("[system] {process_name} 已停止"));
    }

    Ok(())
}

fn kill_pid_tree(pid: u32) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let mut command = Command::new("taskkill");
        hide_command_window(&mut command);
        let output = command
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .output()
            .map_err(|err| format!("执行 taskkill 失败: {err}"))?;

        if output.status.success() {
            invalidate_system_scan_cache();
            return Ok(());
        }

        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        let detail = if !stderr.trim().is_empty() {
            stderr.trim().to_string()
        } else {
            stdout.trim().to_string()
        };

        if detail.contains("not found")
            || detail.contains("没有运行的实例")
            || detail.contains("找不到进程")
            || detail.contains("不存在")
        {
            return Ok(());
        }

        Err(format!("结束 PID {pid} 失败: {detail}"))
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = pid;
        Err("当前仅实现了 Windows 平台的端口清理逻辑".to_string())
    }
}

fn stop_managed_processes_for_cleanup(
    handles: &mut HashMap<String, ManagedProcess>,
    specs: &[ProcessSpec],
    report_lines: &mut Vec<String>,
) -> Result<(), String> {
    for spec in specs {
        let handle = handles
            .entry(spec.id.to_string())
            .or_insert_with(ManagedProcess::new);
        let (running, pid) = sync_process_state(handle);
        if running && handle.child.is_some() {
            stop_handle(handle, spec.name)?;
            report_lines.push(format!(
                "已停止桌面端接管的 {}{}",
                spec.name,
                pid.map(|value| format!(" (PID {value})"))
                    .unwrap_or_default()
            ));
        }
    }

    Ok(())
}

fn cleanup_listening_ports(
    specs: &[ProcessSpec],
    report_lines: &mut Vec<String>,
) -> Result<(), String> {
    let scan = collect_system_scan(true)?;
    let mut killed_pids = HashSet::new();

    for spec in specs {
        let Some(port_owner) = get_port_owner(spec, &scan.listening_pids, &scan.process_map) else {
            continue;
        };

        let port = spec.listen_port.unwrap_or_default();
        if port_owner.kind != PortOwnerKind::Expected {
            report_lines.push(format!(
                "跳过端口 {} 的清理：{} 不是 {} 的已知进程",
                port, port_owner.label, spec.name
            ));
            continue;
        }

        if killed_pids.insert(port_owner.pid) {
            kill_pid_tree(port_owner.pid)?;
            report_lines.push(format!(
                "已清理占用端口 {} 的 {} (PID {})",
                port, spec.name, port_owner.pid
            ));
        } else {
            report_lines.push(format!(
                "端口 {} 仍指向已处理的 PID {}，跳过重复清理",
                port, port_owner.pid
            ));
        }
    }

    Ok(())
}

fn cleanup_runner_heartbeat(report_lines: &mut Vec<String>) -> Result<(), String> {
    let heartbeat_path = maibot_root().join("logs/runner_heartbeat.json");
    if heartbeat_path.exists() {
        fs::remove_file(&heartbeat_path)
            .map_err(|err| format!("删除 Runner 心跳文件失败: {err}"))?;
        report_lines.push("已删除残留的 runner_heartbeat.json".to_string());
    }

    Ok(())
}

fn push_cleanup_report(
    handles: &mut HashMap<String, ManagedProcess>,
    specs: &[ProcessSpec],
    report_lines: &[String],
    prefix: &str,
) {
    for spec in specs {
        let handle = handles
            .entry(spec.id.to_string())
            .or_insert_with(ManagedProcess::new);
        for line in report_lines {
            push_log_line(&handle.logs, format!("{prefix} {line}"));
        }
    }
}

fn cleanup_process_conflicts_inner(
    handles: &mut HashMap<String, ManagedProcess>,
) -> Result<Vec<String>, String> {
    let specs = build_process_specs();
    let mut report_lines = Vec::new();

    stop_managed_processes_for_cleanup(handles, &specs, &mut report_lines)?;
    cleanup_listening_ports(&specs, &mut report_lines)?;
    cleanup_runner_heartbeat(&mut report_lines)?;

    if report_lines.is_empty() {
        report_lines.push("没有发现需要清理的端口占用或桌面端残留进程。".to_string());
    }

    push_cleanup_report(handles, &specs, &report_lines, "[cleanup]");

    Ok(report_lines)
}

fn deep_cleanup_process_state_inner(
    handles: &mut HashMap<String, ManagedProcess>,
) -> Result<Vec<String>, String> {
    let specs = build_process_specs();
    let mut report_lines = Vec::new();

    stop_managed_processes_for_cleanup(handles, &specs, &mut report_lines)?;
    cleanup_listening_ports(&specs, &mut report_lines)?;

    let mut cleaned_related = 0usize;
    for (pid, reason) in collect_related_processes()? {
        kill_pid_tree(pid)?;
        cleaned_related += 1;
        report_lines.push(format!("已强制清理残留进程 {reason} (PID {pid})"));
    }

    cleanup_runner_heartbeat(&mut report_lines)?;
    if cleaned_related > 0 {
        thread::sleep(Duration::from_millis(450));
    }

    if report_lines.is_empty() {
        report_lines.push("没有发现需要重置的残留进程、端口占用或心跳文件。".to_string());
    } else {
        report_lines.push("深度清理已完成，建议现在重新点击“全部启动”。".to_string());
    }

    push_cleanup_report(handles, &specs, &report_lines, "[deep-cleanup]");

    Ok(report_lines)
}

fn prepare_stable_qq_login_inner(
    handles: &mut HashMap<String, ManagedProcess>,
) -> Result<Vec<String>, String> {
    let specs = build_process_specs()
        .into_iter()
        .filter(|spec| spec.id == "adapter" || spec.id == "napcat")
        .collect::<Vec<_>>();
    let mut report_lines = Vec::new();

    stop_managed_processes_for_cleanup(handles, &specs, &mut report_lines)?;
    cleanup_listening_ports(&specs, &mut report_lines)?;

    let mut cleaned_related = 0usize;
    for (pid, reason) in collect_napcat_login_cleanup_processes()? {
        kill_pid_tree(pid)?;
        cleaned_related += 1;
        report_lines.push(format!("已清理 QQ 登录链路残留进程 {reason} (PID {pid})"));
    }

    if cleaned_related > 0 {
        thread::sleep(Duration::from_millis(450));
    }

    let login_report = collect_login_stability_report(true)?;
    if !login_report.normal_qq_processes.is_empty() {
        report_lines.push(format!(
            "仍检测到 {} 个普通 QQ 进程；桌面端不会自动关闭它们。如果普通 QQ 登录的是 bot 号，请先手动退出该账号。",
            login_report.normal_qq_processes.len()
        ));
        for process in login_report.normal_qq_processes.iter().take(3) {
            report_lines.push(format!(
                "普通 QQ 进程: PID {} | {}",
                process.pid, process.executable_path
            ));
        }
    }

    if report_lines.is_empty() {
        report_lines.push("未发现需要清理的 NapCat/Adapter 残留。".to_string());
    }
    report_lines.push(
        "稳态重登准备完成：现在建议等待 10 秒，再启动 Adapter 和 NapCat；如果 NapCat 仍提示登录态失效，需要在 NapCat WebUI 扫码一次。"
            .to_string(),
    );

    push_cleanup_report(handles, &specs, &report_lines, "[login-stability]");

    Ok(report_lines)
}

#[tauri::command]
fn get_service_endpoints() -> Vec<ServiceEndpoint> {
    vec![
        ServiceEndpoint {
            id: "maibot".to_string(),
            name: "MaiBot WebUI".to_string(),
            description: "主控制台入口，后续会接入运行管理、插件管理、知识库和日志总览。"
                .to_string(),
            default_url: "http://127.0.0.1:8001".to_string(),
            troubleshooting_tip: "适合正常操作；如果页面异常，直接切浏览器打开。".to_string(),
        },
        ServiceEndpoint {
            id: "napcat".to_string(),
            name: "NapCat WebUI".to_string(),
            description: "QQ 登录与连接配置入口，后续会扩展成内置登录和状态修复模块。".to_string(),
            default_url: detect_napcat_webui_url(),
            troubleshooting_tip: "扫码、Token、网络配置和掉线排查优先走这里。".to_string(),
        },
    ]
}

fn is_allowed_local_url(url: &str) -> bool {
    let normalized = normalize_local_url(url);
    let lowered = normalized.to_ascii_lowercase();
    let safe_chars = !url.contains('"')
        && !url.contains('&')
        && !url.contains('|')
        && !url.contains('>')
        && !url.contains('<');

    safe_chars
        && (lowered.starts_with("http://127.0.0.1:")
            || lowered.starts_with("http://localhost:")
            || lowered.starts_with("http://[::1]:"))
}

#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    if !is_allowed_local_url(&url) {
        return Err("只允许打开本机的 MaiBot / NapCat 地址".to_string());
    }

    let normalized = normalize_local_url(&url);

    #[cfg(target_os = "windows")]
    {
        let mut command = Command::new("cmd");
        hide_command_window(&mut command);
        command
            .args(["/C", "start", "", &normalized])
            .spawn()
            .map_err(|err| format!("打开浏览器失败: {err}"))?;
    }

    #[cfg(not(target_os = "windows"))]
    {
        return Err("当前仅实现了 Windows 平台的浏览器打开逻辑".to_string());
    }

    Ok(())
}

#[tauri::command]
fn get_process_snapshots(
    state: tauri::State<ProcessRegistry>,
) -> Result<Vec<ProcessSnapshot>, String> {
    let mut handles = state
        .handles
        .lock()
        .map_err(|_| "进程状态锁定失败".to_string())?;
    Ok(build_process_snapshots(&mut handles))
}

#[tauri::command]
fn start_managed_process(
    process_id: String,
    state: tauri::State<ProcessRegistry>,
) -> Result<Vec<ProcessSnapshot>, String> {
    let spec = build_process_specs()
        .into_iter()
        .find(|item| item.id == process_id)
        .ok_or_else(|| format!("未知进程: {process_id}"))?;

    let mut handles = state
        .handles
        .lock()
        .map_err(|_| "进程状态锁定失败".to_string())?;
    let handle = handles
        .entry(spec.id.to_string())
        .or_insert_with(ManagedProcess::new);
    start_spec(&spec, handle)?;
    Ok(build_process_snapshots(&mut handles))
}

#[tauri::command]
fn stop_managed_process(
    process_id: String,
    state: tauri::State<ProcessRegistry>,
) -> Result<Vec<ProcessSnapshot>, String> {
    let specs = build_process_specs();
    let spec = specs
        .iter()
        .find(|item| item.id == process_id)
        .ok_or_else(|| format!("未知进程: {process_id}"))?;

    let mut handles = state
        .handles
        .lock()
        .map_err(|_| "进程状态锁定失败".to_string())?;
    let handle = handles
        .entry(spec.id.to_string())
        .or_insert_with(ManagedProcess::new);
    stop_handle(handle, spec.name)?;
    Ok(build_process_snapshots(&mut handles))
}

#[tauri::command]
fn start_all_managed_processes(
    state: tauri::State<ProcessRegistry>,
) -> Result<Vec<ProcessSnapshot>, String> {
    let specs = build_process_specs();
    let mut handles = state
        .handles
        .lock()
        .map_err(|_| "进程状态锁定失败".to_string())?;
    let _ = collect_system_scan(true);

    let mut errors = Vec::new();

    for spec in specs.iter().filter(|spec| {
        !matches!(
            spec.id,
            "maicraft-next" | "forge-client" | "forge-agent" | "bilibili-live"
        )
    }) {
        let handle = handles
            .entry(spec.id.to_string())
            .or_insert_with(ManagedProcess::new);
        if let Err(err) = start_spec(spec, handle) {
            push_log_line(&handle.logs, format!("[system] 启动失败: {err}"));
            errors.push(format!("{}：{err}", spec.name));
        }
    }

    if errors.is_empty() {
        Ok(build_process_snapshots(&mut handles))
    } else {
        Err(format!("以下进程启动失败：{}", errors.join("；")))
    }
}

#[tauri::command]
fn stop_all_managed_processes(
    state: tauri::State<ProcessRegistry>,
) -> Result<Vec<ProcessSnapshot>, String> {
    let specs = build_process_specs();
    let mut handles = state
        .handles
        .lock()
        .map_err(|_| "进程状态锁定失败".to_string())?;

    for spec in &specs {
        let handle = handles
            .entry(spec.id.to_string())
            .or_insert_with(ManagedProcess::new);
        let _ = stop_handle(handle, spec.name);
    }

    Ok(build_process_snapshots(&mut handles))
}

#[tauri::command]
fn clear_process_logs(
    process_id: String,
    state: tauri::State<ProcessRegistry>,
) -> Result<Vec<ProcessSnapshot>, String> {
    let mut handles = state
        .handles
        .lock()
        .map_err(|_| "进程状态锁定失败".to_string())?;

    let handle = handles
        .entry(process_id)
        .or_insert_with(ManagedProcess::new);
    clear_logs(&handle.logs);
    push_log_line(&handle.logs, "[system] 日志已清空");

    Ok(build_process_snapshots(&mut handles))
}

#[tauri::command]
fn cleanup_process_conflicts(
    state: tauri::State<ProcessRegistry>,
) -> Result<Vec<ProcessSnapshot>, String> {
    let mut handles = state
        .handles
        .lock()
        .map_err(|_| "进程状态锁定失败".to_string())?;

    cleanup_process_conflicts_inner(&mut handles)?;
    Ok(build_process_snapshots(&mut handles))
}

#[tauri::command]
fn deep_cleanup_process_state(
    state: tauri::State<ProcessRegistry>,
) -> Result<Vec<ProcessSnapshot>, String> {
    let mut handles = state
        .handles
        .lock()
        .map_err(|_| "进程状态锁定失败".to_string())?;

    deep_cleanup_process_state_inner(&mut handles)?;
    Ok(build_process_snapshots(&mut handles))
}

#[tauri::command]
fn get_login_stability_report() -> Result<LoginStabilityReport, String> {
    collect_login_stability_report(false)
}

#[tauri::command]
fn prepare_stable_qq_login(
    state: tauri::State<ProcessRegistry>,
) -> Result<Vec<ProcessSnapshot>, String> {
    let mut handles = state
        .handles
        .lock()
        .map_err(|_| "进程状态锁定失败".to_string())?;

    prepare_stable_qq_login_inner(&mut handles)?;
    Ok(build_process_snapshots(&mut handles))
}

#[tauri::command]
fn get_login_helper_config() -> LoginHelperConfig {
    load_login_helper_config_inner()
}

#[tauri::command]
fn save_login_helper_config(config: LoginHelperConfig) -> Result<LoginHelperConfig, String> {
    let mut normalized = config;
    normalized.recipient_email = normalize_owner_email(&normalized.recipient_email);
    if normalized.smtp_from.trim().is_empty() && !normalized.smtp_username.trim().is_empty() {
        normalized.smtp_from = normalized.smtp_username.trim().to_string();
    }
    if normalized.smtp_port == 0 {
        normalized.smtp_port = LoginHelperConfig::default().smtp_port;
    }
    save_login_helper_config_inner(&normalized)?;
    Ok(normalized)
}

#[tauri::command]
fn get_login_helper_status() -> LoginHelperStatus {
    let config = load_login_helper_config_inner();
    build_login_helper_status(&config)
}

#[tauri::command]
fn send_login_helper_email(request: SendLoginEmailRequest) -> Result<String, String> {
    send_login_helper_email_inner(request)
}

#[tauri::command]
fn get_realtime_screen_context() -> Result<String, String> {
    #[cfg(target_os = "windows")]
    {
        let (title, process) = read_foreground_window_context();
        if title.is_empty() && process.is_empty() {
            Ok("当前没有可识别的前台窗口。".to_string())
        } else if title.is_empty() {
            Ok(format!("当前前台进程：{process}"))
        } else {
            Ok(format!("当前前台窗口：{title}；进程：{process}"))
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        Err("当前仅支持 Windows 读取屏幕上下文。".to_string())
    }
}

#[cfg(target_os = "windows")]
fn read_foreground_window_context() -> (String, String) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, GetWindowTextW, GetWindowThreadProcessId,
    };

    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.is_null() {
            return (String::new(), String::new());
        }

        let mut title_buffer = [0u16; 512];
        let title_len = GetWindowTextW(hwnd, title_buffer.as_mut_ptr(), title_buffer.len() as i32);
        let title = if title_len > 0 {
            OsString::from_wide(&title_buffer[..title_len as usize])
                .to_string_lossy()
                .trim()
                .to_string()
        } else {
            String::new()
        };

        let mut process_id = 0u32;
        GetWindowThreadProcessId(hwnd, &mut process_id);
        let process = read_process_name(process_id);

        (title, process)
    }
}

#[cfg(target_os = "windows")]
fn read_process_name(process_id: u32) -> String {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    if process_id == 0 {
        return String::new();
    }

    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, process_id);
        if handle.is_null() {
            return format!("pid:{process_id}");
        }

        let mut path_buffer = [0u16; 1024];
        let mut path_len = path_buffer.len() as u32;
        let ok = QueryFullProcessImageNameW(handle, 0, path_buffer.as_mut_ptr(), &mut path_len);
        CloseHandle(handle);

        if ok == 0 || path_len == 0 {
            return format!("pid:{process_id}");
        }

        let process_path = OsString::from_wide(&path_buffer[..path_len as usize])
            .to_string_lossy()
            .to_string();
        Path::new(&process_path)
            .file_stem()
            .and_then(|value| value.to_str())
            .filter(|value| !value.trim().is_empty())
            .unwrap_or(&process_path)
            .trim()
            .to_string()
    }
}

#[tauri::command]
fn get_maicraft_config() -> MaicraftConfig {
    load_maicraft_config_inner()
}

#[tauri::command]
fn save_maicraft_config(config: MaicraftConfig) -> Result<MaicraftConfig, String> {
    save_maicraft_config_inner(config)
}

fn forge_bridge_url(path: &str) -> String {
    format!("http://127.0.0.1:25115{path}")
}

async fn forge_bridge_post_form(
    path: &str,
    params: Vec<(&'static str, String)>,
) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(3))
        .build()
        .map_err(|err| format!("创建 Forge 桥接客户端失败: {err}"))?;
    let response = client
        .post(forge_bridge_url(path))
        .form(&params)
        .send()
        .await
        .map_err(|err| {
            format!(
                "Forge 桥接未连接。请先重启 Forge 真客户端并确认已加载 MaiBot Forge Bridge mod: {err}"
            )
        })?;
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|err| format!("读取 Forge 桥接响应失败: {err}"))?;
    if !status.is_success() {
        return Err(format!("Forge 桥接返回错误 {status}: {text}"));
    }
    Ok(text)
}

#[tauri::command]
async fn forge_bridge_status() -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(3))
        .build()
        .map_err(|err| format!("创建 Forge 桥接客户端失败: {err}"))?;
    let response = client
        .get(forge_bridge_url("/status"))
        .send()
        .await
        .map_err(|err| {
            format!(
                "Forge 桥接未连接。请先重启 Forge 真客户端并确认已加载 MaiBot Forge Bridge mod: {err}"
            )
        })?;
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|err| format!("读取 Forge 桥接状态失败: {err}"))?;
    if !status.is_success() {
        return Err(format!("Forge 桥接返回错误 {status}: {text}"));
    }
    Ok(text)
}

#[tauri::command]
async fn forge_bridge_scan(
    targets: Option<String>,
    radius: Option<u16>,
    limit: Option<u16>,
) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(3))
        .build()
        .map_err(|err| format!("创建 Forge 桥接客户端失败: {err}"))?;
    let response = client
        .get(forge_bridge_url("/scan"))
        .query(&[
            ("targets", targets.unwrap_or_default()),
            ("radius", radius.unwrap_or(8).to_string()),
            ("limit", limit.unwrap_or(24).to_string()),
        ])
        .send()
        .await
        .map_err(|err| {
            format!(
                "Forge 桥接未连接。请先重启 Forge 真客户端并确认已加载 MaiBot Forge Bridge mod: {err}"
            )
        })?;
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|err| format!("读取 Forge 桥接扫描结果失败: {err}"))?;
    if !status.is_success() {
        return Err(format!("Forge 桥接返回错误 {status}: {text}"));
    }
    Ok(text)
}

#[tauri::command]
async fn forge_bridge_command(request: ForgeBridgeCommandRequest) -> Result<String, String> {
    let action = request.action.trim().to_ascii_lowercase();
    if action.is_empty() {
        return Err("Forge 桥接动作不能为空。".to_string());
    }

    let mut params = vec![("action", action)];
    if let Some(value) = request.forward {
        params.push(("forward", value.to_string()));
    }
    if let Some(value) = request.back {
        params.push(("back", value.to_string()));
    }
    if let Some(value) = request.left {
        params.push(("left", value.to_string()));
    }
    if let Some(value) = request.right {
        params.push(("right", value.to_string()));
    }
    if let Some(value) = request.sprint {
        params.push(("sprint", value.to_string()));
    }
    if let Some(value) = request.sneak {
        params.push(("sneak", value.to_string()));
    }
    if let Some(value) = request.duration {
        params.push(("duration", value.to_string()));
    }
    if let Some(value) = request.yaw {
        params.push(("yaw", value.to_string()));
    }
    if let Some(value) = request.pitch {
        params.push(("pitch", value.to_string()));
    }
    if let Some(value) = request.targets {
        params.push(("targets", value));
    }
    if let Some(value) = request.radius {
        params.push(("radius", value.to_string()));
    }
    if let Some(value) = request.timeout {
        params.push(("timeout", value.to_string()));
    }
    if let Some(value) = request.x {
        params.push(("x", value.to_string()));
    }
    if let Some(value) = request.y {
        params.push(("y", value.to_string()));
    }
    if let Some(value) = request.z {
        params.push(("z", value.to_string()));
    }
    if let Some(value) = request.length {
        params.push(("length", value.to_string()));
    }
    if let Some(value) = request.width {
        params.push(("width", value.to_string()));
    }
    if let Some(value) = request.height {
        params.push(("height", value.to_string()));
    }
    if let Some(value) = request.depth {
        params.push(("depth", value.to_string()));
    }
    if let Some(value) = request.input {
        params.push(("input", value));
    }
    if let Some(value) = request.fuel {
        params.push(("fuel", value));
    }
    if let Some(value) = request.block {
        params.push(("block", value));
    }
    if let Some(value) = request.search {
        params.push(("search", value));
    }
    if let Some(value) = request.model {
        params.push(("model", value));
    }
    if let Some(value) = request.model_id {
        params.push(("modelId", value));
    }
    if let Some(value) = request.texture {
        params.push(("texture", value));
    }
    if let Some(value) = request.texture_id {
        params.push(("textureId", value));
    }
    if let Some(value) = request.target {
        params.push(("target", value));
    }
    if let Some(value) = request.ignore_auth {
        params.push(("ignoreAuth", value.to_string()));
    }
    if let Some(value) = request.command {
        params.push(("command", value));
    }

    forge_bridge_post_form("/command", params).await
}

#[tauri::command]
async fn forge_bridge_chat(text: String) -> Result<String, String> {
    let message = text.trim();
    if message.is_empty() {
        return Err("要发送到 Minecraft 的聊天内容不能为空。".to_string());
    }
    forge_bridge_post_form("/chat", vec![("text", message.to_string())]).await
}

#[tauri::command]
fn get_voice_chat_config() -> VoiceChatConfig {
    load_voice_chat_config_inner()
}

#[tauri::command]
fn save_voice_chat_config(config: VoiceChatConfig) -> Result<VoiceChatConfig, String> {
    save_voice_chat_config_inner(&config)?;
    Ok(config)
}

#[tauri::command]
fn clear_voice_chat_history(state: tauri::State<VoiceChatState>) -> Result<(), String> {
    let mut history = state
        .history
        .lock()
        .map_err(|_| "语音对话上下文锁定失败".to_string())?;
    history.clear();
    Ok(())
}

async fn complete_voice_reply_turn(
    transcript: String,
    source_label: Option<&str>,
    config: &VoiceChatConfig,
    screen_context: Option<&str>,
    state: &VoiceChatState,
    asr_model: String,
) -> Result<VoiceChatResponse, String> {
    let history_snapshot = {
        let history = state
            .history
            .lock()
            .map_err(|_| "语音对话上下文锁定失败".to_string())?;
        history.clone()
    };

    let output_language = config.output_language.trim();
    let model_input = match source_label
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        Some(label) => format!("{label}：{transcript}"),
        None => transcript.clone(),
    };
    let (reply_text, reply_model) = call_reply_model(
        &model_input,
        output_language,
        &history_snapshot,
        screen_context,
    )
    .await?;
    if reply_text.trim().is_empty() {
        return Err("回复模型返回为空。".to_string());
    }

    let audio = call_elaina_tts(&reply_text, config).await?;
    let audio_base64 = general_purpose::STANDARD.encode(audio);
    if let Err(err) = store_voice_turn_to_maibot_db(&model_input, &reply_text) {
        eprintln!("[voice_chat] 写入 MaiBot 聊天记录失败: {err}");
    }

    {
        let mut history = state
            .history
            .lock()
            .map_err(|_| "语音对话上下文锁定失败".to_string())?;
        history.push(VoiceChatMessage {
            role: "user".to_string(),
            content: model_input,
        });
        history.push(VoiceChatMessage {
            role: "assistant".to_string(),
            content: reply_text.clone(),
        });
        let max_messages = config.max_history_turns.max(1) * 2;
        if history.len() > max_messages {
            let drain_count = history.len() - max_messages;
            history.drain(0..drain_count);
        }
    }

    Ok(VoiceChatResponse {
        transcript,
        reply_text,
        audio_base64,
        audio_mime: "audio/wav".to_string(),
        asr_model,
        reply_model,
    })
}

#[tauri::command]
async fn voice_chat_turn(
    request: VoiceChatRequest,
    state: tauri::State<'_, VoiceChatState>,
) -> Result<VoiceChatResponse, String> {
    let audio_base64 = strip_data_url_prefix(&request.audio_base64).trim();
    let audio_bytes = general_purpose::STANDARD
        .decode(audio_base64)
        .map_err(|err| format!("录音 Base64 解码失败: {err}"))?;
    if audio_bytes.is_empty() {
        return Err("录音为空，请重新录制。".to_string());
    }

    let mime_type = request.mime_type.clone();
    let wav_audio = tauri::async_runtime::spawn_blocking(move || {
        convert_audio_to_wav(&audio_bytes, &mime_type)
    })
    .await
    .map_err(|err| format!("录音转码任务失败: {err}"))??;
    let transcript = call_doubao_asr(wav_audio, &request.config).await?;

    complete_voice_reply_turn(
        transcript,
        None,
        &request.config,
        request.screen_context.as_deref(),
        &state,
        request.config.asr_model.clone(),
    )
    .await
}

#[tauri::command]
async fn voice_text_turn(
    request: VoiceTextTurnRequest,
    state: tauri::State<'_, VoiceChatState>,
) -> Result<VoiceChatResponse, String> {
    let transcript = request.text.trim().to_string();
    if transcript.is_empty() {
        return Err("文字内容为空，无法生成语音回复。".to_string());
    }
    complete_voice_reply_turn(
        transcript,
        request.source_label.as_deref(),
        &request.config,
        request.screen_context.as_deref(),
        &state,
        "text".to_string(),
    )
    .await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(ProcessRegistry::default())
        .manage(VoiceChatState::default())
        .invoke_handler(tauri::generate_handler![
            get_service_endpoints,
            open_external_url,
            get_process_snapshots,
            start_managed_process,
            stop_managed_process,
            start_all_managed_processes,
            stop_all_managed_processes,
            clear_process_logs,
            cleanup_process_conflicts,
            deep_cleanup_process_state,
            get_login_stability_report,
            prepare_stable_qq_login,
            get_login_helper_config,
            save_login_helper_config,
            get_login_helper_status,
            send_login_helper_email,
            get_realtime_screen_context,
            get_maicraft_config,
            save_maicraft_config,
            forge_bridge_status,
            forge_bridge_scan,
            forge_bridge_command,
            forge_bridge_chat,
            get_voice_chat_config,
            save_voice_chat_config,
            clear_voice_chat_history,
            voice_chat_turn,
            voice_text_turn
        ])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
