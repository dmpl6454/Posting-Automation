import { PrismaClient } from "@prisma/client";
import { encryptToken, decryptToken } from "./crypto";

export { encryptToken, decryptToken, isEncrypted } from "./crypto";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

const basePrisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log:
      process.env.NODE_ENV === "development"
        ? ["query", "error", "warn"]
        : ["error"],
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = basePrisma;

// ─────────────────────────────────────────────────────────────────────
// Channel token transparent encryption
// ─────────────────────────────────────────────────────────────────────
//
// Channel.accessToken and Channel.refreshToken are encrypted at rest with
// AES-256-GCM. The encrypt/decrypt helpers in @postautomation/social are
// idempotent and backward-compatible — they return legacy plaintext rows
// untouched if they don't have the `enc:v1:` prefix, which means existing
// data keeps working until a migration script encrypts old rows.
//
// We use Prisma's `$extends` API so every read decrypts and every write
// encrypts. Call sites continue to use `channel.accessToken` as if it were
// plaintext — they no longer need individual updates.

function encryptChannelData<T extends Record<string, any> | undefined>(data: T): T {
  if (!data) return data;
  const out: any = { ...data };
  if (typeof out.accessToken === "string") {
    out.accessToken = encryptToken(out.accessToken);
  }
  if (typeof out.refreshToken === "string") {
    out.refreshToken = encryptToken(out.refreshToken);
  }
  return out as T;
}

function decryptChannelRow<T extends Record<string, any> | null>(row: T): T {
  if (!row) return row;
  const out: any = row;
  if (typeof out.accessToken === "string") {
    try {
      out.accessToken = decryptToken(out.accessToken);
    } catch {
      /* leave as-is */
    }
  }
  if (typeof out.refreshToken === "string") {
    try {
      out.refreshToken = decryptToken(out.refreshToken);
    } catch {
      /* leave as-is */
    }
  }
  return out as T;
}

function decryptChannelRows<T>(rows: T): T {
  if (Array.isArray(rows)) {
    return rows.map((r) => decryptChannelRow(r as any)) as any;
  }
  return decryptChannelRow(rows as any);
}

export const prisma = basePrisma.$extends({
  query: {
    channel: {
      async create({ args, query }) {
        if (args.data) args.data = encryptChannelData(args.data as any) as any;
        const result = await query(args);
        return decryptChannelRow(result as any);
      },
      async update({ args, query }) {
        if (args.data) args.data = encryptChannelData(args.data as any) as any;
        const result = await query(args);
        return decryptChannelRow(result as any);
      },
      async upsert({ args, query }) {
        if (args.create) args.create = encryptChannelData(args.create as any) as any;
        if (args.update) args.update = encryptChannelData(args.update as any) as any;
        const result = await query(args);
        return decryptChannelRow(result as any);
      },
      async createMany({ args, query }) {
        if (Array.isArray(args.data)) {
          args.data = args.data.map((d: any) => encryptChannelData(d));
        } else if (args.data) {
          args.data = encryptChannelData(args.data as any) as any;
        }
        return query(args);
      },
      async updateMany({ args, query }) {
        if (args.data) args.data = encryptChannelData(args.data as any) as any;
        return query(args);
      },
      async findUnique({ args, query }) {
        const result = await query(args);
        return decryptChannelRow(result as any);
      },
      async findUniqueOrThrow({ args, query }) {
        const result = await query(args);
        return decryptChannelRow(result as any);
      },
      async findFirst({ args, query }) {
        const result = await query(args);
        return decryptChannelRow(result as any);
      },
      async findFirstOrThrow({ args, query }) {
        const result = await query(args);
        return decryptChannelRow(result as any);
      },
      async findMany({ args, query }) {
        const result = await query(args);
        return decryptChannelRows(result as any);
      },
    },
  },
}) as unknown as PrismaClient;

export * from "@prisma/client";
export type { PrismaClient } from "@prisma/client";
