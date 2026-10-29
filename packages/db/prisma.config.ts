import { defineConfig } from "prisma/config";

// A kliens generálásához nem kell élő adatbázis — URL nélkül is fusson (`bun run build`).
// A `prisma db pull` / `migrate` parancsokhoz a valódi DATABASE_URL kell.
export default defineConfig({
  schema: "prisma/schema.prisma",
  datasource: { url: process.env.DATABASE_URL ?? "postgres://placeholder@localhost:5432/placeholder" },
});
