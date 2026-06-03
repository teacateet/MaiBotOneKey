import os
import subprocess
import tomlkit  # 替换 tomli
from typing import Optional, List, Callable
import re
import shutil
from contextlib import suppress
from init_napcat import create_napcat_config, create_onebot_config
try:
    from modules.MaiBot.src.common.logger import get_logger  # 确保路径正确
    logger = get_logger("init")
except ImportError:
    from loguru import logger
import requests


ONEKEY_VERSION = "6.0.0" 

def get_absolute_path(relative_path: str) -> str:
    """获取绝对路径
    
    Args:
        relative_path: 相对路径
        
    Returns:
        str: 绝对路径
    """
    script_dir = os.path.dirname(os.path.abspath(__file__))
    return os.path.join(script_dir, relative_path)

def parse_toml_error_message(error_message: str) -> str:
    """解析TOML错误信息并返回中文错误描述
    
    Args:
        error_message: 原始错误信息
        
    Returns:
        str: 中文错误描述
    """
    error_message_zh = f"配置文件解析失败: {error_message}"
    line_num, col_num = None, None
    
    # 尝试从错误信息中提取行列号
    if " at line " in error_message and " col " in error_message:
        with suppress(IndexError):
            loc_part = error_message.split(" at line ")[-1]
            parts = loc_part.strip().split(" col ")
            line_num = parts[0].strip()
            if len(parts) > 1:
                col_num = parts[1].strip().split()[0]
    
    # 根据具体的错误类型生成汉化信息
    if "Unexpected character" in error_message and line_num and col_num:
        char_info = "未知"
        with suppress(IndexError):
            char_info = error_message.split("'")[1]
        error_message_zh = f"配置文件语法错误：在第 {line_num} 行，第 {col_num} 列遇到了意外的字符 '{char_info}'。"
    elif "Unclosed string" in error_message and line_num and col_num:
        error_message_zh = f"配置文件语法错误：在第 {line_num} 行，第 {col_num} 列存在未闭合的字符串。"
    elif "Expected a key" in error_message and line_num and col_num:
        error_message_zh = f"配置文件语法错误：在第 {line_num} 行，第 {col_num} 列期望一个键（key）。"
    elif "Duplicate key" in error_message:
        key_name = "未知"
        with suppress(IndexError):
            key_name = error_message.split("'")[1]
        error_message_zh = f"配置文件错误：存在重复的键 '{key_name}'。"
        if line_num and col_num:
            error_message_zh += f" (大致位置在第 {line_num} 行，第 {col_num} 列附近)"
    elif "Invalid escape sequence" in error_message and line_num and col_num:
        error_message_zh = f"配置文件语法错误：在第 {line_num} 行，第 {col_num} 列存在无效的转义序列。"
    elif "Expected newline or end of file" in error_message and line_num and col_num:
        error_message_zh = f"配置文件语法错误：在第 {line_num} 行，第 {col_num} 列处，期望换行或文件结束。"
    
    return error_message_zh


def read_qq_from_config() -> Optional[str]:
    config_path = get_absolute_path('modules/MaiBot/config/bot_config.toml')
    template_path = get_absolute_path('modules/MaiBot/template/bot_config_template.toml')
    
    # 如果配置文件不存在，尝试从模板复制
    if not os.path.exists(config_path) and os.path.exists(template_path):
        config_dir = os.path.dirname(config_path)
        if not os.path.exists(config_dir):
            os.makedirs(config_dir)
        shutil.copy2(template_path, config_path)
        logger.info(f"已从模板创建配置文件: {config_path}")
    
    try:
        if not os.path.exists(config_path):
            logger.error(f"错误：找不到配置文件 {config_path}")
            return None
        with open(config_path, 'r', encoding='utf-8') as f:  # 修改为 'r' 和 utf-8 编码
            config = tomlkit.load(f)  # 使用 tomlkit.load
        if 'bot' not in config or 'qq_account' not in config['bot']:
            logger.error("错误：配置文件格式不正确，缺少 bot.qq_account 配置项")
            return None
        return str(config['bot']['qq_account'])  # 确保返回字符串
    except tomlkit.exceptions.TOMLKitError as e:
        error_message_zh = parse_toml_error_message(str(e))
        logger.error(error_message_zh)
        return None
    except Exception as e:
        logger.error(f"错误：读取配置文件时出现异常：{str(e)}")
        return None

def validate_directory_exists(directory: str) -> bool:
    """验证目录是否存在
    
    Args:
        directory: 目录路径
        
    Returns:
        bool: 目录是否存在
    """
    if not os.path.exists(directory):
        logger.error(f"错误：目录不存在 {directory}")
        return False
    return True


