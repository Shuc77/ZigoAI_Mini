import { redirect } from 'next/navigation';
import { readSession } from '@/lib/auth/session';

export default async function HomePage() {
  const ctx = await readSession();
  redirect(ctx ? '/customers' : '/login');
}
