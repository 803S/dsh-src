"""
ParamX 参数提取器（小程序版 v1.1）
从反编译后的小程序源码中提取接口参数名，支持分类评分和噪音过滤。

v1.1 改进 (同步自 js-recon-security):
- 补全带引号的对象属性提取 ("key": val, 'key': val)
- 扩展 API 请求正则 (fetch独立调用, .then/.catch回调, .get/.post调用)
- 增加来源优先级加成 (route_param→4星, url/api/wx_request来源+1)
- _kw_match() 词段边界匹配, 避免 DOMTokenList→token 等假阳性
"""
import re
from collections import defaultdict


LARGE_FILE_LIMIT = 500 * 1024
LARGE_FILE_SKIP = {"object_property", "variable_assignment", "function_param", "destructuring", "nested_destructuring"}


JS_KEYWORDS = {
    "var", "let", "const", "function", "if", "else", "for", "while", "return",
    "class", "import", "export", "default", "extends", "super", "this", "new",
    "typeof", "instanceof", "void", "delete", "in", "of", "try", "catch",
    "finally", "throw", "debugger", "with", "yield", "await", "async", "static",
    "set", "get", "true", "false", "null", "undefined", "break", "continue",
    "do", "switch", "case", "enum", "implements", "interface", "package",
    "private", "protected", "public",
}


EXCLUDED_NAMES = {
    "headers", "header", "response", "request", "error", "success", "fail", "complete",
    "then", "catch", "finally", "resolve", "reject", "promise",
    "fn", "func", "obj", "arr", "str", "bool", "date", "reg", "regex",
    "props", "state", "ref", "children", "style", "className",
    "props", "attrs", "slots", "listeners", "scopedSlots",
    "render", "component", "components", "directives", "filters",
    "computed", "watch", "methods", "lifecycle", "mounted",
    "res", "req", "ctx", "app", "page", "pages", "options",
}


COMMON_VARS = {
    "e", "t", "a", "n", "l", "r", "i", "o", "c", "u", "s", "d", "m",
    "v", "p", "h", "f", "g", "b", "y", "N", "I", "w", "E", "k", "O",
    "x", "j", "S", "C", "A", "_",
}


def _is_valid_param(name):
    if not name or len(name) < 2 or len(name) > 50:
        return False
    if not re.match(r"^[a-zA-Z_$][a-zA-Z0-9_$]*$", name):
        return False
    # 编译器/框架生成名: $compid__242, __esModule, _123
    if name.startswith("$") or name.startswith("__"):
        return False
    if re.match(r'^_\d+$', name):
        return False
    if name in JS_KEYWORDS:
        return False
    if name in EXCLUDED_NAMES:
        return False
    if name in COMMON_VARS:
        return False
    if len(name) == 1:
        return False
    return True


def _kw_match(kw, lower):
    """关键词匹配: 要求命中词段边界, 避免 DOMTokenList 匹配 token, fontSize 匹配 size"""
    if kw == lower:
        return True
    if re.search(r'(?:^|(?<=[a-z]))' + re.escape(kw) + r'(?=[^a-z]|$)', lower):
        return True
    return False


def _classify(name):
    lower = name.lower()
    category, priority, tags = "general", 1, []

    if lower in ("id", "uid", "uuid", "openid", "unionid") or lower.endswith("id"):
        category = "identifier"
        priority = 4
        tags.append("id")

    auth_keys = {
        "token", "auth", "key", "secret", "password", "session",
        "apikey", "api_key", "accesstoken", "access_token",
        "refreshtoken", "refresh_token", "sign", "nonce", "ticket",
        "timestamp_sig", "js_code", "code",
    }
    for kw in auth_keys:
        if _kw_match(kw, lower):
            category = "authentication"
            priority = 5
            tags.append("auth")
            break

    page_keys = {
        "page", "size", "limit", "offset", "pagesize", "page_size",
        "pagenum", "page_num", "pageno", "page_no", "per_page",
        "pageindex", "page_index", "currentpage", "current_page",
    }
    if lower in page_keys or (any(_kw_match(k, lower) for k in ("page", "size", "limit", "offset")) and priority < 3):
        category = "pagination"
        priority = max(priority, 2)
        tags.append("pagination")

    time_keys = {
        "time", "date", "timestamp", "datetime", "createtime",
        "updatetime", "starttime", "endtime", "expiretime",
        "created_at", "updated_at", "start_at", "end_at",
    }
    if lower in time_keys or (any(_kw_match(k, lower) for k in ("time", "date", "timestamp")) and priority < 4):
        category = "timestamp"
        priority = max(priority, 3)
        tags.append("time")

    status_keys = {"status", "state", "isactive", "isenabled", "isdeleted", "disabled", "enabled", "active", "visible", "show"}
    if lower in status_keys or any(k == lower for k in status_keys):
        category = "status"
        priority = max(priority, 3)
        tags.append("status")

    type_keys = {"type", "category", "kind", "classify", "sort"}
    if lower in type_keys:
        category = "type"
        priority = 2
        tags.append("type")

    if re.match(r"^[a-z]+_[a-z]+$", lower):
        tags.append("snake_case")

    return category, priority, list(set(tags))


