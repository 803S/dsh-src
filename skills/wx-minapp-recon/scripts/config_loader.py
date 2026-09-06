import os
import sys
import json
import subprocess

_CONFIG = None

IS_WINDOWS = sys.platform == "win32"


def _find_config_path():
    script_dir = os.path.dirname(os.path.abspath(__file__))
    return os.path.join(script_dir, "..", "config.json")


def load_config():
    global _CONFIG
    if _CONFIG is not None:
        return _CONFIG
    path = _find_config_path()
    try:
        with open(path, "r", encoding="utf-8") as f:
            _CONFIG = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        _CONFIG = {}
    return _CONFIG


def get_wechat_paths():
    """[local.61] 按平台返回微信小程序包候选根目录。
    Windows 沿用配置（%USERPROFILE%/%APPDATA% 展开）；macOS/Linux 用容器目录 +
    xwechat_files（微信 4.x），扫描器另有兜底递归发现，路径布局差异不影响。"""
    cfg = load_config().get("wechat", {})
    home = os.path.expanduser("~")
    if IS_WINDOWS:
        old = cfg.get("old_format_path", "")
        xw = cfg.get("xwechat_users_path", "")
        old_paths = [os.path.expandvars(old)] if old else [
            os.path.join(os.environ.get("USERPROFILE", ""), "Documents", "WeChat Files", "Applet"),
        ]
        xwechat_users = os.path.expandvars(xw) if xw else os.path.join(
            os.environ.get("APPDATA", ""), "Tencent", "xwechat", "radium", "users"
        )
        container_root = None
    else:
        # macOS 3.x: Applet 目录在 Application Support/<ver>/<hash>/Applet 或 Documents/AppBrand
        # macOS 4.x: Documents/xwechat_files/<wxid>/…（内部布局由兜底递归发现兜住）
        old_paths = [
            os.path.join(home, "Library", "Containers", "com.tencent.xinWeChat",
                         "Data", "Library", "Application Support", "com.tencent.xinWeChat"),
            os.path.join(home, "Library", "Containers", "com.tencent.xinWeChat",
                         "Data", "Documents", "AppBrand"),
        ]
        xwechat_users = os.path.join(home, "Library", "Containers", "com.tencent.xinWeChat",
                                     "Data", "Documents", "xwechat_files")
        container_root = os.path.join(home, "Library", "Containers", "com.tencent.xinWeChat")
    return {
        "old_format_paths": old_paths,
        "xwechat_users": xwechat_users,
        "platform": sys.platform,
        "container_root": container_root,
    }


def get_tool_cmds():
    cfg = load_config().get("tools", {})
    return {
        "wedecode": cfg.get("wedecode_cmd", "wedecode"),
        "node": cfg.get("node_cmd", "node"),
    }


def get_output_dirs():
    cfg = load_config().get("output", {})
    return {
        "decompile": cfg.get("decompile_dir", "decompile_output"),
        "report": cfg.get("report_dir", "js_wx_report_output"),
    }


def platform_run(cmd_args, timeout=15):
    """[local.61] 跨平台子进程执行。Windows 上 npm 全局包装的是 .ps1/.cmd（不能被
    subprocess 直接执行），沿用 powershell 包装 + CREATE_NO_WINDOW；POSIX 直接执行
    （npm bin 是带 shebang 的可执行文件），禁止传 creationflags（Windows 专属参数）。"""
    if IS_WINDOWS:
        return subprocess.run(
            ["powershell", "-NoProfile", "-Command"] + list(cmd_args),
            capture_output=True, text=True, timeout=timeout,
            encoding="utf-8", errors="replace",
            creationflags=subprocess.CREATE_NO_WINDOW,
        )
    return subprocess.run(
        list(cmd_args), capture_output=True, text=True, timeout=timeout,
        encoding="utf-8", errors="replace",
    )
