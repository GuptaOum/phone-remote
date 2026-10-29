import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { Smartphone, Lock, Mail, ArrowRight } from 'lucide-react';

export function LoginPage() {
  const [isRegister, setIsRegister] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const { login, register } = useAuth();
  const navigate = useNavigate();

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      if (isRegister) {
        await register(email, password);
      } else {
        await login(email, password);
      }
      navigate('/dashboard');
    } catch (err) {
      setError(err.message || 'Authentication failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-wrapper">
      <div className="login-card">
        <div className="brand-badge">
          <Smartphone size={28} className="badge-icon" />
        </div>
        <h1 className="login-title">{isRegister ? 'Create an Account' : 'Welcome Back'}</h1>
        <p className="login-subtitle">
          {isRegister
            ? 'Sign up to connect and control your Android devices'
            : 'Sign in to access your remote Android phones'}
        </p>

        {error && <div className="login-error">{error}</div>}

        <form onSubmit={handleSubmit} className="login-form">
          <div className="form-group">
            <label htmlFor="email">Email Address</label>
            <div className="input-with-icon">
              <Mail size={16} className="field-icon" />
              <input
                id="email"
                type="email"
                className="input"
                placeholder="name@example.com"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
          </div>

          <div className="form-group">
            <label htmlFor="password">Password</label>
            <div className="input-with-icon">
              <Lock size={16} className="field-icon" />
              <input
                id="password"
                type="password"
                className="input"
                placeholder="••••••••"
                required
                minLength={6}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
          </div>

          <button type="submit" className="btn primary login-submit" disabled={loading}>
            <span>{loading ? 'Please wait...' : isRegister ? 'Create Account' : 'Sign In'}</span>
            <ArrowRight size={16} />
          </button>
        </form>

        <div className="login-toggle">
          <span>{isRegister ? 'Already have an account?' : "Don't have an account?"}</span>
          <button
            type="button"
            className="toggle-btn"
            onClick={() => {
              setIsRegister(!isRegister);
              setError('');
            }}
          >
            {isRegister ? 'Sign in' : 'Create one'}
          </button>
        </div>
      </div>

      <style>{`
        .login-wrapper {
          min-height: 100vh;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 24px;
          background: radial-gradient(circle at top, var(--bg2) 0%, var(--bg) 100%);
        }
        .login-card {
          width: 100%;
          max-width: 400px;
          background: var(--bg2);
          border: 1px solid var(--border);
          border-radius: 16px;
          padding: 36px 30px;
          box-shadow: 0 20px 40px rgba(0, 0, 0, 0.4);
          text-align: center;
        }
        .brand-badge {
          width: 52px;
          height: 52px;
          border-radius: 14px;
          background: var(--bg3);
          border: 1px solid var(--border);
          display: inline-flex;
          align-items: center;
          justify-content: center;
          color: var(--accent);
          margin-bottom: 16px;
        }
        .login-title {
          font-size: 22px;
          font-weight: 700;
          color: #fff;
          margin-bottom: 6px;
        }
        .login-subtitle {
          color: var(--muted);
          font-size: 13px;
          margin-bottom: 24px;
          line-height: 1.5;
        }
        .login-error {
          background: rgba(239, 68, 68, 0.15);
          border: 1px solid rgba(239, 68, 68, 0.3);
          color: #fca5a5;
          padding: 10px 14px;
          border-radius: 8px;
          font-size: 13px;
          margin-bottom: 20px;
          text-align: left;
        }
        .login-form {
          display: flex;
          flex-direction: column;
          gap: 16px;
          text-align: left;
        }
        .form-group label {
          display: block;
          font-size: 12px;
          font-weight: 600;
          color: var(--text);
          margin-bottom: 6px;
        }
        .input-with-icon {
          position: relative;
          display: flex;
          align-items: center;
        }
        .field-icon {
          position: absolute;
          left: 12px;
          color: var(--muted);
          pointer-events: none;
        }
        .input-with-icon .input {
          padding-left: 36px;
        }
        .login-submit {
          width: 100%;
          padding: 11px;
          font-size: 14px;
          margin-top: 8px;
        }
        .login-toggle {
          margin-top: 24px;
          padding-top: 20px;
          border-top: 1px solid var(--border);
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 8px;
          font-size: 13px;
          color: var(--muted);
        }
        .toggle-btn {
          background: none;
          border: none;
          color: var(--accent);
          font-weight: 600;
          cursor: pointer;
        }
        .toggle-btn:hover {
          text-decoration: underline;
        }
      `}</style>
    </div>
  );
}

export default LoginPage;
