import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { deleteSession, SESSION_COOKIE } from "@/lib/auth";

export async function POST() {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  deleteSession(token);
  // Domain (when set) must match the cookie's set attributes, or the
  // browser keeps the .steerosai.com cookie and SSO "logs back in".
  jar.delete({
    name: SESSION_COOKIE,
    path: "/",
    ...(process.env.AUTH_COOKIE_DOMAIN ? { domain: process.env.AUTH_COOKIE_DOMAIN } : {}),
  });
  return NextResponse.json({ ok: true });
}
