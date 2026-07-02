import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  // Pin the workspace root to this project (a stray lockfile in the home dir
  // otherwise makes Next infer the wrong root → slower/incorrect file tracing).
  turbopack: { root: path.resolve(process.cwd()) },
  outputFileTracingRoot: path.resolve(process.cwd()),
  // PGlite ships WASM + a .data file that must be required from node_modules at
  // runtime (bundling it breaks its file-URL resolution). Neon/ws are native-ish
  // too — keep them external on the server.
  serverExternalPackages: ["@electric-sql/pglite", "pg"],
};

export default nextConfig;
