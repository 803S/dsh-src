import re
import sys
import os
import json
import io
from datetime import datetime
from collections import defaultdict
import paramx_extract

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')


# ============================================================
# 通用提取（复用 js-recon-security 逻辑）
# ============================================================

ASSET_EXTENSIONS = (
    ".gif", ".png", ".jpg", ".jpeg", ".webp", ".svg", ".ico", ".bmp",
    ".woff", ".woff2", ".eot", ".ttf", ".otf", ".pdf", ".zip", ".rar",
    ".7z", ".map", ".d.ts", ".min.js", ".css", ".scss", ".less",
)

ASSET_LIKE_EMAIL_TLDS = {
    "png", "jpg", "jpeg", "webp", "gif", "svg", "ico", "bmp",
    "ttf", "otf", "woff", "woff2", "eot", "map", "js", "css",
    "json", "wxml", "wxss",
}


def _has_word_char(text):
    return bool(re.search(r"[A-Za-z0-9\u4e00-\u9fff]", text))


def _is_invalid_route_param(segment):
    if not segment.startswith(":"):
        return False
    return not bool(re.fullmatch(r":[A-Za-z_][A-Za-z0-9_-]*", segment))


def normalize_path_candidate(path):
    if "?" not in path:
        return path, None
    base = path.split("?", 1)[0]
    if not base:
        return path, None
    return base, "query_string_normalized"


def classify_path_noise(path):
    """Classify extracted paths so removed items stay reviewable."""
    lower = path.lower()
    if not path or len(path) > 240:
        return "soft", "path_empty_or_too_long"
    if path in ("//", "/#", "/#?", "/.", "/./", "/", "/null", "/undefined"):
        return "hard", "empty_or_placeholder_path"
    if path.startswith("/#") or path == "#":
        return "hard", "hash_fragment"
    if "%3c" in lower or "%3e" in lower or "&lt;" in lower or "&gt;" in lower:
        return "hard", "encoded_html_or_svg_fragment"
    if "," in path or "$" in path or "=" in path or "?" in path:
        return "soft", "punctuation_heavy_path"
    if "\\" in path:
        return "soft", "backslash_path"
    if lower.startswith(("/tmp/", "/var/", "/proc/", "/dev/", "/sys/", "/etc/", "/node_modules/")):
        return "soft", "filesystem_or_dependency_path"
    if lower.startswith(("//", "__")) or ".." in path:
        return "soft", "scheme_relative_or_parent_path"
    if lower.endswith(ASSET_EXTENSIONS):
        return "soft", "static_asset_extension"
    if "node_modules/" in lower or ".git/" in lower:
        return "soft", "dependency_or_git_path"
    if re.search(r'/v?\d+\.\d+\.\d+/', lower):
        return "soft", "versioned_static_path"
    parts = [p for p in path.split("/") if p]
    if parts and _is_invalid_route_param(parts[0]):
        return "hard", "invalid_route_param_fragment"
    if not _has_word_char(path):
        return "hard", "no_word_characters"
    if len(parts) == 1 and len(parts[0]) <= 1:
        return "soft", "single_character_path"
    if len(parts) >= 2 and all(len(p) <= 2 for p in parts):
        return "soft", "short_segments_only"
    if all(ord(c) > 127 for c in path.replace("/", "")):
        return "soft", "non_ascii_only_path"
    return None, ""


def is_noise_path(path):
    level, _ = classify_path_noise(path)
    return level is not None


def read_js_files(root_dir):
    files = {}
    for r, dirs, fnames in os.walk(root_dir):
        for fname in fnames:
            if not fname.endswith('.js'):
                continue
            fpath = os.path.join(r, fname)
            try:
                with open(fpath, "r", encoding='utf-8', errors='ignore') as f:
                    files[fpath] = f.read()
            except Exception as e:
                print(f"[-] Error reading {fname}: {e}", file=sys.stderr)
    return files


def read_wxml_files(root_dir):
    files = {}
    for r, dirs, fnames in os.walk(root_dir):
        for fname in fnames:
            if not fname.endswith('.wxml') and not fname.endswith('.wxss') and not fname.endswith('.json'):
                continue
            fpath = os.path.join(r, fname)
            try:
                with open(fpath, "r", encoding='utf-8', errors='ignore') as f:
                    files[fpath] = f.read()
            except Exception as e:
                pass
    return files


def extract_js_urls(files, noise=None):
    paths = []
    noise = noise if noise is not None else []
    for fpath, content in files.items():
        fname = os.path.basename(fpath)
        if fname.endswith(".wxss"):
            for line in content.splitlines():
                for m in re.findall(r"""['"](/[^'"\s><(){}]+)['"]""", line.strip()):
                    noise.append({
                        "category": "api_path",
                        "level": "soft",
                        "reason": "wxss_path_candidate",
                        "file": fname,
                        "value": m.replace(':"', "").replace('"', ""),
                    })
            continue
        for line in content.splitlines():
            line = line.strip()
            matches = re.findall(r"""['"](/[^'"\s><(){}]+)['"]""", line)
            for m in matches:
                cleaned = m.replace(':"', "").replace('"', "")
                normalized, normalize_reason = normalize_path_candidate(cleaned)
                if normalize_reason:
                    noise.append({
                        "category": "api_path",
                        "level": "soft",
                        "reason": normalize_reason,
                        "file": fname,
                        "value": cleaned,
                        "normalized_value": normalized,
                    })
                noise_level, noise_reason = classify_path_noise(normalized)
                if noise_level:
                    noise.append({
                        "category": "api_path",
                        "level": noise_level,
                        "reason": noise_reason,
                        "file": fname,
                        "value": cleaned,
                        "normalized_value": normalized,
                    })
                    continue
                paths.append({"file": fname, "path": normalized})
    return paths


