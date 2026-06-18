import type { Config } from "drizzle-kit";

export default {
  dialect: "postgresql",
  schema: "./lib/db/schema.ts",
  out: "./drizzle",
  casing: "snake_case",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://localhost:5432/eat",
  },
} satisfies Config;
