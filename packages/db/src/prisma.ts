/** Típusos Prisma kliens (a séma a sql/*.sql-ből, `prisma db pull`-lal). Ugyanazt a pool-t használja. */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/client.ts";
import { getPool } from "./index.ts";

export { Prisma } from "./generated/client.ts";
export type { PrismaClient } from "./generated/client.ts";

let prisma: PrismaClient | null = null;

export function getPrisma(): PrismaClient {
  if (!prisma) prisma = new PrismaClient({ adapter: new PrismaPg(getPool()) });
  return prisma;
}