def extract_backend_urls(files):
    urls = []
    for fpath, content in files.items():
        fname = os.path.basename(fpath)
        for line in content.splitlines():
            line = line.strip()
            matches = re.findall(r'https?://[^\s\'"<>()]+', line)
            for m in matches:
                cleaned = m.replace(':"', "").replace('"', "")
                urls.append({"file": fname, "url": cleaned})
    return urls


def extract_comments(files):
    result = {"single_line": [], "multi_line": [], "html_comments": []}
    for fpath, content in files.items():
        fname = os.path.basename(fpath)
        for m in re.findall(r'(?<!https:)(?<!http:)//[^\n]*', content):
            result["single_line"].append({"file": fname, "comment": m.strip()})
        for m in re.findall(r'/\*[\s\S]*?\*/', content):
            result["multi_line"].append({"file": fname, "comment": m.strip()})
        for m in re.findall(r'<!--[\s\S]*?-->', content):
            result["html_comments"].append({"file": fname, "comment": m.strip()})
    return result


def extract_sensitive(files, noise=None):
    noise = noise if noise is not None else []
    mail_pattern = r'[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}'
    phone_pattern = r'(?<!\d)(13\d{9}|14[579]\d{8}|15[^4\D]\d{8}|166\d{8}|17[^49\D]\d{8}|18\d{9}|19[189]\d{8})(?!\d)'
    ip_pattern = r'\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b'
    id_pattern = r'\b\d{17}[\dXx]\b'
    jwt_pattern = r'eyJ[A-Za-z0-9_/+\-]{10,}={0,2}\.[A-Za-z0-9_/+\-\\]{15,}={0,2}\.[A-Za-z0-9_/+\-\\]{10,}={0,2}'
    private_key_pattern = r'-----\s*?BEGIN[ A-Z0-9_-]*?PRIVATE KEY\s*?-----[a-zA-Z0-9\/\n\r=+]*-----\s*?END[ A-Z0-9_-]*? PRIVATE KEY\s*?-----'
    bearer_pattern = r'\b[Bb]earer\s+[a-zA-Z0-9\-=._+/\\]{20,500}\b'
    github_token_pattern = r'\b((?:ghp|gho|ghu|ghs|ghr|github_pat)_[a-zA-Z0-9_]{36,255})\b'
    gitlab_token_pattern = r'\b(glpat-[a-zA-Z0-9\-=_]{20,22})\b'

    ak_patterns = {
        "aliyun_ak": r"LTAI[a-zA-Z0-9]{12,20}",
        "aws_ak": r"(?:A3T[A-Z0-9]|AKIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ASIA)[A-Z0-9]{16}",
        "google_ak": r"AIza[0-9A-Za-z_\-]{35}",
        "tencent_ak": r"AKID[a-zA-Z0-9]{13,20}",
        "jinshan_ak": r"AKLT[a-zA-Z0-9-_]{16,28}",
        "huoshan_ak": r"(?:AKLT|AKTP)[a-zA-Z0-9]{35,50}",
        "jingdong_ak": r"JDC_[0-9A-Z]{25,40}",
        "qywx_corpid": r"ww[a-z0-9]{15,18}",
        "wx_appid": r"wx[a-z0-9]{15,18}",
        "wx_gzh": r"gh_[a-z0-9]{11,13}",
    }

    findings = {
        "emails": [], "phones": [], "ips": [], "id_cards": [],
        "jwt_tokens": [], "private_keys": [], "bearer_tokens": [],
        "github_tokens": [], "gitlab_tokens": [], "cloud_aks": {}
    }
    for key in ak_patterns:
        findings["cloud_aks"][key] = []

    webhook_patterns = {
        "slack_webhook": r"https://hooks.slack.com/services/[a-zA-Z0-9\-_]{6,12}/[a-zA-Z0-9\-_]{6,12}/[a-zA-Z0-9\-_]{15,24}",
        "feishu_webhook": r"https://open.feishu.cn/open-apis/bot/v2/hook/[a-z0-9\-]{25,50}",
        "dingtalk_webhook": r"https://oapi.dingtalk.com/robot/send\?access_token=[a-z0-9]{50,80}",
        "wechat_webhook": r"https://qyapi.weixin.qq.com/cgi-bin/webhook/send\?key=[a-zA-Z0-9\-]{25,50}",
    }
    findings["webhooks"] = {k: [] for k in webhook_patterns}

    grafana_patterns = {
        "grafana_sa_token": r"glsa_[A-Za-z0-9]{32}_[A-Fa-f0-9]{8}",
        "grafana_cloud_token": r"glc_[A-Za-z0-9\-_+/]{32,200}={0,2}",
        "grafana_api_key": r"eyJrIjoi[a-zA-Z0-9\-_+/]{50,100}={0,2}",
    }
    findings["grafana"] = {k: [] for k in grafana_patterns}

    def _is_false_positive_email(value, line):
        lower = value.lower().strip(".,;:'\")]} ")
        if re.search(r"@\d+x\.(?:png|jpg|jpeg|webp|gif|svg|ico|bmp)$", lower):
            return True
        if lower.rsplit(".", 1)[-1] in ASSET_LIKE_EMAIL_TLDS:
            return True
        if re.search(r"(?:@2x|@3x|@4x)\.(?:png|jpg|jpeg|webp|gif|svg)", line.lower()):
            return True
        return False

    def _is_style_or_svg_ip_false_positive(fname, line):
        lower_line = line.lower()
        return (
            fname.lower().endswith((".css", ".scss", ".less", ".wxss"))
            or "data:image/svg+xml" in lower_line
            or "<svg" in lower_line
        )

    def _is_valid_china_id(value):
        if not re.fullmatch(r"\d{17}[\dXx]", value):
            return False
        try:
            birth = value[6:14]
            datetime.strptime(birth, "%Y%m%d")
        except ValueError:
            return False
        weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2]
        checks = "10X98765432"
        total = sum(int(value[i]) * weights[i] for i in range(17))
        return checks[total % 11] == value[-1].upper()

    for fpath, content in files.items():
        fname = os.path.basename(fpath)
        for line in content.splitlines():
            line = line.strip()
            for item in re.findall(mail_pattern, line, re.IGNORECASE):
                if _is_false_positive_email(item, line):
                    noise.append({
                        "category": "sensitive",
                        "type": "email",
                        "level": "hard",
                        "reason": "asset_filename_email_false_positive",
                        "file": fname,
                        "value": item,
                    })
                    continue
                findings["emails"].append({"file": fname, "value": item})
            for item in re.findall(phone_pattern, line):
                findings["phones"].append({"file": fname, "value": item})
            for item in re.findall(ip_pattern, line):
                if _is_style_or_svg_ip_false_positive(fname, line):
                    noise.append({
                        "category": "sensitive",
                        "type": "ip",
                        "level": "soft",
                        "reason": "style_or_svg_numeric_ip_false_positive",
                        "file": fname,
                        "value": item,
                    })
                    continue
                findings["ips"].append({"file": fname, "value": item})
            for item in re.findall(id_pattern, line):
                if not _is_valid_china_id(item):
                    noise.append({
                        "category": "sensitive",
                        "type": "id_card",
                        "level": "hard",
                        "reason": "invalid_china_id_checksum_or_birthdate",
                        "file": fname,
                        "value": item,
                    })
                    continue
                findings["id_cards"].append({"file": fname, "value": item})
            for item in re.findall(jwt_pattern, line):
                findings["jwt_tokens"].append({"file": fname, "value": item[:80]})
            for item in re.findall(private_key_pattern, line, re.IGNORECASE):
                findings["private_keys"].append({"file": fname, "value": item[:80]})
            for item in re.findall(bearer_pattern, line, re.IGNORECASE):
                findings["bearer_tokens"].append({"file": fname, "value": item[:80]})
            for item in re.findall(github_token_pattern, line):
                findings["github_tokens"].append({"file": fname, "value": item[:80]})
            for item in re.findall(gitlab_token_pattern, line):
                findings["gitlab_tokens"].append({"file": fname, "value": item[:80]})
            for key, pattern in ak_patterns.items():
                for item in re.findall(pattern, line):
                    findings["cloud_aks"][key].append({"file": fname, "value": item})
            for key, pattern in webhook_patterns.items():
                for item in re.findall(pattern, line):
                    findings["webhooks"][key].append({"file": fname, "value": item})
            for key, pattern in grafana_patterns.items():
                for item in re.findall(pattern, line):
                    findings["grafana"][key].append({"file": fname, "value": item})

    return deduplicate_sensitive(findings)


