import os
import sys
import json
import io
import subprocess
import tempfile

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

from config_loader import get_wechat_paths, get_tool_cmds

_cfg_paths = get_wechat_paths()

# 旧版微信 (3.x): 直接存储 __APP__.wxapkg 文件
OLD_FORMAT_PATHS = _cfg_paths["old_format_paths"] or [
    os.path.join(os.environ.get("USERPROFILE", ""), "Documents", "WeChat Files", "Applet"),
]

# 新版微信 (xwechat): applet/packages/<wxappid>/<version>/__APP__.wxapkg
XWECHAT_USERS = _cfg_paths["xwechat_users"] or os.path.join(
    os.environ.get("APPDATA", ""), "Tencent", "xwechat", "radium", "users"
)

_cfg_tools = get_tool_cmds()
NODE_CMD = _cfg_tools["node"]
WEDECODE_CMD = _cfg_tools["wedecode"]


# ============================================================
# 环境检查
# ============================================================

def check_env():
    info = {"node": False, "wedecode": False}
    try:
        r = subprocess.run([NODE_CMD, "--version"], capture_output=True, timeout=5,
                           creationflags=subprocess.CREATE_NO_WINDOW)
        if r.returncode == 0:
            info["node"] = True
    except Exception:
        pass
    try:
        r = subprocess.run(
            ["powershell", "-NoProfile", "-Command", f"{WEDECODE_CMD} --version"],
            capture_output=True, text=True, timeout=10,
            creationflags=subprocess.CREATE_NO_WINDOW
        )
        if r.returncode == 0:
            info["wedecode"] = True
    except Exception:
        pass
    return info


# ============================================================
# 旧版格式扫描 (直接 .wxapkg 文件)
# ============================================================

def scan_old_format():
    found = []
    seen = set()
    for base in OLD_FORMAT_PATHS:
        if not os.path.isdir(base):
            continue
        for entry in os.listdir(base):
            full = os.path.join(base, entry)
            if not os.path.isdir(full):
                continue
            main_pkg = os.path.join(full, "__APP__.wxapkg")
            if not os.path.isfile(main_pkg):
                continue
            if entry in seen:
                continue
            seen.add(entry)
            size = os.path.getsize(main_pkg)
            mtime = os.path.getmtime(main_pkg)
            found.append({
                "format": "old",
                "appid": entry,
                "path": full,
                "main_pkg": main_pkg,
                "size": size,
                "size_str": fmt_size(size),
                "mtime": mtime,
                "mtime_str": fmt_time(mtime),
                "sub_pkgs": scan_sub_pkgs(full),
            })
    found.sort(key=lambda x: x["mtime"], reverse=True)
    return found


# ============================================================
# 新版 xwechat 格式扫描 (applet/packages/<wxappid>/<version>)
# ============================================================

def scan_xwechat_format():
    found = []
    if not os.path.isdir(XWECHAT_USERS):
        return found
    for user_hash in os.listdir(XWECHAT_USERS):
        pkg_dir = os.path.join(XWECHAT_USERS, user_hash, "applet", "packages")
        if not os.path.isdir(pkg_dir):
            continue
        for wxappid in os.listdir(pkg_dir):
            appid_dir = os.path.join(pkg_dir, wxappid)
            if not os.path.isdir(appid_dir):
                continue
            versions = sorted(
                [v for v in os.listdir(appid_dir)
                 if os.path.isdir(os.path.join(appid_dir, v))],
                reverse=True
            )
            main_pkg = None
            sub_pkgs = []
            for version in versions:
                ver_dir = os.path.join(appid_dir, version)
                fp = os.path.join(ver_dir, "__APP__.wxapkg")
                if os.path.isfile(fp):
                    main_pkg = fp
                    sub_pkgs = [
                        os.path.join(ver_dir, f) for f in os.listdir(ver_dir)
                        if f.endswith(".wxapkg") and f != "__APP__.wxapkg"
                    ]
                    break
            if not main_pkg:
                continue
            size = os.path.getsize(main_pkg)
            mtime = os.path.getmtime(main_pkg)
            found.append({
                "format": "xwechat",
                "appid": wxappid,
                "path": appid_dir,
                "main_pkg": main_pkg,
                "size": size,
                "size_str": fmt_size(size),
                "mtime": mtime,
                "mtime_str": fmt_time(mtime),
                "sub_pkgs": sub_pkgs,
            })
    found.sort(key=lambda x: x["mtime"], reverse=True)
    return found


# ============================================================
# 自定义目录扫描 (旧版格式)
# ============================================================

