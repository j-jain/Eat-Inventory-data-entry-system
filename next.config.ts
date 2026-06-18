import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // PGlite ships WASM + a .data file that must be required from node_modules at
  // runtime (bundling it breaks its file-URL resolution). Neon/ws are native-ish
  // too — keep them external on the server.
  serverExternalPackages: ["@electric-sql/pglite", "@neondatabase/serverless", "ws"],
};

export default nextConfig;