def create_cmd_window(cwd: str, command: str) -> bool:
    """创建新的命令行窗口并执行命令
    
    Args:
        cwd: 工作目录
        command: 要执行的命令
        
    Returns:
        bool: 是否成功创建窗口
    """
    try:
        if not validate_directory_exists(cwd):
            return False
            
        # 使用项目自带的 Python 环境
        python_path = get_absolute_path('runtime/python31211/bin/python.exe')
        
        # 如果命令中包含 python，则替换为完整路径
        if command.startswith('python '):
            command = command.replace('python ', f'"{python_path}" ', 1)
        elif command == 'python':
            command = f'"{python_path}"'
        
        full_command = f'start cmd /k "cd /d "{cwd}" && {command}"'
        subprocess.run(full_command, shell=True, check=True)
        return True
    except subprocess.CalledProcessError as e:
        logger.error(f"错误：命令执行失败：{str(e)}")
        return False
    except Exception as e:
        logger.error(f"错误：启动进程时出现异常：{str(e)}")
        return False

def check_napcat() -> bool:
    napcat_path = get_absolute_path('modules/napcat')
    napcat_exe = os.path.join(napcat_path, 'NapCatWinBootMain.exe')
    if not os.path.exists(napcat_exe):
        logger.error(f"错误：找不到NapCat可执行文件 {napcat_exe}")
        return False
    return True

def add_qq_number():
    config_path = get_absolute_path('modules/MaiBot/config/bot_config.toml')
    template_path = get_absolute_path('modules/MaiBot/template/bot_config_template.toml')
    
    # 确保配置文件存在
    if not os.path.exists(config_path) and os.path.exists(template_path):
        config_dir = os.path.dirname(config_path)
        if not os.path.exists(config_dir):
            os.makedirs(config_dir)
        shutil.copy2(template_path, config_path)
        logger.info(f"已从模板创建配置文件: {config_path}")
    
    try:
        while True:
            qq = input("请输入要添加/修改的QQ号：").strip()
            if not re.match(r'^\d+$', qq):
                logger.error("错误：QQ号必须为纯数字")
                continue

            # 更新主配置
            update_qq_in_config(config_path, qq)
            
            # 创建NapCat相关配置
            create_napcat_config(qq)
            create_onebot_config(qq)
            
            logger.info(f"QQ号 {qq} 配置已更新并创建必要文件！")
            return
    except Exception as e:
        logger.error(f"保存配置失败：{str(e)}")

def modify_allowed_chats():
    """修改可发消息群聊&私聊"""
    config_path = os.path.dirname(os.path.abspath(__file__))
    info_cmd = "CHCP 65001 & echo 群聊、私聊白名单/黑名单配置已经迁移至WebUI，请启动主程序之后，通过浏览器访问 http://localhost:8001 进行管理。& echo 具体操作： & echo 1.侧边栏选择‘麦麦适配器配置’. & echo 2.工作模式选择‘预设模式’中的‘一键包模式’. & echo 3.修改聊天控制部分的配置并点击‘保存’. & echo 4.重启适配器. & pause"
    return create_cmd_window(config_path, info_cmd)


def install_vc_redist():
    """静默安装VC运行库"""
    vc_path = get_absolute_path('modules/onepackdata/vc_redist.x64.exe')
    if not os.path.exists(vc_path):
        logger.warning(f"警告：未找到VC运行库安装包 {vc_path}")
        return
    try:
        # /install /quiet /norestart 静默安装
        subprocess.run([vc_path, '/install', '/quiet', '/norestart'], check=True)
        logger.info("VC运行库已检测并安装（如已安装则自动跳过）")
    except subprocess.CalledProcessError:
        logger.warning("警告：VC运行库安装失败，可能已安装或权限不足")
        print(f"请手动运行以下文件进行安装：\n{vc_path}")
    except Exception as e:
        logger.warning(f"警告：VC运行库安装异常：{str(e)}")
        print(f"请手动运行以下文件进行安装：\n{vc_path}")

