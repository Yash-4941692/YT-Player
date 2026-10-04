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
            <p>To keep login secure and enable syncing, connect a free Supabase project. This site still works now in guest mode, with your watch list saved in this browser.</p>
            <ol>
              <li>Create a Supabase project and run <code>supabase/schema.sql</code>.</li>
              <li>Add <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_ANON_KEY</code> in Vercel.</li>
              <li>Redeploy, then create your account here.</li>
            </ol>
            <a href="https://supabase.com/dashboard" target="_blank" rel="noreferrer">Open Supabase <ArrowUpRight size={14} /></a>
          </div>
        ) : (
          <>
            <div className="auth-switch" role="tablist" aria-label="Account action">
              <button className={mode === 'signin' ? 'selected' : ''} onClick={() => { setMode('signin'); setError(''); setMessage(''); }}>Sign in</button>
              <button className={mode === 'signup' ? 'selected' : ''} onClick={() => { setMode('signup'); setError(''); setMessage(''); }}>Create account</button>
            </div>
            <form className="auth-form" onSubmit={handleSubmit}>
              <label>Email address<input type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} required placeholder="you@example.com" /></label>
              <label>Password<input type="password" autoComplete={mode === 'signin' ? 'current-password' : 'new-password'} value={password} onChange={(event) => setPassword(event.target.value)} required minLength={6} placeholder="At least 6 characters" /></label>
              {error && <p className="form-message error-message">{error}</p>}
              {message && <p className="form-message success-message">{message}</p>}
              <button className="button-primary auth-submit" type="submit" disabled={busy}>
                {busy ? 'Please wait…' : mode === 'signin' ? 'Sign in to Focusframe' : 'Create free account'}
              </button>
              <p className="auth-security"><LockKeyhole size={13} /> Your account is managed securely by Supabase Auth.</p>
            </form>
          </>
        )}
      </section>
    </div>
  );
}
