'use client';
import { Action, Dialog } from '@/components/ui';
import { SignInForm } from '../../../v2-public/page.client';
import '../../../v2-public/public.css';
import './start.css';

export default function SessionExpiredDialog({
  password,
  onPassword,
  onDone,
}: {
  password: boolean;
  onPassword: () => void;
  onDone: () => void;
}) {
  return (
    <Dialog open title="Sign in again" onClose={() => {}}>
      <p className="dl-soft">
        This browser was signed out after 30 days. After you sign in, you come back to this task.
      </p>
      <SignInForm key={String(password)} passwordFirst={password} onDone={onDone} />
      <Action variant="quiet" onClick={onPassword}>
        Use a password
      </Action>
    </Dialog>
  );
}
