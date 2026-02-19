import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  serverExternalPackages: ["xlsx", "bcryptjs"],
};

export default nextConfig;
