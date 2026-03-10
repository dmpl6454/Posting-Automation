import NextAuth from "next-auth";
import { authConfig } from "@postautomation/auth";

// NextAuth v5 monorepo workaround: type portability requires explicit annotations
// See: https://github.com/nextauthjs/next-auth/issues/9493
const nextAuth = NextAuth(authConfig);

export const handlers: typeof nextAuth.handlers = nextAuth.handlers;
export const auth: typeof nextAuth.auth = nextAuth.auth;
export const signIn: typeof nextAuth.signIn = nextAuth.signIn;
export const signOut: typeof nextAuth.signOut = nextAuth.signOut;