def launch_napcat(qq_number: Optional[str] = None, headed_mode: bool = False) -> bool:
    """启动NapCat
    
    Args:
        qq_number: QQ号，如果为None则从配置文件读取
        headed_mode: 是否使用有头模式
        
    Returns:
        bool: 启动是否成功
    """
    if not qq_number:
        qq_number = read_qq_from_config()
    
    if not qq_number:
        return False

    # 动态获取 webui token
    def _load_napcat_token() -> Optional[str]:
        import json
        import secrets
        base_new_headed = get_absolute_path('modules/napcatframework/versions')
        base_new_headless = get_absolute_path('modules/napcat/versions')
        candidates = []
        # 收集所有 versions/* 目录下的 webui.json 两种可能路径
        for base in [base_new_headless, base_new_headed]:
            if not os.path.isdir(base):
                continue
            try:
                for ver in os.listdir(base):
                    ver_dir = os.path.join(base, ver)
                    if not os.path.isdir(ver_dir):
                        continue
                    # 两种实际文件路径
                    path1 = os.path.join(ver_dir, 'resources', 'app', 'napcat', 'config', 'webui.json')
                    path2 = os.path.join(ver_dir, 'resources', 'app', 'LiteLoader', 'plugins', 'NapCat', 'config', 'webui.json')
                    candidates.extend([path1, path2])
            except Exception as _e:
                logger.debug(f"遍历 {base} 出错: {_e}")

        # 过滤存在的文件并按修改时间排序
        existing = [p for p in candidates if os.path.exists(p)]
        existing.sort(key=lambda p: os.path.getmtime(p), reverse=True)
        for file in existing:
            try:
                with open(file, 'r', encoding='utf-8') as f:
                    data = json.load(f)
                token = data.get('token')
                if token:
                    logger.info(f"已从 {file} 读取 NapCat WebUI token")
                    return str(token)
            except Exception as _e:
                logger.warning(f"读取 token 失败 {file}: {_e}")

        # 没有任何 webui.json：尝试为最新版本目录创建一个
        version_roots = [b for b in [base_new_headless, base_new_headed] if os.path.isdir(b)]
        chosen_version_dir = None
        latest_mtime = -1
        for root in version_roots:
            try:
                for ver in os.listdir(root):
                    ver_dir = os.path.join(root, ver)
                    if os.path.isdir(ver_dir):
                        mtime = os.path.getmtime(ver_dir)
                        if mtime > latest_mtime:
                            latest_mtime = mtime
                            chosen_version_dir = ver_dir
            except Exception as _e:
                logger.debug(f"扫描版本目录 {root} 出错: {_e}")

        if chosen_version_dir:
            # 优先 napcat/config 路径，其次 LiteLoader 路径
            create_paths = [
                os.path.join(chosen_version_dir, 'resources', 'app', 'napcat', 'config'),
                os.path.join(chosen_version_dir, 'resources', 'app', 'LiteLoader', 'plugins', 'NapCat', 'config')
            ]
            # 生成 12 位 hex token
            token = secrets.token_hex(6)
            default_json = {
                "host": "0.0.0.0",
                "port": 6099,
                "token": token,
                "loginRate": 10,
                "autoLoginAccount": "",
                "theme": {"dark": {}, "light": {}},  # 为减小体积，这里不写全部主题，NapCat 启动后会补全或忽略
                "disableWebUI": False,
                "disableNonLANAccess": False
            }
            for cfg_dir in create_paths:
                try:
                    os.makedirs(cfg_dir, exist_ok=True)
                    target_file = os.path.join(cfg_dir, 'webui.json')
                    if not os.path.exists(target_file):
                        with open(target_file, 'w', encoding='utf-8') as f:
                            json.dump(default_json, f, ensure_ascii=False, indent=4)
                        logger.info(f"已创建缺失的 NapCat webui.json 并生成 token({token[:4]}***): {target_file}")
                        return token
                except Exception as _e:
                    logger.warning(f"创建默认 webui.json 失败 {cfg_dir}: {_e}")

        logger.warning("未找到或创建 NapCat webui.json，将回退使用占位 token 'napcat'")
        return 'napcat'

    webui_token = _load_napcat_token()

    if headed_mode:
        napcat_dir = get_absolute_path('modules/napcatframework')
        napcat_exe_path = os.path.join(napcat_dir, 'NapCatWinBootMain.exe')
        if not os.path.exists(napcat_exe_path):
            logger.error(f"错误：找不到有头模式 NapCat 可执行文件 {napcat_exe_path}")
            return False
        cwd = napcat_dir
        command = f'CHCP 65001 & start http://127.0.0.1:6099/webui/web_login?token={webui_token} & NapCatWinBootMain.exe {qq_number}'
        logger.info(f"尝试以有头模式启动 NapCat (QQ: {qq_number}, token:{webui_token})")
    else:
        if not check_napcat():
            return False
        cwd = get_absolute_path('modules/napcat')
        command = f'CHCP 65001 & start http://127.0.0.1:6099/webui/web_login?token={webui_token} & NapCatWinBootMain.exe {qq_number}'
        logger.info(f"尝试以无头模式启动 NapCat (QQ: {qq_number}, token:{webui_token})")

    return create_cmd_window(cwd, command)

