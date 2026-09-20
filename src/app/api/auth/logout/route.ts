import { NextResponse } from 'next/server';
import { clearSessionCookie, isSecureRequest } from '@/lib/auth/session';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  await clearSessionCookie({ secure: isSecureRequest(request) });
  return NextResponse.json({ ok: true });
}
