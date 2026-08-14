import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // pg 是 CJS 驱动，PrismaPg adapter 依赖它，需在服务端保持外部依赖
  serverExternalPackages: ["pg", "@prisma/adapter-pg"],
  // 隐藏开发模式左下角的 Next.js 状态指示器（N 气泡：Rendering/Compiling 等）。
  // 仅影响 dev 模式，编译/运行错误仍会正常浮层提示；生产构建不受影响。
  devIndicators: false,
};

export default nextConfig;
