import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { deleteSession, SESSION_COOKIE } from "@/lib/auth";

export async function POST() {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  deleteSession(token);
  jar.delete(SESSION_COOKIE);
  return NextResponse.json({ ok: true });
}