def deduplicate_sensitive(findings):
    """Deduplicate sensitive findings by value and file while preserving categories."""
    result = {}
    for key, value in findings.items():
        if isinstance(value, list):
            seen = set()
            rows = []
            for item in value:
                dedupe_key = (item.get("value", ""), item.get("file", ""))
                if dedupe_key in seen:
                    continue
                seen.add(dedupe_key)
                rows.append(item)
            result[key] = rows
        elif isinstance(value, dict):
            result[key] = {}
            for subkey, rows_in in value.items():
                seen = set()
                rows = []
                for item in rows_in:
                    dedupe_key = (item.get("value", ""), item.get("file", ""))
                    if dedupe_key in seen:
                        continue
                    seen.add(dedupe_key)
                    rows.append(item)
                result[key][subkey] = rows
        else:
            result[key] = value
    return result


# ============================================================
# 小程序专项提取
# ============================================================

def extract_app_config(decompiled_dir):
    result = {
        "pages": [],
        "tabbar": None,
        "plugins": [],
        "permissions": [],
        "network_timeout": None,
        "cloud_envs": [],
        "subpackages": [],
        "all_page_routes": [],
    }
    app_json_path = os.path.join(decompiled_dir, "app.json")
    if not os.path.isfile(app_json_path):
        return result

    try:
        with open(app_json_path, "r", encoding="utf-8", errors="ignore") as f:
            cfg = json.load(f)
        result["pages"] = cfg.get("pages", [])
        if "tabBar" in cfg:
            tb = cfg["tabBar"]
            result["tabbar"] = {
                "list": [{"pagePath": t.get("pagePath"), "text": t.get("text")} for t in tb.get("list", [])],
                "color": tb.get("color"),
                "selectedColor": tb.get("selectedColor"),
            }
        if "plugins" in cfg:
            result["plugins"] = list(cfg["plugins"].keys()) if isinstance(cfg["plugins"], dict) else cfg["plugins"]
        if "permission" in cfg:
            result["permissions"] = [
                {"scope": k, "desc": v.get("desc", "")}
                for k, v in cfg["permission"].items()
            ] if isinstance(cfg["permission"], dict) else cfg["permission"]
        result["network_timeout"] = cfg.get("networkTimeout")

        # 提取分包定义
        subs = cfg.get("subpackages") or cfg.get("subPackages") or []
        result["subpackages"] = [
            {"root": s.get("root", ""), "pages": s.get("pages", [])}
            for s in subs if isinstance(s, dict)
        ]

        # 计算所有页面路由的完整路径（主包 + 分包）
        all_routes = set()
        for p in result["pages"]:
            all_routes.add(p.lstrip("/"))
        for sp in result["subpackages"]:
            root = sp["root"].rstrip("/")
            for sp_page in sp["pages"]:
                all_routes.add(root + "/" + sp_page.lstrip("/"))
        result["all_page_routes"] = sorted(all_routes)

    except Exception as e:
        print(f"  [-] 解析 app.json 失败: {e}", file=sys.stderr)

    return result