def _add_param(params, value, source, filename, lineno=None):
    if not _is_valid_param(value):
        return
    category, priority, tags = _classify(value)

    # 来源优先级加成 (与原版 ParamX 一致)
    if source == "route_param":
        priority = max(priority, 4)
        if "route" not in tags:
            tags.append("route")
    # wx_request 系列和 api_request 同等对待
    _API_SOURCES = {
        "api_request", "wx_request", "wx_request_data", "wx_request_header",
        "wx_request_formData", "url_param", "urlsearchparams", "url_template",
        "config_object",
    }
    if source in _API_SOURCES:
        priority = min(priority + 1, 5)
        if "api" not in tags:
            tags.append("api")

    params.append({
        "value": value,
        "source": source,
        "file": filename,
        "line": lineno,
        "category": category,
        "priority": priority,
        "tags": tags,
    })


def extract_object_properties(content, filename, params, file_size=0):
    if file_size > LARGE_FILE_LIMIT:
        return
    # Pattern 1: unquoted keys — key: value
    for m in re.finditer(r"(?:^|,|\n|\r\n)\s*([a-zA-Z_$][a-zA-Z0-9_$]*)\s*:", content):
        _add_param(params, m.group(1), "object_property", filename, content[:m.start()].count("\n") + 1)
    # Pattern 2: double-quoted keys — { "key": value }
    for m in re.finditer(r'\{\s*"([a-zA-Z_$][a-zA-Z0-9_$]*)"\s*:', content):
        _add_param(params, m.group(1), "object_property", filename, content[:m.start()].count("\n") + 1)
    # Pattern 3: single-quoted keys — { 'key': value }
    for m in re.finditer(r"\{\s*'([a-zA-Z_$][a-zA-Z0-9_$]*)'\s*:", content):
        _add_param(params, m.group(1), "object_property", filename, content[:m.start()].count("\n") + 1)


def extract_destructuring(content, filename, params):
    for m in re.finditer(r"(?:const|let|var)\s*\{([^}]+)\}\s*=", content):
        inner = m.group(1)
        lineno = content[:m.start()].count("\n") + 1
        for vm in re.finditer(r"([a-zA-Z_$][a-zA-Z0-9_$]*)(?:\s*:\s*([a-zA-Z_$][a-zA-Z0-9_$]*))?", inner):
            alias = vm.group(2)
            prop = vm.group(1)
            name = alias if alias else prop
            _add_param(params, name, "destructuring", filename, lineno + inner[:vm.start()].count("\n"))


def extract_nested_destructuring(content, filename, params):
    pattern = (
        r"(?:const|let|var)\s*\{\s*([a-zA-Z_$][a-zA-Z0-9_$]*)\s*:\s*\{([^}]+)\}\s*"
        r"(?:,\s*([a-zA-Z_$][a-zA-Z0-9_$]*)\s*:\s*\{([^}]+)\})?\s*\}\s*="
    )
    for m in re.finditer(pattern, content):
        lineno = content[:m.start()].count("\n") + 1
        for g_idx in [2, 4]:
            group = m.group(g_idx)
            if not group:
                continue
            for part in group.split(","):
                part = part.strip()
                if part and _is_valid_param(part):
                    _add_param(params, part, "nested_destructuring", filename, lineno)


def extract_function_params(content, filename, params):
    patterns = [
        (r"function\s+\w*\s*\(\s*([^)]+)\s*\)", "function_param"),
        (r"\(\s*([^)]+)\s*\)\s*=>", "arrow_param"),
        (r"function\s+\w*\s*\(\s*\{([^}]+)\}\s*\)", "function_param_destructure"),
        (r"\(\s*\{([^}]+)\}\s*\)\s*=>", "arrow_destructure"),
    ]
    for pattern, source in patterns:
        for m in re.finditer(pattern, content):
            lineno = content[:m.start()].count("\n") + 1
            raw = m.group(1)
            for part in raw.split(","):
                part = part.strip()
                if not part or part in ("{", "}"):
                    continue
                if "=" in part:
                    part = part.split("=")[0].strip()
                if part.startswith("{"):
                    part = part.strip("{} ").strip()
                if _is_valid_param(part):
                    _add_param(params, part, source, filename, lineno)


