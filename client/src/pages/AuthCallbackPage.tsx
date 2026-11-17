import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Loader2, AlertCircle, CheckCircle2 } from 'lucide-react';
import { useAuth, type AuthUser } from '../hooks/useAuth';
import { useSetupStatus } from '../hooks/useSetupStatus';

type Mode = 'login' | 'drive';

type Outcome =
  | { kind: 'error'; message: string }
  | { kind: 'login'; token: string; user: AuthUser }
  | { kind: 'drive' };

/**
 * Work out the result from the callback URL once, at mount. The server puts the
 * session token in the fragment so it never reaches server logs or Referer headers;
 * the effect below then drops it from the address bar and history.
 */
function parseCallback(mode: Mode, searchParams: URLSearchParams): Outcome {
  const errorParam = searchParams.get('error');
  if (errorParam) return { kind: 'error', message: errorParam };

  if (mode === 'drive') {
    return searchParams.get('success') === '1'
      ? { kind: 'drive' }
      : { kind: 'error', message: 'Autorizzazione Google Drive non riuscita.' };
  }

  const fragment = new URLSearchParams(window.location.hash.slice(1));
  const token = fragment.get('token');
  const userRaw = fragment.get('user');
  if (!token || !userRaw) return { kind: 'error', message: 'Risposta di autenticazione non valida.' };
  try {
    return { kind: 'login', token, user: JSON.parse(userRaw) as AuthUser };
  } catch {
    return { kind: 'error', message: 'Impossibile elaborare la risposta di autenticazione.' };
  }
}

const AuthCallbackPage = ({ mode }: { mode: Mode }) => {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { login } = useAuth();
  const { deploymentMode } = useSetupStatus();
  // Lazy initial state: StrictMode re-runs effects, and the fragment is gone by then.
  const [outcome] = useState(() => parseCallback(mode, searchParams));
  const error = outcome.kind === 'error' ? outcome.message : null;
  const success = outcome.kind === 'drive';

  useEffect(() => {
    if (window.location.hash) {
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
    }

    if (outcome.kind === 'login') {
      login(outcome.token, outcome.user);
      navigate('/', { replace: true });
    } else if (outcome.kind === 'drive') {
      const timer = setTimeout(() => navigate('/documents', { replace: true }), 1500);
      return () => clearTimeout(timer);
    }
    // Runs once per mount: login() and navigate() are not stable references.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outcome]);

  return (
    <div className="min-h-screen bg-slate-950 flex items-center justify-center p-4">
      <div className="bg-slate-900 border border-slate-800 rounded-3xl p-10 shadow-2xl flex flex-col items-center gap-5 max-w-sm w-full">
        {!error && !success && (
          <>
            <Loader2 size={36} className="text-blue-400 animate-spin" />
            <p className="text-slate-300 font-medium">
              {mode === 'login' ? 'Accesso in corso…' : 'Autorizzazione Google Drive…'}
            </p>
          </>
        )}

        {success && (
          <>
            <CheckCircle2 size={36} className="text-emerald-400" />
            <p className="text-slate-200 font-semibold text-center">Google Drive collegato.</p>
            <p className="text-slate-500 text-sm">Redirect in corso…</p>
          </>
        )}

        {error && (
          <>
            <AlertCircle size={36} className="text-red-400" />
            <p className="text-slate-200 font-semibold text-center">Errore di autenticazione</p>
            <p className="text-sm text-red-300 text-center">{error}</p>
            <div className="mt-4 flex flex-col gap-2 w-full">
              <button
                onClick={() => navigate(mode === 'login' ? '/' : '/documents', { replace: true })}
                className="px-5 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-sm font-medium transition-all"
              >
                Torna {mode === 'login' ? 'al login' : 'ai documenti'}
              </button>
              {mode === 'login' && deploymentMode !== 'single_org' && deploymentMode !== 'closed' && (
                <button
                  onClick={() => navigate('/signup', { replace: true })}
                  className="px-5 py-2.5 rounded-xl bg-blue-700 hover:bg-blue-600 text-white text-sm font-medium transition-all"
                >
                  Crea un'organizzazione
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
};

export default AuthCallbackPage;
