"""Loop Engineering 浏览器验证助手

用法：python browser_check.py <url> <screenshot.png> [--click selector]... [--wait-text 文本]

- 打开（有头）Chromium 访问页面
- 采集 console error/warning、pageerror、失败请求
- 可选点击若干选择器、等待文本出现
- 输出 JSON 摘要（stdout）并保存截图
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys

from playwright.async_api import async_playwright

FRONT = "http://localhost:3000"


async def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("path", help="站点路径，如 / 或 /tasks")
    ap.add_argument("shot", help="截图输出路径")
    ap.add_argument("--click", action="append", default=[], help="点击的选择器（可多次）")
    ap.add_argument("--wait-text", default=None, help="等待出现的文本")
    ap.add_argument("--headed", action="store_true", default=True)
    ap.add_argument("--timeout", type=int, default=20000)
    args = ap.parse_args()

    console_msgs: list[dict] = []
    page_errors: list[str] = []
    bad_requests: list[str] = []

    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=not args.headed)
        page = await browser.new_page(viewport={"width": 1440, "height": 900})
        page.on(
            "console",
            lambda m: console_msgs.append({"type": m.type, "text": m.text[:300]})
            if m.type in ("error", "warning")
            else None,
        )
        page.on("pageerror", lambda e: page_errors.append(str(e)[:300]))
        page.on("requestfailed", lambda r: bad_requests.append(f"{r.url} {r.failure}"))

        await page.goto(FRONT + args.path, wait_until="networkidle", timeout=args.timeout)

        for sel in args.click:
            try:
                await page.click(sel, timeout=5000)
                await page.wait_for_load_state("networkidle")
            except Exception as e:  # noqa: BLE001
                bad_requests.append(f"click {sel}: {e}")

        if args.wait_text:
            try:
                await page.wait_for_selector(f"text={args.wait_text}", timeout=args.timeout)
            except Exception:
                page_errors.append(f"wait-text 未出现: {args.wait_text}")

        await page.wait_for_timeout(1200)  # 稳定渲染
        await page.screenshot(path=args.shot, full_page=True)
        await browser.close()

    errors = [m for m in console_msgs if m["type"] == "error"]
    warnings = [m for m in console_msgs if m["type"] == "warning"]
    print(
        json.dumps(
            {
                "url": FRONT + args.path,
                "shot": args.shot,
                "console_errors": errors,
                "console_warnings": warnings,
                "page_errors": page_errors,
                "failed_requests": bad_requests,
                "ok": not errors and not page_errors,
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0 if not errors and not page_errors else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