def launch_adapter():
    adapter_path = get_absolute_path('modules/MaiBot-Napcat-Adapter')
    return create_cmd_window(adapter_path, 'python main.py')

def launch_main_bot():
    main_path = get_absolute_path('modules/MaiBot')
    python_path = get_absolute_path('runtime/python31211/bin/python.exe')
    command = f'set MAIBOT_LEGACY_0X_UPGRADE_CONFIRMED=1 & start http://localhost:8001 & "{python_path}" bot.py'
    return create_cmd_window(main_path, command)

def update_qq_in_config(config_path: str, qq_number: str):
    try:
        with open(config_path, 'r', encoding='utf-8') as f:
            doc = tomlkit.parse(f.read())
        
        if 'bot' not in doc:
            doc['bot'] = tomlkit.table()  # 如果 bot 表不存在则创建
        
        doc['bot']['qq_account'] = qq_number  # 直接赋值，tomlkit 会处理类型
        
        with open(config_path, 'w', encoding='utf-8') as f:
            tomlkit.dump(doc, f)
            
    except Exception as e:
        logger.error(f"更新配置文件失败：{str(e)}")
        raise

def launch_config_manager():
    config_path = os.path.dirname(os.path.abspath(__file__))
    info_cmd = "CHCP 65001 & echo 配置管理已经迁移至WebUI，请启动主程序之后，通过浏览器访问 http://localhost:8001 进行管理。 & pause"
    return create_cmd_window(config_path, info_cmd)

def interactive_pip_install():
    """交互式安装pip模块"""
    print("\n=== 交互式安装pip模块 ===")
    print("1. 通过模块名称安装")
    print("2. 通过requirements.txt文件安装")
    print("0. 返回主菜单")
    
    while True:
        choice = input("请选择安装模式 (1/2/0): ").strip()
        
        if choice == '0':
            logger.info("已取消pip模块安装，返回主菜单")
            return True
            
        elif choice == '1':
            # 模块名称安装模式
            modules = input("请输入要安装的模块名称（多个模块用空格分隔）: ").strip()
            if not modules:
                logger.error("模块名称不能为空")
                continue
            
            # 使用内置的python路径和阿里云镜像源
            python_path = get_absolute_path('runtime/python31211/bin/python.exe')
            command = f'"{python_path}" -m pip install -i https://mirrors.aliyun.com/pypi/simple/ {modules}'
            
            logger.info(f"正在安装模块: {modules}")
            logger.info("使用阿里云镜像源加速下载...")
            
            script_dir = os.path.dirname(os.path.abspath(__file__))
            return create_cmd_window(script_dir, command)
            
        elif choice == '2':
            # requirements.txt安装模式
            requirements_path = input("请输入requirements.txt文件的完整路径: ").strip()
            
            # 处理Windows路径（去除引号，标准化路径分隔符）
            requirements_path = requirements_path.strip('"').strip("'")
            requirements_path = os.path.normpath(requirements_path)
            
            if not os.path.exists(requirements_path):
                logger.error(f"错误：找不到文件 {requirements_path}")
                continue
            
            if not requirements_path.lower().endswith('.txt'):
                logger.warning("警告：文件扩展名不是.txt，请确认这是requirements文件")
                confirm = input("是否继续？(y/N): ").strip().lower()
                if confirm != 'y':
                    continue
            
            # 使用内置的python路径和阿里云镜像源
            python_path = get_absolute_path('runtime/python31211/bin/python.exe')
            command = f'"{python_path}" -m pip install -i https://mirrors.aliyun.com/pypi/simple/ -r "{requirements_path}"'
            
            logger.info(f"正在从requirements文件安装: {requirements_path}")
            logger.info("使用阿里云镜像源加速下载...")
            
            script_dir = os.path.dirname(os.path.abspath(__file__))
            return create_cmd_window(script_dir, command)
            
        else:
            logger.error("无效选择，请输入 1、2 或 0")

def launch_python_cmd():
    """启动一个使用项目 Python 环境的CMD窗口"""
    script_dir = os.path.dirname(os.path.abspath(__file__))
    return create_cmd_window(script_dir, "echo Python environment ready. You can now run Python scripts. Type 'exit' to close.")

