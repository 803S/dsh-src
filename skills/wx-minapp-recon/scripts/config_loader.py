import os
import json

_CONFIG = None


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
    cfg = load_config().get("wechat", {})
    old = cfg.get("old_format_path", "")
    xw = cfg.get("xwechat_users_path", "")
    return {
        "old_format_paths": [os.path.expandvars(old)] if old else [],
        "xwechat_users": os.path.expandvars(xw) if xw else "",
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