def extract_variable_assignments(content, filename, params, file_size=0):
    if file_size > LARGE_FILE_LIMIT:
        return
    for m in re.finditer(r"(?:const|let|var)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=", content):
        _add_param(params, m.group(1), "variable_assignment", filename, content[:m.start()].count("\n") + 1)


def extract_api_request_params(content, filename, params):
    # Pattern 1: HTTP 客户端调用 — fetch/axios/ajax (含可选 .get/.post 等)
    for m in re.finditer(
        r"(?:fetch|axios|ajax|resource)(?:\.(?:get|post|put|delete|patch|head|options))?\s*\([^)]*,\s*\{([^}]*)\}",
        content,
    ):
        lineno = content[:m.start()].count("\n") + 1
        obj = m.group(1)
        for pm in re.finditer(r"""['"]?([a-zA-Z_$][a-zA-Z0-9_$]*)['"]?\s*:""", obj):
            _add_param(params, pm.group(1), "api_request", filename, lineno)

    # Pattern 2: .then()/.catch() 回调中的对象字面量
    for m in re.finditer(r"\.(?:then|catch)\s*\([^)]*\{([^}]*)\}", content):
        lineno = content[:m.start()].count("\n") + 1
        obj = m.group(1)
        for pm in re.finditer(r"""['"]?([a-zA-Z_$][a-zA-Z0-9_$]*)['"]?\s*:""", obj):
            _add_param(params, pm.group(1), "api_request", filename, lineno)

    # Pattern 3: .get()/.post() 独立调用 (如 request.get(url, {params}))
    for m in re.finditer(r"\.(?:get|post|put|delete|patch)\s*\([^)]*,\s*\{([^}]*)\}", content):
        lineno = content[:m.start()].count("\n") + 1
        obj = m.group(1)
        for pm in re.finditer(r"""['"]?([a-zA-Z_$][a-zA-Z0-9_$]*)['"]?\s*:""", obj):
            _add_param(params, pm.group(1), "api_request", filename, lineno)

    # Pattern 4: wx.request / wx.uploadFile / wx.downloadFile (小程序特有)
    for m in re.finditer(
        r"wx\.(?:request|uploadFile|downloadFile)\s*\(\s*\{([\s\S]{0,600}?)\}\s*\)",
        content,
    ):
        lineno = content[:m.start()].count("\n") + 1
        obj = m.group(1)
        for key in ("data", "header", "headers", "formData"):
            inner_pattern = rf"{key}\s*:\s*\{{([^{{}}]{{0,1200}})\}}"
            for block in re.finditer(inner_pattern, obj, re.DOTALL):
                for pm in re.finditer(r"""['"]?([a-zA-Z_$][a-zA-Z0-9_$]*)['"]?\s*:""", block.group(1)):
                    _add_param(params, pm.group(1), f"wx_request_{key}", filename, lineno)
        for pm in re.finditer(r"""['"]?([a-zA-Z_$][a-zA-Z0-9_$]*)['"]?\s*:""", obj):
            _add_param(params, pm.group(1), "wx_request", filename, lineno)


def extract_url_params(content, filename, params):
    for m in re.finditer(r"[?&]([a-zA-Z_$][a-zA-Z0-9_$]*)=", content):
        _add_param(params, m.group(1), "url_param", filename, content[:m.start()].count("\n") + 1)
    for m in re.finditer(r"""\.(?:set|append|get)\(["']([^"']+)["']""", content):
        _add_param(params, m.group(1), "urlsearchparams", filename, content[:m.start()].count("\n") + 1)
    for m in re.finditer(r"[?&]\$\{([^}]+)\}", content):
        _add_param(params, m.group(1), "url_template", filename, content[:m.start()].count("\n") + 1)


def extract_config_objects(content, filename, params):
    for m in re.finditer(r"(?:config|options|params|settings|query|body|data|headers|header|formData)\s*[:=]\s*\{([^}]*)\}", content):
        lineno = content[:m.start()].count("\n") + 1
        obj = m.group(1)
        for pm in re.finditer(r"""['"]?([a-zA-Z_$][a-zA-Z0-9_$]*)['"]?\s*:""", obj):
            _add_param(params, pm.group(1), "config_object", filename, lineno)