def extract_minapp_api_calls(files):
    calls = []
    for fpath, content in files.items():
        fname = os.path.basename(fpath)
        for m in re.finditer(r"""wx\.(?:request|uploadFile|downloadFile)\s*\(\s*{\s*url\s*:\s*['"]([^'"]+)['"]""", content):
            calls.append({"file": fname, "api": m.group(0)[:120], "url": m.group(1), "type": "wx_api"})
        for m in re.finditer(r"""wx\.(?:request|uploadFile|downloadFile)\s*\(\s*{\s*url\s*:\s*(\w+)""", content):
            calls.append({"file": fname, "api": m.group(0)[:120], "url_var": m.group(1), "type": "wx_api_var"})
    return calls


def extract_cloud_env(files):
    cloud_info = []
    for fpath, content in files.items():
        fname = os.path.basename(fpath)
        for m in re.finditer(r"""wx\.cloud\.init\s*\(\s*\{[^}]*?env\s*:\s*['"]([^'"]+)['"]""", content):
            cloud_info.append({"file": fname, "env": m.group(1), "type": "cloud_env"})
        for m in re.finditer(r"""cloud\.callFunction\s*\(\s*\{[^}]*?name\s*:\s*['"]([^'"]+)['"]""", content):
            cloud_info.append({"file": fname, "function": m.group(1), "type": "cloud_function"})
        for m in re.finditer(r"""wx\.cloud\.(?:database|callFunction)""", content):
            cloud_info.append({"file": fname, "match": m.group()[:60], "type": "cloud_api"})
    return cloud_info


def extract_app_secret(files):
    secrets = []
    for fpath, content in files.items():
        fname = os.path.basename(fpath)
        for m in re.finditer(r"""['"](?:secret|Secret|appsecret|AppSecret|app_secret)['"]\s*[:=]\s*['"]([a-zA-Z0-9_\-]{8,64})['"]""", content):
            secrets.append({"file": fname, "value": m.group(1)[:40], "type": "potential_secret"})
    return secrets


def extract_wx_router(app_config):
    routes = []
    for page in app_config.get("pages", []):
        routes.append({"page": page, "route_depth": len(page.split("/")) - 1})
    return {"total_pages": len(app_config["pages"]), "routes": routes}


# ============================================================
# 报告生成
# ============================================================

def deduplicate(items, key_field):
    seen = set()
    result = []
    for item in items:
        val = item.get(key_field, "")
        if val not in seen:
            seen.add(val)
            result.append(item)
    return result


def classify_path_type(path, all_page_routes, decompiled_dir=None, subpackage_roots=None):
    """
    页面路由 vs API 端点分类 (四层检测):
      1. app.json 路由表精确匹配
      2. 分包前缀模糊匹配: JS 代码路径可能省略 subpackage root
      3. 文件系统验证: 路径对应 decompiled_dir 下的 .js 文件
      4. 路径模式兜底: 末两段相同 (subpackage/page/page 模式)
    """
    clean = path.lstrip("/")
    # Layer 1: app.json 路由表精确匹配
    if clean in all_page_routes:
        return "页面路由"
    # Layer 2: 分包前缀模糊匹配
    if subpackage_roots:
        for root in subpackage_roots:
            if (root + "/" + clean) in all_page_routes:
                return "页面路由"
    # Layer 3: 文件系统验证
    if decompiled_dir:
        js_candidate = os.path.join(decompiled_dir, clean + ".js")
        if os.path.isfile(js_candidate):
            return "页面路由"
        idx_candidate = os.path.join(decompiled_dir, clean, "index.js")
        if os.path.isfile(idx_candidate):
            return "页面路由"
    # Layer 4: 路径模式兜底 (subpackage/pageName/pageName)
    segs = [s for s in clean.split("/") if s]
    if len(segs) >= 2 and segs[-1] == segs[-2]:
        return "页面路由"
    return "API 端点"


