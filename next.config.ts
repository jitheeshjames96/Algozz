import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: 'http://3.108.226.70:8000/api/:path*',
      },
    ];
  },
};

export default nextConfig;