def extract_route_params(content, filename, params):
    for m in re.finditer(r"/\s*:([a-zA-Z_$][a-zA-Z0-9_$]*)", content):
        _add_param(params, m.group(1), "route_param", filename, content[:m.start()].count("\n") + 1)
    for m in re.finditer(r"/\{([a-zA-Z_$][a-zA-Z0-9_$]*)\}", content):
        _add_param(params, m.group(1), "route_param", filename, content[:m.start()].count("\n") + 1)
    for m in re.finditer(r"/\[([a-zA-Z_$][a-zA-Z0-9_$]*)\]", content):
        _add_param(params, m.group(1), "route_param", filename, content[:m.start()].count("\n") + 1)


EXTRACTORS = [
    ("object_property", lambda c, fn, p, sz: extract_object_properties(c, fn, p, sz)),
    ("destructuring", lambda c, fn, p, sz: extract_destructuring(c, fn, p)),
    ("nested_destructuring", lambda c, fn, p, sz: extract_nested_destructuring(c, fn, p)),
    ("function_param", lambda c, fn, p, sz: extract_function_params(c, fn, p)),
    ("variable_assignment", lambda c, fn, p, sz: extract_variable_assignments(c, fn, p, sz)),
    ("api_request", lambda c, fn, p, sz: extract_api_request_params(c, fn, p)),
    ("url_param", lambda c, fn, p, sz: extract_url_params(c, fn, p)),
    ("config_object", lambda c, fn, p, sz: extract_config_objects(c, fn, p)),
    ("route_param", lambda c, fn, p, sz: extract_route_params(c, fn, p)),
]


def deduplicate(params):
    seen = set()
    result = []
    for p in params:
        key = (p["value"], p["file"])
        if key not in seen:
            seen.add(key)
            result.append(p)
    return result


def extract_from_file(content, filename):
    params = []
    file_size = len(content)
    is_large = file_size > LARGE_FILE_LIMIT
    for name, extractor in EXTRACTORS:
        if is_large and name in LARGE_FILE_SKIP:
            continue
        extractor(content, filename, params, file_size)
    return params


def extract_parameters(all_files):
    all_params = []
    stats = defaultdict(int)

    for fpath, content in all_files.items():
        display_name = fpath.split("\\")[-1].split("/")[-1]
        params = extract_from_file(content, fpath)
        for p in params:
            p["file"] = display_name
        all_params.extend(params)
        if params:
            stats[display_name] = len(params)

    all_params = deduplicate(all_params)
    all_params.sort(key=lambda p: (-p["priority"], p["value"]))

    by_source = defaultdict(int)
    for p in all_params:
        by_source[p["source"]] += 1

    return {
        "total": len(all_params),
        "params": all_params,
        "by_source": dict(by_source),
        "by_file": dict(stats),
    }


def generate_param_report(result):
    lines = []
    lines.append("=" * 60)
    lines.append("  参数提取报告 (ParamX 引擎 - 小程序版)")
    lines.append("=" * 60)
    lines.append(f"  共提取 {result['total']} 个唯一参数")
    lines.append("")

    if result["by_source"]:
        lines.append("  [提取策略统计]")
        for src, cnt in sorted(result["by_source"].items(), key=lambda x: -x[1]):
            lines.append(f"    {src}: {cnt} 个")
        lines.append("")

    if result["by_file"]:
        lines.append("  [来源文件统计]")
        for f, cnt in sorted(result["by_file"].items(), key=lambda x: -x[1]):
            lines.append(f"    {f}: {cnt} 个")
        lines.append("")

    if not result["params"]:
        lines.append("  (没有提取到参数)")
        return "\n".join(lines)

    labels = {
        "authentication": "认证",
        "identifier": "ID",
        "timestamp": "时间",
        "status": "状态",
        "pagination": "分页",
        "type": "类型",
        "general": "普通",
    }

    lines.append("  [参数列表 (按优先级降序)]")
    lines.append("")
    for p in result["params"]:
        cat_label = labels.get(p["category"], p["category"])
        priority_stars = "⭐" * p["priority"]
        line_no = f":{p['line']}" if p.get("line") else ""
        lines.append(f"  {priority_stars} [{cat_label}] {p['value']}")
        lines.append(f"     ← {p['file']}{line_no} ({p['source']})")
        if p["tags"]:
            lines.append(f"     tags: {', '.join(p['tags'])}")
        lines.append("")

    lines.append("=" * 60)
    lines.append("  参数列表 (纯文本, 每行一个, 方便复制)")
    lines.append("=" * 60)
    for p in result["params"]:
        lines.append(p["value"])

    return "\n".join(lines)