def write_api_xlsx(api_paths, outdir, all_page_routes, decompiled_dir=None, subpackage_roots=None):
    """输出 api_endpoints.xlsx — 测试状态下拉 + 条件格式"""
    from openpyxl import Workbook
    from openpyxl.styles import Font, PatternFill, Alignment
    from openpyxl.formatting.rule import FormulaRule
    from openpyxl.worksheet.datavalidation import DataValidation

    headers = ['接口', '类型', '接口功能', '测试状态', '所在JS文件', 'method']
    col_widths = {'A': 45, 'B': 12, 'C': 50, 'D': 10, 'E': 30, 'F': 10}

    wb = Workbook()
    ws = wb.active
    ws.title = "api_endpoints"

    # 表头样式: 蓝底白字
    header_fill = PatternFill(start_color="4472C4", end_color="4472C4", fill_type="solid")
    header_font = Font(bold=True, color="FFFFFF")
    for col_idx, h in enumerate(headers, 1):
        cell = ws.cell(row=1, column=col_idx, value=h)
        cell.fill = header_fill
        cell.font = header_font
        cell.alignment = Alignment(horizontal="center")

    # 写入数据行
    seen = set()
    row_num = 2
    for item in api_paths:
        path = item["path"]
        if path in seen:
            continue
        seen.add(path)
        path_type = classify_path_type(path, all_page_routes, decompiled_dir, subpackage_roots)
        ws.cell(row=row_num, column=1, value=path)
        ws.cell(row=row_num, column=2, value=path_type)
        ws.cell(row=row_num, column=3, value="")  # 接口功能 — AI 填
        ws.cell(row=row_num, column=4, value="")  # 测试状态 — 人工选
        ws.cell(row=row_num, column=5, value=item.get("file", ""))
        ws.cell(row=row_num, column=6, value="")  # method
        row_num += 1

    last_row = row_num - 1

    # 列宽
    for col_letter, width in col_widths.items():
        ws.column_dimensions[col_letter].width = width

    # 冻结首行 + 自动筛选
    ws.freeze_panes = "A2"
    if last_row >= 2:
        ws.auto_filter.ref = f"A1:F{last_row}"

    # 数据验证: 测试状态下拉
    if last_row >= 2:
        dv = DataValidation(type="list", formula1='"未测,已测,有漏洞,跳过"', allow_blank=True)
        dv.error = "请选择有效状态"
        dv.errorTitle = "无效输入"
        ws.add_data_validation(dv)
        dv.add(f"D2:D{last_row}")

    # 条件格式 (stopIfTrue 确保优先级)
    if last_row >= 2:
        cf_range = f"A2:F{last_row}"
        red_fill = PatternFill(start_color="FFC7CE", end_color="FFC7CE", fill_type="solid")
        green_fill = PatternFill(start_color="C6EFCE", end_color="C6EFCE", fill_type="solid")
        gray_fill = PatternFill(start_color="F2F2F2", end_color="F2F2F2", fill_type="solid")
        ws.conditional_formatting.add(cf_range,
            FormulaRule(formula=['$D2="有漏洞"'], fill=red_fill, stopIfTrue=True))
        ws.conditional_formatting.add(cf_range,
            FormulaRule(formula=['$D2="已测"'], fill=green_fill, stopIfTrue=True))
        ws.conditional_formatting.add(cf_range,
            FormulaRule(formula=['$D2="跳过"'], fill=gray_fill, stopIfTrue=True))

    xlsx_path = os.path.join(outdir, "api_endpoints.xlsx")
    wb.save(xlsx_path)
    print(f"  [*] 接口XLSX: {xlsx_path} ({len(seen)} 条)")
    return xlsx_path


def write_params_csv(params, outdir):
    """输出参数CSV: 参数, 提取来源, 是否参数(待AI), 参数中文描述(待AI), 所在JS文件"""
    import csv

    _SOURCE_CN = {
        "api_request": "API请求",
        "url_param": "URL参数",
        "urlsearchparams": "URL参数",
        "url_template": "URL参数",
        "config_object": "请求配置",
        "route_param": "路由参数",
        "object_property": "对象属性",
        "destructuring": "变量解构",
        "nested_destructuring": "变量解构",
        "function_param": "函数形参",
        "arrow_param": "函数形参",
        "function_param_destructure": "函数形参",
        "arrow_destructure": "函数形参",
        "variable_assignment": "变量赋值",
        "wx_request": "API请求",
        "wx_request_data": "API请求",
        "wx_request_header": "API请求",
        "wx_request_formData": "API请求",
    }
    _SOURCE_PRI = {
        "api_request": 6, "wx_request": 6, "wx_request_data": 6,
        "wx_request_header": 6, "wx_request_formData": 6,
        "url_param": 5, "urlsearchparams": 5, "url_template": 5,
        "config_object": 4, "route_param": 3,
        "object_property": 1, "destructuring": 1, "nested_destructuring": 1,
        "function_param": 1, "arrow_param": 1, "function_param_destructure": 1,
        "arrow_destructure": 1, "variable_assignment": 1,
    }

    # 按参数名聚合, 保留最高优先级来源
    param_info = {}
    param_files = defaultdict(list)
    for p in params:
        name = p["value"]
        param_files[name].append(p["file"])
        new_src = p.get("source", "")
        existing_src = param_info.get(name, "")
        if _SOURCE_PRI.get(new_src, 0) > _SOURCE_PRI.get(existing_src, 0):
            param_info[name] = new_src

    csv_path = os.path.join(outdir, "params.csv")
    with open(csv_path, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=["参数", "提取来源", "是否参数", "参数中文描述", "所在JS文件"])
        w.writeheader()
        for value in sorted(param_info.keys()):
            files = "; ".join(sorted(set(param_files[value])))
            source_cn = _SOURCE_CN.get(param_info[value], param_info[value])
            w.writerow({"参数": value, "提取来源": source_cn, "是否参数": "", "参数中文描述": "", "所在JS文件": files})
    print(f"  [*] 参数CSV: {csv_path} ({len(param_info)} 条)")
    return csv_path