def scan_custom_dir(path):
    found = []
    if not os.path.isdir(path):
        return found
    for entry in os.listdir(path):
        full = os.path.join(path, entry)
        main_pkg = None
        if os.path.isfile(full) and full.endswith(".wxapkg"):
            main_pkg = full
            appid = os.path.splitext(entry)[0]
        elif os.path.isdir(full):
            mp = os.path.join(full, "__APP__.wxapkg")
            if os.path.isfile(mp):
                main_pkg = mp
                appid = entry
            else:
                continue
        else:
            continue
        size = os.path.getsize(main_pkg)
        mtime = os.path.getmtime(main_pkg)
        found.append({
            "format": "old",
            "appid": appid,
            "path": os.path.dirname(main_pkg),
            "main_pkg": main_pkg,
            "size": size,
            "size_str": fmt_size(size),
            "mtime": mtime,
            "mtime_str": fmt_time(mtime),
            "sub_pkgs": scan_sub_pkgs(os.path.dirname(main_pkg)),
        })
    found.sort(key=lambda x: x["mtime"], reverse=True)
    return found


def scan_sub_pkgs(pkg_dir):
    subs = []
    for f in os.listdir(pkg_dir):
        if f.startswith("__sub_") and f.endswith(".wxapkg"):
            full = os.path.join(pkg_dir, f)
            subs.append(full)
    return subs


# ============================================================
# 名称解析（最佳尝试，失败则返回 None）
# ============================================================

def resolve_app_name(appid, main_pkg=None):
    """尝试获取小程序昵称：先试 API，再试本地解包"""
    name = resolve_name_via_api(appid)
    if name:
        return name
    if main_pkg:
        name = resolve_name_via_unpack(appid, main_pkg)
    return name


def resolve_name_via_api(appid):
    """通过 kainy.cn API 查询小程序名称（可能被 Cloudflare 拦截）"""
    try:
        import requests
        headers = {
            "Content-Type": "application/json",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            "Origin": "https://kainy.cn",
            "Referer": "https://kainy.cn/"
        }
        r = requests.post("https://kainy.cn/api/weapp/info/",
                          json={"appid": appid},
                          headers=headers, timeout=5)
        if r.status_code == 200:
            data = r.json()
            if data.get("code") == 0 and data.get("data", {}).get("nickname"):
                return data["data"]["nickname"]
        # try cloudscraper as fallback
        try:
            import cloudscraper
            scraper = cloudscraper.create_scraper()
            r2 = scraper.post("https://kainy.cn/api/weapp/info/",
                              json={"appid": appid}, timeout=10)
            if r2.status_code == 200:
                data = r2.json()
                if data.get("code") == 0 and data.get("data", {}).get("nickname"):
                    return data["data"]["nickname"]
        except ImportError:
            pass
        except Exception:
            pass
    except ImportError:
        pass
    except Exception:
        pass
    return None


def resolve_name_via_unpack(appid, main_pkg):
    """快速解包 app-config.json 提取 tabBar 文字作为名称提示"""
    tmp = tempfile.mkdtemp(prefix="wx_name_")
    try:
        # wedecode 是 .ps1 文件，必须通过 powershell 调用
        cmd = ["powershell", "-NoProfile", "-Command",
               WEDECODE_CMD, main_pkg, "--out", tmp, "--clear", "--unpack-only"]
        proc = subprocess.run(
            cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            timeout=60, creationflags=subprocess.CREATE_NO_WINDOW
        )
        if proc.returncode != 0:
            return None
        ac_json = os.path.join(tmp, "app-config.json")
        if not os.path.isfile(ac_json):
            return None
        with open(ac_json, "r", encoding="utf-8") as f:
            cfg = json.load(f)
        # 优先从 tabBar 提取文字
        tab_bar = cfg.get("tabBar")
        if tab_bar and tab_bar.get("list"):
            names = [item.get("text", "") for item in tab_bar["list"] if item.get("text")]
            if names:
                return "/".join(names)
        # 其次从页面标题提取
        pages = cfg.get("page", {})
        if pages:
            titles = []
            for key in list(pages.keys())[:3]:
                win = pages[key].get("window", {})
                t = win.get("navigationBarTitleText", "")
                if t:
                    titles.append(t)
            if titles:
                return "/".join(titles)
    except subprocess.TimeoutExpired:
        pass
    except Exception:
        pass
    finally:
        try:
            import shutil
            shutil.rmtree(tmp, ignore_errors=True)
        except Exception:
            pass
    return None


def fmt_size(size):
    for unit in ("B", "KB", "MB", "GB"):
        if size < 1024:
            return f"{size:.1f} {unit}"
        size /= 1024
    return f"{size:.1f} TB"


def fmt_time(ts):
    import datetime
    return datetime.datetime.fromtimestamp(ts).strftime("%Y-%m-%d %H:%M")


