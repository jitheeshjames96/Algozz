import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: 'http://65.2.55.114:8000/api/:path*',
      },
    ];
  },
};

export default nextConfig;
