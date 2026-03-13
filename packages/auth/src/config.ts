import { PrismaAdapter } from "@auth/prisma-adapter";
import { prisma } from "@postautomation/db";
import type { NextAuthConfig } from "next-auth";
import GoogleProvider from "next-auth/providers/google";
import GitHubProvider from "next-auth/providers/github";
import CredentialsProvider from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";

export const authConfig: NextAuthConfig = {
  adapter: PrismaAdapter(prisma),
  providers: [
    GoogleProvider({
      clientId: process.env.AUTH_GOOGLE_ID!,
      clientSecret: process.env.AUTH_GOOGLE_SECRET!,
    }),
    GitHubProvider({
      clientId: process.env.AUTH_GITHUB_ID!,
      clientSecret: process.env.AUTH_GITHUB_SECRET!,
    }),
    CredentialsProvider({
      name: "credentials",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        console.log("[admin-auth] authorize called with email:", credentials?.email);
        if (!credentials?.email || !credentials?.password) {
          console.log("[admin-auth] missing email or password");
          return null;
        }

        const user = await prisma.user.findUnique({
          where: { email: credentials.email as string },
          select: {
            id: true,
            email: true,
            name: true,
            image: true,
            password: true,
            isSuperAdmin: true,
            isBanned: true,
            deletedAt: true,
          },
        });

        console.log("[admin-auth] user found:", !!user, "has password:", !!user?.password);

        if (!user?.password) return null;

        const isValid = await bcrypt.compare(
          credentials.password as string,
          user.password
        );

        console.log("[admin-auth] password valid:", isValid);

        if (!isValid) return null;

        if (user.isBanned) throw new Error("Account suspended");
        if (user.deletedAt) throw new Error("Account no longer exists");

        return {
          id: user.id,
          email: user.email,
          name: user.name,
          image: user.image,
          isSuperAdmin: user.isSuperAdmin,
          isBanned: user.isBanned,
        } as any;
      },
    }),
  ],
  session: {
    strategy: "jwt",
    maxAge: 30 * 24 * 60 * 60, // 30 days
  },
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.id = user.id;
        token.isSuperAdmin = (user as any).isSuperAdmin ?? false;
        token.isBanned = (user as any).isBanned ?? false;
      }

      // Re-check from DB on every token refresh
      const dbUser = await prisma.user.findUnique({
        where: { id: token.id as string },
        select: { isBanned: true, isSuperAdmin: true },
      });
      if (dbUser) {
        token.isSuperAdmin = dbUser.isSuperAdmin;
        token.isBanned = dbUser.isBanned;
      }

      return token;
    },
    async session({ session, token }) {
      if (token && session.user) {
        session.user.id = token.id as string;
        (session.user as any).isSuperAdmin = token.isSuperAdmin ?? false;
        (session.user as any).isBanned = token.isBanned ?? false;
      }
      return session;
    },
  },
  pages: {
    signIn: "/login",
    newUser: "/register",
  },
};