def display_menu(apps, xwechat_hint=True, names_resolved=True):
    sep = "=" * 60
    print(sep)
    print("  微信小程序扫描结果")
    print(sep)
    if not apps:
        print("  [空] 没有找到任何小程序包\n")
        if xwechat_hint:
            print("  [!] 检测到 xwechat 格式但未找到有效包，可能路径有差异")
            xw_apps = scan_xwechat_format()
            if xw_apps:
                print(f"  [+] 在 xwechat 路径下找到 {len(xw_apps)} 个小程序:")
                for a in xw_apps:
                    print(f"     {a['appid']} - {a['main_pkg']} ({a['size_str']})")
                print("\n  请使用 --dir 参数直接指定目录，或输入 0 自定义路径")
        return
    print(f"  共找到 {len(apps)} 个小程序:\n")
    for i, app in enumerate(apps, 1):
        name = app.get("display_name") or app.get("appid")
        fmt_map = {"old": "[旧版WeChat]", "xwechat": "[新版xwechat]"}
        fmt = fmt_map.get(app.get("format"), "[未知]")
        sub_info = f" (+{len(app.get('sub_pkgs', []))} 分包)" if app.get("sub_pkgs") else ""
        name_tag = app.get("display_name") or ""
        if name_tag and name_tag != app.get("appid"):
            print(f"  {fmt} [{i}] {name_tag} ({app['appid']})")
        else:
            print(f"  {fmt} [{i}] {name}")
        print(f"      路径: {app['main_pkg']}")
        print(f"      大小: {app['size_str']}")
        print(f"      时间: {app['mtime_str']}{sub_info}")
        print()
    if not names_resolved:
        print("  [!] 名称未解析（使用 --resolve-names 尝试通过 API/解包获取）")
    print("  0: 输入自定义扫描目录")
    print("  q: 退出")


def select_app(apps):
    while True:
        choice = input("\n请选择编号 (1-{}), 0 自定义目录, q 退出: ".format(len(apps))).strip()
        if choice.lower() == "q":
            return None
        if choice == "0":
            custom = input("请输入小程序包所在目录路径: ").strip()
            if custom:
                custom_apps = scan_custom_dir(custom)
                if not custom_apps:
                    print("  [-] 指定目录未找到 wxapkg 文件")
                    continue
                display_menu(custom_apps, xwechat_hint=False)
                apps = custom_apps
                continue
        try:
            idx = int(choice) - 1
            if 0 <= idx < len(apps):
                return apps[idx]
        except ValueError:
            pass
        print("  [-] 无效选择，请重试")


# ============================================================
# 主入口
# ============================================================

def _resolve_names_for_apps(apps):
    """使用线程池尝试解析所有小程序名称"""
    import concurrent.futures
    resolved = 0
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as ex:
        fut_map = {}
        for app in apps:
            if app.get("display_name"):
                resolved += 1
                continue
            fut = ex.submit(resolve_app_name, app["appid"], app.get("main_pkg"))
            fut_map[fut] = app
        for fut in concurrent.futures.as_completed(fut_map):
            app = fut_map[fut]
            try:
                name = fut.result()
                if name:
                    app["display_name"] = name
                    resolved += 1
            except Exception:
                pass
    return resolved


def main():
    import argparse
    parser = argparse.ArgumentParser(description="扫描微信小程序包")
    parser.add_argument("--check-env", action="store_true", help="仅检查环境")
    parser.add_argument("--dir", help="指定扫描目录（跳过自动扫描）")
    parser.add_argument("--json", action="store_true", help="JSON 格式输出（非交互）")
    parser.add_argument("--resolve-names", action="store_true",
                        help="尝试解析小程序名称（API+本地解包，较慢）")
    parser.add_argument("--quick", action="store_true", help="快速模式（跳过名称解析）")
    args = parser.parse_args()

    if args.check_env:
        env = check_env()
        print(json.dumps(env, ensure_ascii=False, indent=2))
        return

    if args.dir:
        apps = scan_custom_dir(args.dir)
    else:
        apps = scan_old_format()
        if not apps:
            apps = scan_xwechat_format()

    names_resolved = False
    if apps and not args.quick:
        do_resolve = args.resolve_names
        if do_resolve:
            print("  正在解析小程序名称...")
            count = _resolve_names_for_apps(apps)
            names_resolved = True
            print(f"  完成：解析到 {count}/{len(apps)} 个小程序名称")

    if args.json:
        print(json.dumps(apps, ensure_ascii=False, indent=2, default=str))
        return

    has_xwechat = bool(scan_xwechat_format()) if not args.dir else False
    display_menu(apps, xwechat_hint=has_xwechat, names_resolved=names_resolved)

    if apps:
        selected = select_app(apps)
        if selected:
            result = {
                "appid": selected["appid"],
                "format": selected.get("format", "xwechat"),
                "name": selected.get("display_name", ""),
                "main_pkg": selected.get("main_pkg", ""),
                "sub_pkgs": selected.get("sub_pkgs", []),
                "output_dir": os.path.join(os.getcwd(), "decompile_output", selected["appid"]),
            }
            print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