def write_sensitive_csv(sensitive, outdir):
    import csv
    LABEL_MAP = {
        "emails": "邮箱", "phones": "手机号", "ips": "IP地址",
        "id_cards": "身份证号",
        "jwt_tokens": "JWT Token", "private_keys": "私钥",
        "bearer_tokens": "Bearer Token", "github_tokens": "GitHub Token",
        "gitlab_tokens": "GitLab Token",
    }
    AK_LABELS = {
        "aliyun_ak": "阿里云AK", "aws_ak": "AWS AK",
        "google_ak": "谷歌云AK", "tencent_ak": "腾讯云AK",
        "jinshan_ak": "金山云AK", "huoshan_ak": "火山引擎AK",
        "jingdong_ak": "京东云AK",
        "qywx_corpid": "企业微信CorpID", "wx_appid": "微信AppID", "wx_gzh": "微信公众号ID",
    }
    WEBHOOK_LABELS = {
        "slack_webhook": "Slack Webhook", "feishu_webhook": "飞书Webhook",
        "dingtalk_webhook": "钉钉Webhook", "wechat_webhook": "企业微信Webhook",
    }
    GRAFANA_LABELS = {
        "grafana_sa_token": "Grafana SA Token",
        "grafana_cloud_token": "Grafana Cloud Token",
        "grafana_api_key": "Grafana API Key",
    }
    rows = []
    for key, label in LABEL_MAP.items():
        for item in sensitive.get(key, []):
            rows.append({"类型": label, "值": item.get("value", ""), "所在文件": item.get("file", "")})
    for d, labels in [("cloud_aks", AK_LABELS), ("webhooks", WEBHOOK_LABELS), ("grafana", GRAFANA_LABELS)]:
        for key, label in labels.items():
            for item in sensitive.get(d, {}).get(key, []):
                rows.append({"类型": label, "值": item.get("value", ""), "所在文件": item.get("file", "")})
    csv_path = os.path.join(outdir, "sensitive_findings.csv")
    with open(csv_path, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=["类型", "值", "所在文件"])
        w.writeheader()
        w.writerows(rows)
    print(f"  [*] 敏感信息CSV: {csv_path} ({len(rows)} 条)")


def write_noise_candidates(noise, outdir):
    if not noise:
        return None
    noise = deduplicate_noise(noise)
    path = os.path.join(outdir, "noise_candidates.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump({
            "total": len(noise),
            "items": noise,
        }, f, ensure_ascii=False, indent=2)
    print(f"  [*] 噪音候选: {path} ({len(noise)} 条)")
    return path


def deduplicate_noise(noise):
    seen = set()
    result = []
    for item in noise:
        key = (
            item.get("category", ""),
            item.get("type", ""),
            item.get("level", ""),
            item.get("reason", ""),
            item.get("file", ""),
            item.get("value", ""),
            item.get("normalized_value", ""),
        )
        if key in seen:
            continue
        seen.add(key)
        result.append(item)
    return result


