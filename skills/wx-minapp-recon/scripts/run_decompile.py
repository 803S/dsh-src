import os
import sys
import json
import io
import subprocess
import shutil

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

from config_loader import get_tool_cmds, platform_run

_cfg_tools = get_tool_cmds()
WEDECODE_CMD = _cfg_tools["wedecode"]

DECOMPILE_TIMEOUT = 120


def check_wedecode():
    try:
        # [local.61] 跨平台：Windows 走 powershell 包装，mac/Linux 直接跑 npm bin
        r = platform_run([WEDECODE_CMD, "--version"], timeout=10)
        if r.returncode == 0:
            version = (r.stdout or "").strip() or (r.stderr or "").strip() or "unknown"
            print(f"  [+] wedecode 版本: {version}")
            return True
    except FileNotFoundError:
        pass
    except subprocess.TimeoutExpired:
        pass
    print("  [-] wedecode 未安装或不可用")
    return False


def run_decompile(main_pkg, output_dir, sub_pkgs=None):
    if not os.path.isfile(main_pkg):
        print(f"  [-] 文件不存在: {main_pkg}")
        return None

    if os.path.exists(output_dir):
        print(f"  [*] 输出目录已存在，将被覆盖: {output_dir}")
        shutil.rmtree(output_dir)

    os.makedirs(output_dir, exist_ok=True)

    # [local.61] 跨平台：直接构造 argv，Windows 由 platform_run 内部加 powershell 包装
    cmd = [WEDECODE_CMD, main_pkg, "--out", output_dir, "--clear"]

    print(f"  [*] 执行: wedecode ... (主包: {os.path.basename(main_pkg)})")
    if sub_pkgs:
        print(f"  [*] 检测到 {len(sub_pkgs)} 个分包 (wedecode 自动发现)")

    sys.stdout.flush()

    try:
        r = platform_run(
            cmd,
            timeout=DECOMPILE_TIMEOUT,
        )
        out = (r.stdout or "").strip()
        err = (r.stderr or "").strip()
        if out:
            print(out)
        if err:
            print(err, file=sys.stderr)

        if r.returncode != 0:
            print(f"  [-] wedecode 返回非零退出码: {r.returncode}")
            return None

    except FileNotFoundError:
        print("  [-] 未找到 wedecode 命令，请执行: npm i wedecode -g")
        return None
    except subprocess.TimeoutExpired:
        print(f"  [-] 反编译超时 ({DECOMPILE_TIMEOUT}s)，小程序包可能过大")
        return None

    if not os.path.isdir(output_dir):
        print(f"  [-] 反编译后输出目录不存在: {output_dir}")
        return None

    js_count = count_js_files(output_dir)
    print(f"  [+] 反编译完成: {js_count} 个 JS 文件 -> {output_dir}")

    return output_dir


def count_js_files(root_dir):
    count = 0
    for root, dirs, files in os.walk(root_dir):
        for f in files:
            if f.endswith(".js"):
                count += 1
    return count


def main():
    import argparse
    parser = argparse.ArgumentParser(description="调用 wedecode 反编译微信小程序")
    parser.add_argument("-i", "--input", help="主包路径 (__APP__.wxapkg)")
    parser.add_argument("-o", "--output", help="输出目录")
    parser.add_argument("--sub", nargs="*", default=[], help="分包路径列表")
    parser.add_argument("--check", action="store_true", help="仅检查 wedecode 可用性")
    args = parser.parse_args()

    if args.check:
        available = check_wedecode()
        sys.exit(0 if available else 1)

    if not args.input or not args.output:
        parser.print_help()
        sys.exit(1)

    if not check_wedecode():
        print("  请先安装 wedecode: npm i wedecode -g")
        sys.exit(1)

    result_dir = run_decompile(args.input, args.output, args.sub)
    if result_dir:
        result = {
            "decompiled_dir": result_dir,
            "js_count": count_js_files(result_dir),
        }
        print(f"\n  [*] 反编译结果 (JSON):")
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        sys.exit(1)


if __name__ == "__main__":
    main()
