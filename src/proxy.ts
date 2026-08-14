import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * 移动端 / Web 端自适应代理（Next.js 16 proxy 约定，替代已废弃的 middleware）
 *
 * 策略：
 * 1. 检测 User-Agent 判断是否移动端设备（覆盖 iPhone / Android / iPad 等主流设备）
 * 2. 优先读取 cookie「x-device」的手动切换值（mobile / desktop）
 * 3. ?device=mobile|desktop 查询参数：设置对应 cookie 并跳转到对应端入口
 * 4. 移动端访问桌面路径 → 302 重定向到 /m 前缀
 * 5. 桌面端访问 /m 路径 → 302 重定向回桌面路径
 *
 * 后端 API（/api/*）与静态资源不经过本代理，两端共用同一套后端。
 */

// 主流移动端设备 UA 关键词（覆盖市场上常见常用的移动端设备）
// 含 iPhone / Android 手机 / iPad / Windows Phone / 黑莓 / webOS / Opera Mini / Kindle 等
const MOBILE_UA =
  /Android|webOS|iPhone|iPod|BlackBerry|IEMobile|Opera Mini|Windows Phone|Mobile|Silk|Kindle|UCWEB|MQQBrowser/i;

function isMobileUA(request: NextRequest): boolean {
  const ua = request.headers.get("user-agent") ?? "";
  if (MOBILE_UA.test(ua)) return true;
  // iPad 在 iOS 13+ 伪装为 Macintosh 桌面 UA，但 UA 字符串仍含 iPad
  if (/iPad/i.test(ua)) return true;
  return false;
}

export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;

  // ?device= 手动切换：设置 cookie 并跳转到对应端入口
  // 用于 Web 端「移动端预览」入口与移动端「切换到桌面版」入口
  const deviceParam = request.nextUrl.searchParams.get("device");
  if (deviceParam === "mobile" || deviceParam === "desktop") {
    const target = deviceParam === "mobile" ? "/m" : "/";
    const url = request.nextUrl.clone();
    url.searchParams.delete("device");
    url.pathname = target;
    const res = NextResponse.redirect(url);
    res.cookies.set("x-device", deviceParam, {
      path: "/",
      maxAge: 60 * 60 * 24 * 365, // 1 年
      sameSite: "lax",
    });
    return res;
  }

  // 设备偏好优先级：cookie 手动切换 > UA 自动检测
  const cookieDevice = request.cookies.get("x-device")?.value;
  const wantMobile =
    cookieDevice === "mobile"
      ? true
      : cookieDevice === "desktop"
        ? false
        : isMobileUA(request);

  const isMobilePath = pathname === "/m" || pathname.startsWith("/m/");

  if (wantMobile && !isMobilePath) {
    // 移动端访问桌面路径 → 重定向到 /m 前缀（保留查询参数）
    const target = "/m" + (pathname === "/" ? "" : pathname) + search;
    return NextResponse.redirect(new URL(target, request.url));
  }

  if (!wantMobile && isMobilePath) {
    // 桌面端访问 /m 路径 → 重定向回桌面路径（保留查询参数）
    const target = (pathname === "/m" ? "/" : pathname.slice(2)) + search;
    return NextResponse.redirect(new URL(target, request.url));
  }

  return NextResponse.next();
}

export const config = {
  // 排除 API 路由、静态资源、图片优化、favicon 等含扩展名的文件
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|.*\\..*).*)"],
};