def launch_sqlite_studio():
    """启动数据库可视化管理工具"""
    # 首先检查是否存在 DB Browser for SQLite
    db_browser_dir = get_absolute_path('modules/DB.Browser.for.SQLite')
    db_browser_exe = os.path.join(db_browser_dir, 'DB Browser for SQLite.exe')
    maibot_db_path = get_absolute_path('modules/MaiBot/data/MaiBot.db')
    
    if os.path.exists(db_browser_dir) and os.path.exists(db_browser_exe):
        try:
            # 使用 DB Browser for SQLite 打开数据库文件
            if os.path.exists(maibot_db_path):
                subprocess.Popen([db_browser_exe, maibot_db_path], cwd=db_browser_dir)
                logger.info("DB Browser for SQLite 已启动并打开数据库")
            else:
                subprocess.Popen([db_browser_exe], cwd=db_browser_dir)
                logger.info("DB Browser for SQLite 已启动（数据库文件不存在）")
            return True
        except Exception as e:
            logger.error(f"错误：启动DB Browser for SQLite时出现异常：{str(e)}")
            # 如果启动失败，继续尝试启动 SQLiteStudio
    
    # 回退到启动 SQLiteStudio
    sqlite_studio_path = get_absolute_path('modules/SQLiteStudio/SQLiteStudio.exe')
    if not os.path.exists(sqlite_studio_path):
        logger.error(f"错误：找不到SQLiteStudio可执行文件 {sqlite_studio_path}")
        return False
    try:
        subprocess.Popen([sqlite_studio_path], cwd=get_absolute_path('modules/SQLiteStudio'))
        logger.info("SQLiteStudio 已启动")
        return True
    except Exception as e:
        logger.error(f"错误：启动SQLiteStudio时出现异常：{str(e)}")
        return False

def delete_maibot_memory():
    """删除MaiBot的所有记忆（删除数据库文件）"""
    db_path = get_absolute_path('modules/MaiBot/data/MaiBot.db')
    if not os.path.exists(db_path):
        logger.warning("数据库文件不存在，麦麦原本就没有记忆")
        return True
    
    try:
        # 确认删除
        confirm = input("⚠️  警告：此操作将删除麦麦的所有记忆，包括聊天记录、用户数据等，无法恢复！\n确定要继续吗？(输入 'YES' 确认): ").strip()
        if confirm.upper() != 'YES':
            logger.info("操作已取消")
            return False
        
        os.remove(db_path)
        logger.info("麦麦的所有记忆已删除成功！")
        return True
    except Exception as e:
        logger.error(f"错误：删除数据库文件时出现异常：{str(e)}")
        return False

def confirm_dangerous_operation(operation_name: str) -> bool:
    """确认危险操作
    
    Args:
        operation_name: 操作名称描述
        
    Returns:
        bool: 用户是否确认操作
    """
    confirm = input(f"⚠️  警告：此操作将{operation_name}，无法恢复！\n确定要继续吗？(输入 'YES' 确认): ").strip()
    if confirm.upper() != 'YES':
        logger.info("操作已取消")
        return False
    return True


def delete_knowledge_base() -> bool:
    rag_path = get_absolute_path('modules/MaiBot/data/rag')
    embedding_path = get_absolute_path('modules/MaiBot/data/embedding')
    
    # 检查是否存在知识库文件夹
    rag_exists = os.path.exists(rag_path)
    embedding_exists = os.path.exists(embedding_path)
    
    if not rag_exists and not embedding_exists:
        logger.warning("知识库原本就是空的，没有需要删除的内容")
        return True
    
    if not confirm_dangerous_operation("删除麦麦的所有知识库，包括RAG数据和向量数据"):
        return False
    
    try:
        deleted_items = []
        
        if rag_exists:
            shutil.rmtree(rag_path)
            deleted_items.append("RAG数据")
        
        if embedding_exists:
            shutil.rmtree(embedding_path)
            deleted_items.append("向量数据")
        
        if deleted_items:
            logger.info(f"知识库删除成功！已删除：{', '.join(deleted_items)}")
        
        return True
    except Exception as e:
        logger.error(f"错误：删除知识库时出现异常：{str(e)}")
        return False

def get_hitokoto() -> tuple[Optional[str], Optional[str]]:
    """获取一言内容和作者，失败返回None
    
    Returns:
        tuple: (一言内容, 作者信息)
    """
    with suppress(Exception):
        resp = requests.get('https://hitokoto.tianmoy.cn/?encode=json', timeout=3)
        if resp.status_code == 200:
            data = resp.json()
            text = data.get('hitokoto', '').strip()
            from_who = data.get('from_who') or data.get('from') or ''
            from_who = from_who.strip()
            return text, from_who
    return None, None


