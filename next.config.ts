import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // pg 是 CJS 驱动，PrismaPg adapter 依赖它，需在服务端保持外部依赖
  serverExternalPackages: ["pg", "@prisma/adapter-pg"],
};

export default nextConfig;