def generate_human_report(report):
    lines = []
    sep = "=" * 60

    s = report["summary"]
    lines.append(sep)
    lines.append("  微信小程序安全审计报告")
    lines.append(sep)
    lines.append(f"  JS文件扫描数量: {s['js_files_scanned']}")
    lines.append(f"  API路径提取数量: {s['api_paths_count']}")
    lines.append(f"  参数提取数量  : {s.get('params_count', 0)}")
    lines.append(f"  后端URL提取数量: {s['backend_urls_count']}")
    lines.append(f"  注释提取数量  : {s['comment_items_count']}")
    lines.append(f"  敏感信息提取数量: {s['sensitive_items_count']}")
    lines.append(f"  app.json页面配置: {s.get('page_count', 0)} 个页面")
    lines.append(f"  云开发相关  : {s.get('cloud_count', 0)} 条")
    lines.append(f"  wx API调用  : {s.get('wx_api_count', 0)} 条")
    lines.append(sep)
    lines.append("")

    pages = report.get("minapp", {}).get("pages", [])
    if pages:
        total_routes = sum(len(p.get("routes", [])) for p in pages)
        lines.append(sep)
        lines.append(f"  小程序页面路由 ({total_routes} 个)")
        lines.append(sep)
        for p in pages:
            routes = p.get("routes", [])
            for r in routes[:30]:
                lines.append(f"    - /{r['page']}")
            if len(routes) > 30:
                lines.append(f"    ... 还有 {len(routes)-30} 个页面")
        lines.append("")

    api_paths = report["api_paths"]
    if api_paths:
        lines.append(sep)
        lines.append("  一、API接口路径 (按前缀分组)")
        lines.append(sep)
        group = defaultdict(list)
        for p in api_paths:
            segment = p["path"].split("/")
            key = "/" + segment[1] if len(segment) > 1 else "/other"
            group[key].append(p["path"])
        for key in sorted(group.keys()):
            unique = sorted(set(group[key]))
            lines.append(f"  [{key}] ({len(unique)}条)")
            for path in unique[:10]:
                lines.append(f"    - {path}")
            if len(unique) > 10:
                lines.append(f"    ... 还有{len(unique)-10}条")
            lines.append("")

    wx_api = report.get("minapp", {}).get("wx_api_calls", [])
    if wx_api:
        lines.append(sep)
        lines.append(f"  二、wx.request/uploadFile API 调用 ({len(wx_api)}条)")
        lines.append(sep)
        for w in wx_api[:20]:
            lines.append(f"    [{w['file']}] {w.get('url', w.get('url_var', ''))}")
        if len(wx_api) > 20:
            lines.append(f"    ... 还有 {len(wx_api)-20} 条")
        lines.append("")

    cloud = report.get("minapp", {}).get("cloud_envs", [])
    if cloud:
        lines.append(sep)
        lines.append(f"  三、云开发/云函数 ({len(cloud)}条)")
        lines.append(sep)
        for c in cloud:
            v = c.get("env") or c.get("function") or c.get("match", "")
            lines.append(f"    [{c['file']}] [{c['type']}] {v}")
        lines.append("")

    secrets = report.get("minapp", {}).get("app_secrets", [])
    if secrets:
        lines.append(sep)
        lines.append(f"  四、疑似密钥泄露 ({len(secrets)}条)")
        lines.append(sep)
        for s in secrets[:10]:
            lines.append(f"    [{s['file']}] {s['value']}")
        lines.append("")

    sensitive = report["sensitive"]
    cat_map = {
        "emails": ("五、邮箱地址", "emails"),
        "phones": ("六、手机号码", "phones"),
        "ips": ("七、IP地址", "ips"),
        "id_cards": ("八、身份证号", "id_cards"),
        "jwt_tokens": ("九、JWT Token", "jwt_tokens"),
        "private_keys": ("十、私钥", "private_keys"),
        "bearer_tokens": ("十一、Bearer Token", "bearer_tokens"),
        "github_tokens": ("十二、GitHub Token", "github_tokens"),
        "gitlab_tokens": ("十三、GitLab Token", "gitlab_tokens"),
    }

    for key, (title, cat) in cat_map.items():
        items = sensitive.get(cat, [])
        if not items:
            continue
        unique = sorted(set(i["value"] for i in items))
        lines.append(sep)
        lines.append(f"  {title} ({len(unique)}条)")
        lines.append(sep)
        for v in unique[:15]:
            lines.append(f"    - {v}")
        if len(unique) > 15:
            lines.append(f"    ... 还有{len(unique)-15}条")
        lines.append("")

    cloud_aks = sensitive.get("cloud_aks", {})
    all_ak = []
    for k, v in cloud_aks.items():
        all_ak.extend(v)
    if all_ak:
        lines.append(sep)
        lines.append(f"  十四、云平台AccessKey ({len(all_ak)}条)")
        lines.append(sep)
        for v in sorted(set(i["value"] for i in all_ak))[:15]:
            lines.append(f"    - {v}")
        lines.append("")

    webhooks = sensitive.get("webhooks", {})
    all_webhook = []
    for k, v in webhooks.items():
        all_webhook.extend(v)
    if all_webhook:
        lines.append(sep)
        lines.append(f"  十五、Webhook ({len(all_webhook)}条)")
        lines.append(sep)
        for v in sorted(set(i["value"] for i in all_webhook)):
            lines.append(f"    - {v}")
        lines.append("")

    grafana = sensitive.get("grafana", {})
    all_grafana = []
    for k, v in grafana.items():
        all_grafana.extend(v)
    if all_grafana:
        lines.append(sep)
        lines.append(f"  十五-B、Grafana Token ({len(all_grafana)}条)")
        lines.append(sep)
        for v in sorted(set(i["value"] for i in all_grafana)):
            lines.append(f"    - {v}")
        lines.append("")

    backend_urls = report["backend_urls"]
    if backend_urls:
        lines.append(sep)
        lines.append(f"  十六、后端URL ({len(backend_urls)}条)")
        lines.append(sep)
        domains = defaultdict(list)
        for u in backend_urls:
            url = u["url"]
            for d in ["https://", "http://"]:
                if d in url:
                    domain = url.split(d)[1].split("/")[0]
                    domains[domain].append(url)
                    break
        for domain in sorted(domains.keys()):
            unique = sorted(set(domains[domain]))
            lines.append(f"  [{domain}] ({len(unique)}条)")
            for url in unique[:5]:
                lines.append(f"    - {url}")
            if len(unique) > 5:
                lines.append(f"    ... 还有{len(unique)-5}条")

    lines.append("")
    lines.append(sep)
    lines.append("  报告生成完毕")
    lines.append(sep)
    return "\n".join(lines)


# ============================================================
# 主入口
# ============================================================