def get_napcat_launch_mode() -> bool:
    """获取NapCat启动模式选择
    
    Returns:
        bool: True表示有头模式，False表示无头模式
    """
    print("=== 选择 NapCat 启动模式 ===")
    print(" 1: 无头模式 (默认) : 只有命令行窗口，没有图形界面")
    print(" 2: 有头模式 : 带QQ电脑版图形界面（不推荐，新版本NapCatQQ不再支持有头版本，极易被腾讯风控）")
    napcat_launch_choice = input("选择 NapCat 启动模式: ").strip()
    
    if napcat_launch_choice == '2':
        logger.info("NapCat 将以有头模式启动。")
        return True
    else:
        if napcat_launch_choice not in ['1', '']:
            logger.warning("无效的 NapCat 启动模式选择，将使用默认无头模式。")
        logger.info("NapCat 将以无头模式启动。")
        return False


def log_operation_result(operation: str, success: bool) -> None:
    """记录操作结果的统一方法
    
    Args:
        operation: 操作名称
        success: 操作是否成功
    """
    status = "成功" if success else "失败"
    logger.info(f"正在{operation}...{status}")


def handle_launch_all_services() -> None:
    """处理启动所有服务的逻辑"""
    qq_number = read_qq_from_config()
    if not qq_number:
        logger.error("请先配置QQ号（选项5）")
        return

    headed_mode = get_napcat_launch_mode()
    
    services_success = all([
        launch_napcat(qq_number, headed_mode=headed_mode),
        launch_adapter(),
        launch_main_bot()
    ])
    
    if services_success:
        logger.info("所有组件启动成功！")
    else:
        logger.error("部分服务启动失败")


def handle_launch_napcat_only() -> None:
    """处理单独启动NapCat的逻辑"""
    qq_number = read_qq_from_config()
    if not qq_number:
        logger.error("请先配置QQ号（选项5）")
        return
    
    headed_mode = get_napcat_launch_mode()
    success = launch_napcat(qq_number, headed_mode=headed_mode)
    log_operation_result("启动 NapCat", success)


class MenuItem:
    """菜单项类"""
    def __init__(self, key: str, description: str, action: Callable[[], None] = None):
        self.key = key
        self.description = description
        self.action = action
    
    def execute(self):
        """执行菜单项对应的操作"""
        if self.action:
            self.action()


class MenuGroup:
    """菜单组类"""
    def __init__(self, title: str = "", items: List[MenuItem] = None):
        self.title = title
        self.items = items or []
    
    def add_item(self, item: MenuItem):
        """添加菜单项"""
        self.items.append(item)
    
    def insert_item(self, index: int, item: MenuItem):
        """在指定位置插入菜单项"""
        self.items.insert(index, item)
    
    def remove_item(self, key: str):
        """根据key移除菜单项"""
        self.items = [item for item in self.items if item.key != key]


