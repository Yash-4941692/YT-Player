import { useState, type FormEvent } from 'react';
import { ArrowUpRight, Cloud, LockKeyhole, X } from 'lucide-react';
import { cloudConfigured, supabase } from '../lib/supabase';

interface Props {
  open: boolean;
  onClose: () => void;
}

export function AuthModal({ open, onClose }: Props) {
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  if (!open) return null;

  async function continueWithGoogle() {
    if (!supabase) return;
    setBusy(true);
    setMessage('');
    setError('');
    try {
      const { error: oauthError } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: {
          redirectTo: window.location.origin,
          queryParams: { prompt: 'select_account' },
        },
      });
      if (oauthError) throw oauthError;
      // Supabase redirects to Google's account chooser and back to this page.
    } catch (authError) {
      setError(authError instanceof Error ? authError.message : 'Could not start Google sign-in. Please try again.');
      setBusy(false);
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase) return;
    setBusy(true);
    setMessage('');
    setError('');
    try {
      if (mode === 'signin') {
        const { error: authError } = await supabase.auth.signInWithPassword({ email, password });
        if (authError) throw authError;
        setMessage('You are signed in. Your study library is syncing.');
        window.setTimeout(onClose, 700);
      } else {
        const { data, error: authError } = await supabase.auth.signUp({
          email,
          password,
          options: { emailRedirectTo: window.location.origin },
        });
        if (authError) throw authError;
        setMessage(data.session
          ? 'Account created. Your study library is ready to sync.'
          : 'Account created. Check your email to confirm your address, then sign in.');
      }
    } catch (authError) {
      setError(authError instanceof Error ? authError.message : 'Could not authenticate. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="auth-modal glass-card" role="dialog" aria-modal="true" aria-labelledby="auth-title">
        <button className="icon-button modal-close" onClick={onClose} aria-label="Close sign in"><X size={18} /></button>
        <div className="modal-symbol"><Cloud size={23} /></div>
        <p className="eyebrow">YOUR STUDY, EVERYWHERE</p>
        <h2 id="auth-title">Sync your study space</h2>
        <p className="modal-copy">Keep chapters, watch progress, focus goals, and private PDF notes with your account across devices.</p>

        {!cloudConfigured ? (
          <div className="cloud-setup-note">
            <div className="setup-note-heading"><LockKeyhole size={17} /><strong>One-time cloud setup needed</strong></div>
            <p>Guest mode works right now. To turn on one-click Google sign-in and cross-device sync, the site owner connects Supabase and Google once; users can then choose their Google account and are signed up automatically on first login.</p>
            <ol>
              <li>Create a Supabase project and run <code>supabase/schema.sql</code>.</li>
              <li>Enable Google under Supabase Authentication providers.</li>
              <li>Add the Supabase URL and publishable key in Vercel, then redeploy.</li>
            </ol>
            <a href="https://github.com/Yash-4941692/YT-Player/blob/main/README.md#optional-one-click-google-sign-in-and-cloud-sync" target="_blank" rel="noreferrer">Open the step-by-step setup guide <ArrowUpRight size={14} /></a>
          </div>
        ) : (
          <>
            <button className="google-signin-button" onClick={() => void continueWithGoogle()} disabled={busy}>
              <GoogleMark />
              <span>{busy ? 'Connecting to Google…' : 'Continue with Google'}</span>
              <ArrowUpRight size={14} className="google-arrow" />
            </button>
            <p className="google-signup-hint">New here? Your account is created automatically the first time.</p>
            <div className="auth-divider"><span>OR USE EMAIL</span></div>
            <div className="auth-switch" role="tablist" aria-label="Email account action">
              <button className={mode === 'signin' ? 'selected' : ''} onClick={() => { setMode('signin'); setError(''); setMessage(''); }}>Sign in</button>
              <button className={mode === 'signup' ? 'selected' : ''} onClick={() => { setMode('signup'); setError(''); setMessage(''); }}>Create account</button>
            </div>
            <form className="auth-form" onSubmit={handleSubmit}>
              <label>Email address<input type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} required placeholder="you@example.com" /></label>
              <label>Password<input type="password" autoComplete={mode === 'signin' ? 'current-password' : 'new-password'} value={password} onChange={(event) => setPassword(event.target.value)} required minLength={6} placeholder="At least 6 characters" /></label>
              {error && <p className="form-message error-message">{error}</p>}
              {message && <p className="form-message success-message">{message}</p>}
              <button className="button-primary auth-submit" type="submit" disabled={busy}>
                {busy ? 'Please wait…' : mode === 'signin' ? 'Sign in with email' : 'Create email account'}
              </button>
              <p className="auth-security"><LockKeyhole size={13} /> Your account is managed securely by Supabase Auth.</p>
            </form>
          </>
        )}
      </section>
    </div>
  );
}

function GoogleMark() {
  return (
    <svg className="google-mark" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5Z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.76 7.18l7.73 6C44.42 37.95 46.98 31.78 46.98 24.55Z" />
      <path fill="#FBBC05" d="M10.53 28.59a14.4 14.4 0 0 1 0-9.18l-7.98-6.19a23.9 23.9 0 0 0 0 21.56l7.98-6.19Z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.9-5.8l-7.73-6c-2.14 1.45-4.88 2.3-8.17 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48Z" />
    </svg>
  );
}