def run(decompiled_dir, outdir=None, ai_dir=None):
    print(f"[*] 开始提取: {decompiled_dir}")

    js_files = read_js_files(decompiled_dir)
    wxml_files = read_wxml_files(decompiled_dir)
    all_text_files = {**js_files, **wxml_files}

    js_count = len(js_files)
    if not js_files:
        print("  [-] 没有找到 JS 文件")
        return None

    print(f"  [+] 共读取 {len(all_text_files)} 个文件 ({js_count} JS, {len(wxml_files)} 其他)")

    noise_candidates = []

    api_paths = extract_js_urls(all_text_files, noise_candidates)
    print(f"  [+] API路径: {len(api_paths)} 条")

    backend_urls = extract_backend_urls(all_text_files)
    print(f"  [+] 后端URL: {len(backend_urls)} 条")

    comments = extract_comments(js_files)
    comment_count = sum(len(v) for v in comments.values())
    print(f"  [+] 注释: {comment_count} 条")

    sensitive = extract_sensitive(all_text_files, noise_candidates)
    sensitive_count = sum(
        len(v) if isinstance(v, list) else
        sum(len(x) for x in v.values()) if isinstance(v, dict) else 0
        for v in sensitive.values()
    )
    # per-category counts for stdout
    _cat_labels = {
        "emails": "邮箱", "phones": "手机", "ips": "IP",
        "id_cards": "身份证", "jwt_tokens": "JWT", "private_keys": "私钥",
        "bearer_tokens": "Bearer", "github_tokens": "GitHub", "gitlab_tokens": "GitLab",
    }
    _cat_parts = []
    for k, label in _cat_labels.items():
        v = sensitive.get(k, [])
        if v:
            _cat_parts.append(f"{label}={len(v)}")
    for dk, dlabel in [("cloud_aks", "云AK"), ("webhooks", "Webhook"), ("grafana", "Grafana")]:
        dv = sensitive.get(dk, {})
        total = sum(len(x) for x in dv.values())
        if total:
            _cat_parts.append(f"{dlabel}={total}")
    if _cat_parts:
        print(f"  [+] 敏感信息: {sensitive_count} 条 [{' '.join(_cat_parts)}]")
    else:
        print(f"  [+] 敏感信息: {sensitive_count} 条")
    noise_candidates = deduplicate_noise(noise_candidates)
    if noise_candidates:
        hard_count = sum(1 for item in noise_candidates if item.get("level") == "hard")
        soft_count = sum(1 for item in noise_candidates if item.get("level") == "soft")
        print(f"  [+] 噪音候选: {len(noise_candidates)} 条 (hard={hard_count}, soft={soft_count})")

    print("  [+] 参数提取 (ParamX 引擎)...")
    params_result = paramx_extract.extract_parameters(js_files)
    param_count = params_result["total"]
    print(f"  [+] 参数: {param_count} 个 (来自 {len(params_result['by_source'])} 种提取策略)")

    # 小程序专项
    app_config = extract_app_config(decompiled_dir)
    page_count = len(app_config["pages"])
    print(f"  [+] app.json 页面配置: {page_count} 个页面")

    wx_api_calls = extract_minapp_api_calls(js_files)
    print(f"  [+] wx API 调用: {len(wx_api_calls)} 条")

    cloud_envs = extract_cloud_env(js_files)
    print(f"  [+] 云开发相关: {len(cloud_envs)} 条")

    app_secrets = extract_app_secret(js_files)
    print(f"  [+] 疑似密钥: {len(app_secrets)} 条")

    router = extract_wx_router(app_config)

    report = {
        "summary": {
            "js_files_scanned": len(all_text_files),
            "api_paths_count": len(api_paths),
            "params_count": param_count,
            "backend_urls_count": len(backend_urls),
            "comment_items_count": comment_count,
            "sensitive_items_count": sensitive_count,
            "page_count": page_count,
            "cloud_count": len(cloud_envs),
            "wx_api_count": len(wx_api_calls),
            "secret_count": len(app_secrets),
            "noise_candidates_count": len(noise_candidates),
        },
        "api_paths": deduplicate(api_paths, "path"),
        "backend_urls": deduplicate(backend_urls, "url"),
        "comments": comments,
        "sensitive": sensitive,
        "extracted_params": params_result,
        "noise_candidates": noise_candidates,
        "minapp": {
            "pages": [router],
            "app_config": app_config,
            "wx_api_calls": wx_api_calls,
            "cloud_envs": cloud_envs,
            "app_secrets": app_secrets,
        },
    }

    if outdir:
        os.makedirs(outdir, exist_ok=True)

        # --- 中间产物 → ai_dir (AI 工作区) ---
        # 默认 ai_dir = outdir (向后兼容)
        ai = ai_dir or outdir
        os.makedirs(ai, exist_ok=True)

        json_path = os.path.join(ai, "report.json")
        with open(json_path, "w", encoding="utf-8") as f:
            json.dump(report, f, ensure_ascii=False, indent=2)
        print(f"\n  [*] 结构化数据: {json_path}")

        txt_path = os.path.join(outdir, "report.txt")
        with open(txt_path, "w", encoding="utf-8") as f:
            f.write(generate_human_report(report))
        print(f"  [*] 人类可读报告: {txt_path}")

        param_path = os.path.join(ai, "report_params.txt")
        with open(param_path, "w", encoding="utf-8") as f:
            f.write(paramx_extract.generate_param_report(params_result))
        print(f"  [*] 参数提取报告: {param_path}")

        # --- 最终交付物 → outdir (recon/) ---
        all_page_routes = set(app_config.get("all_page_routes", []))
        subpackage_roots = [sp["root"].rstrip("/") for sp in app_config.get("subpackages", []) if sp.get("root")]
        write_api_xlsx(report["api_paths"], outdir, all_page_routes, decompiled_dir, subpackage_roots)
        write_params_csv(params_result["params"], outdir)
        write_sensitive_csv(sensitive, outdir)
        write_noise_candidates(noise_candidates, ai)
    else:
        print(json.dumps(report, ensure_ascii=False, indent=2))

    print(f"\n  [*] 扫描完成: {js_count} 个JS文件, {param_count} 个参数, {sensitive_count} 条敏感信息, {page_count} 个页面")
    return report


def main():
    import argparse
    parser = argparse.ArgumentParser(description="微信小程序安全审计 - 敏感信息提取")
    parser.add_argument("decompiled_dir", help="反编译后的小程序源码目录")
    parser.add_argument("--outdir", help="最终交付物输出目录 (api_endpoints.xlsx + params.csv + sensitive_findings.csv)")
    parser.add_argument("--ai-dir", help="AI 工作区输出目录 (report.json + report.txt + report_params.txt), 默认同 --outdir")
    args = parser.parse_args()

    run(args.decompiled_dir, args.outdir, args.ai_dir)


if __name__ == "__main__":
    main()