class MenuManager:
    """菜单管理器"""
    def __init__(self):
        self.groups: List[MenuGroup] = []
        # 延迟初始化，在所有函数定义后再设置菜单
    
    def add_group(self, group: MenuGroup):
        """添加菜单组"""
        self.groups.append(group)
    
    def insert_group(self, index: int, group: MenuGroup):
        """在指定位置插入菜单组"""
        self.groups.insert(index, group)
    
    def find_item(self, key: str) -> Optional[MenuItem]:
        """根据key查找菜单项"""
        for group in self.groups:
            for item in group.items:
                if item.key == key:
                    return item
        return None
    
    def setup_default_menu(self):
        """设置默认菜单结构"""
        # 主要功能组
        main_group = MenuGroup("主功能：", [
            MenuItem("1", "启动所有服务", handle_launch_all_services),
            MenuItem("2", "单独启动 NapCat", handle_launch_napcat_only),
            MenuItem("3", "单独启动 Adapter", lambda: log_operation_result("启动 Adapter", launch_adapter())),
            MenuItem("4", "单独启动 麦麦主程序", lambda: log_operation_result("启动主程序", launch_main_bot())),
            MenuItem("6", "添加/修改QQ号", add_qq_number),
            MenuItem("7", "麦麦基础配置", lambda: log_operation_result("启动配置管理", launch_config_manager())),
            MenuItem("8", "修改可发消息群聊&私聊", lambda: log_operation_result("启动群聊私聊配置提示", modify_allowed_chats())),
            MenuItem("9", "安装VC运行库", install_vc_redist),
            MenuItem("10", "启动可视化数据库管理", lambda: log_operation_result("启动SQLiteStudio", launch_sqlite_studio())),
            MenuItem("11", "交互式安装pip模块", lambda: log_operation_result("启动交互式pip模块安装", interactive_pip_install())),
        ])
        
        # 数据管理功能组
        data_group = MenuGroup("数据管理功能：", [
            MenuItem("12", "麦麦删除所有记忆（删库）", lambda: log_operation_result("删除麦麦所有记忆", delete_maibot_memory())),
            MenuItem("14", "麦麦知识忘光光（删除知识库）", lambda: log_operation_result("删除麦麦知识库", delete_knowledge_base())),
        ])
        
        # 其他功能组
        other_group = MenuGroup("其他功能：", [
            MenuItem("17", "快捷打开配置文件", lambda: log_operation_result("打开配置文件", open_config_file())),
        ])
        
        # 退出组
        exit_group = MenuGroup("", [
            MenuItem("0", "退出程序"),
        ])
        
        self.groups = [main_group, data_group, other_group, exit_group]
    
    def display_menu(self) -> str:
        """显示菜单并返回用户选择"""
        self._display_header()
        self._display_menu_items()
        return input("请输入选项：").strip()
    
    def _display_header(self):
        """显示菜单头部"""
        print("\n=== MaiBot 控制台 ===")
        print("制作By MaiBot Team @MotricSeven")
        print(f"版本 {ONEKEY_VERSION}")
        print("一键包附加脚本仓库：https://github.com/DrSmoothl/MaiBotOneKey")
        print("麦麦MaiBot主仓库：https://github.com/MaiM-with-u/MaiBot")
        print("如果可以的话，希望您可以给这两个仓库点个Star！")
        print("======================")
        
        # 显示一言
        text, from_who = get_hitokoto()
        if text:
            print(text)
            if from_who:
                print(f"——{from_who}")
        print("======================")
    
    def _display_menu_items(self):
        """显示菜单项"""
        for group in self.groups:
            if group.title:
                print(group.title)
            
            for item in group.items:
                print(f"{item.key}. {item.description}")
            
            # 在组之间添加分隔线（除了最后一组）
            if group != self.groups[-1]:
                print("======================")
    
    def process_choice(self, choice: str) -> bool:
        """处理用户选择
        
        Args:
            choice: 用户选择的菜单项
            
        Returns:
            bool: True表示继续运行，False表示退出程序
        """
        if choice == '0':
            logger.info("程序已退出")
            return False
        
        item = self.find_item(choice)
        if item:
            if item.action:
                item.execute()
            return True
        else:
            logger.error("无效选项，请重新输入")
            return True


# 全局菜单管理器实例
menu_manager = MenuManager()


def add_custom_menu_item(key: str, description: str, action: Callable[[], None], group_index: int = 0):
    """添加自定义菜单项到指定组
    
    Args:
        key: 菜单项的键
        description: 菜单项描述
        action: 菜单项对应的操作函数
        group_index: 要添加到的组索引，默认为0（主要功能组）
    """
    if 0 <= group_index < len(menu_manager.groups):
        item = MenuItem(key, description, action)
        menu_manager.groups[group_index].add_item(item)


def insert_custom_menu_item(key: str, description: str, action: Callable[[], None], 
                          group_index: int = 0, item_index: int = 0):
    """在指定位置插入自定义菜单项
    
    Args:
        key: 菜单项的键
        description: 菜单项描述
        action: 菜单项对应的操作函数
        group_index: 要插入到的组索引
        item_index: 要插入到的项索引
    """
    if 0 <= group_index < len(menu_manager.groups):
        item = MenuItem(key, description, action)
        menu_manager.groups[group_index].insert_item(item_index, item)


def add_custom_menu_group(title: str, items: List[MenuItem] = None, index: int = -1):
    """添加自定义菜单组
    
    Args:
        title: 组标题
        items: 菜单项列表
        index: 插入位置，-1表示添加到末尾
    """
    group = MenuGroup(title, items or [])
    if index == -1:
        menu_manager.add_group(group)
    else:
        menu_manager.insert_group(index, group)


def remove_menu_item(key: str):
    """移除指定的菜单项
    
    Args:
        key: 要移除的菜单项键
    """
    for group in menu_manager.groups:
        group.remove_item(key)

def show_menu() -> str:
    """显示菜单（保持向后兼容）"""
    return menu_manager.display_menu()


