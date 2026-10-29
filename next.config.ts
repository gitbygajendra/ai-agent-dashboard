import type { NextConfig } from "next";

// Every dashboard page is per-user and per-organization, so pages render
// dynamically on each request. Cache Components stays off to keep the data
// layer simple: there is no shared, cacheable content in this app.
const nextConfig: NextConfig = {
  cacheComponents: false,
  serverExternalPackages: ["pg", "exceljs"],
  poweredByHeader: false,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
};

export default nextConfig;