def process_menu_choice(choice: str) -> bool:
    """处理菜单选择
    
    Args:
        choice: 用户选择的菜单项
        
    Returns:
        bool: True表示继续运行，False表示退出程序
    """
    return menu_manager.process_choice(choice)


def initialize_menu():
    """初始化菜单系统"""
    menu_manager.setup_default_menu()


def open_config_file() -> bool:
    """快捷打开配置文件"""
    config_files = [
        ("MaiBot主配置", get_absolute_path('modules/MaiBot/config/bot_config.toml')),
        ("MaiBot-模型配置", get_absolute_path('modules/MaiBot/config/model_config.toml')),
        ("NapCat适配器配置", get_absolute_path('modules/MaiBot-Napcat-Adapter/config.toml')),
        # 可以继续添加更多配置文件
    ]
    print("\n=== 快捷打开配置文件 ===")
    for idx, (name, _) in enumerate(config_files, 1):
        print(f"{idx}. {name}")
    print("0. 返回主菜单")
    choice = input("请选择要打开的配置文件: ").strip()
    if choice == '0':
        return True
    if not choice.isdigit() or not (1 <= int(choice) <= len(config_files)):
        logger.error("无效选择")
        return False
    name, path = config_files[int(choice) - 1]
    code_exe = get_absolute_path('modules/vscode/Code.exe')
    if not os.path.exists(code_exe):
        logger.error(f"找不到VSCode可执行文件 {code_exe}")
        return False
    if not os.path.exists(path):
        logger.error(f"找不到配置文件 {path}")
        return False
    try:
        subprocess.run([code_exe, path], check=True)
        logger.info(f"{name} 已使用 VSCode 打开")
        return True
    except Exception as e:
        logger.error(f"打开文件失败: {e}")
        return False


def check_and_create_config_files() -> bool:
    """检测并创建所有必要的配置文件
    
    Returns:
        bool: 所有配置文件检测和创建是否成功
    """
    config_checks = [
        {
            'name': 'MaiBot配置目录',
            'path': get_absolute_path('modules/MaiBot/config'),
            'is_directory': True
        },
        {
            'name': 'MaiBot主配置文件',
            'path': get_absolute_path('modules/MaiBot/config/bot_config.toml'),
            'template': get_absolute_path('modules/MaiBot/config/bot_config.toml.1.0default'),
            'is_directory': False
        },
        {
            'name': 'MaiBot-模型配置文件',
            'path': get_absolute_path('modules/MaiBot/config/model_config.toml'),
            'template': get_absolute_path('modules/MaiBot/config/model_config.toml.1.0default'),
            'is_directory': False
        },
        {
            'name': 'NapCat适配器配置文件',
            'path': get_absolute_path('modules/MaiBot-Napcat-Adapter/config.toml'),
            'template': get_absolute_path('modules/MaiBot-Napcat-Adapter/template.toml'),
            'is_directory': False
        }
    ]
    
    all_success = True
    
    for config in config_checks:
        try:
            if config['is_directory']:
                # 检测目录
                if not os.path.exists(config['path']):
                    os.makedirs(config['path'], exist_ok=True)
                    logger.info(f"已创建目录: {config['name']}")
                else:
                    logger.info(f"目录已存在: {config['name']}")
            else:
                # 检测配置文件
                if not os.path.exists(config['path']):
                    if 'template' in config and os.path.exists(config['template']):
                        # 确保目标目录存在
                        target_dir = os.path.dirname(config['path'])
                        if not os.path.exists(target_dir):
                            os.makedirs(target_dir, exist_ok=True)
                        
                        # 复制模板文件
                        shutil.copy2(config['template'], config['path'])
                        logger.info(f"已从模板创建配置文件: {config['name']}")
                    else:
                        logger.warning(f"模板文件不存在，无法创建: {config['name']}")
                        logger.warning(f"模板路径: {config.get('template', '未指定')}")
                        all_success = False
                else:
                    logger.info(f"配置文件已存在: {config['name']}")
                    
        except Exception as e:
            logger.error(f"处理配置文件时出错 {config['name']}: {str(e)}")
            all_success = False
    
    if all_success:
        logger.info("所有配置文件检测完成！")
    else:
        logger.warning("部分配置文件处理失败，请检查上述错误信息")
    
    return all_success


def main() -> None:
    """主程序入口"""
    # 初始化菜单系统
    initialize_menu()
    
    # 检测并创建配置文件
    check_and_create_config_files()
    
    try:
        while True:
            choice = show_menu()
            if not process_menu_choice(choice):
                break
    except KeyboardInterrupt:
        logger.info("\n程序已被用户中断")
        

if __name__ == "__main__":
    main()