"use client";

import { useEffect, useRef, useState } from "react";
import { signIn } from "next-auth/react";
import { useRouter } from "next/navigation";
import { ArrowLeft, Eye, EyeOff, KeyRound, Loader2, Lock, Mail, ShieldCheck } from "lucide-react";
import { SkyLogo } from "@/components/sky-logo";

export default function LoginPage() {
  const router = useRouter();
  const mfaInputRef = useRef<HTMLInputElement>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mfaCode, setMfaCode] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [mfaRequired, setMfaRequired] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (mfaRequired) {
      mfaInputRef.current?.focus();
    }
  }, [mfaRequired]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const result = await signIn("credentials", {
        email,
        password,
        mfaCode,
        redirect: false,
      });

      if (result?.code === "mfa_required") {
        setMfaRequired(true);
        setMfaCode("");
      } else if (result?.code === "mfa_invalid") {
        setMfaRequired(true);
        setError("Invalid verification code");
      } else if (result?.error) {
        setError("Invalid email or password");
      } else {
        const mfaStatus = await fetch("/api/mfa").then((response) =>
          response.ok ? response.json() : null
        );
        router.push(mfaStatus?.enabled ? "/dashboard" : "/settings?mfa=setup");
        router.refresh();
      }
    } catch {
      setError("An error occurred. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  function resetMfaStep() {
    setMfaRequired(false);
    setMfaCode("");
    setPassword("");
    setError("");
  }

  return (
    <div className="relative flex min-h-dvh flex-col items-center justify-start overflow-x-hidden overflow-y-auto px-4 py-6 sm:justify-center sm:py-10"
      style={{ background: 'var(--sky-gradient-surface)' }}
    >
      {/* Animated background effects */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        {/* Top glow */}
        <div className="absolute -top-[30%] left-1/2 -translate-x-1/2 w-[900px] h-[600px] rounded-full opacity-40"
          style={{ background: 'radial-gradient(ellipse, rgba(33, 150, 243, 0.15) 0%, transparent 70%)' }}
        />
        {/* Bottom-right accent */}
        <div className="absolute -bottom-[20%] -right-[10%] w-[500px] h-[500px] rounded-full opacity-20"
          style={{ background: 'radial-gradient(circle, rgba(41, 182, 246, 0.2) 0%, transparent 70%)' }}
        />
        {/* Floating geometric shapes */}
        <div className="absolute top-[15%] left-[10%] w-24 h-24 border border-[var(--sky-border)] rounded-xl rotate-12 opacity-20"
          style={{ animation: 'float1 8s ease-in-out infinite' }}
        />
        <div className="absolute top-[60%] right-[15%] w-16 h-16 border border-[var(--sky-border)] rounded-lg -rotate-12 opacity-15"
          style={{ animation: 'float2 10s ease-in-out infinite' }}
        />
        <div className="absolute top-[30%] right-[8%] w-8 h-8 rounded-full opacity-10"
          style={{ background: 'var(--sky-blue)', animation: 'float3 6s ease-in-out infinite' }}
        />
      </div>

      <style>{`
        @keyframes float1 { 0%, 100% { transform: rotate(12deg) translateY(0px); } 50% { transform: rotate(12deg) translateY(-20px); } }
        @keyframes float2 { 0%, 100% { transform: rotate(-12deg) translateY(0px); } 50% { transform: rotate(-12deg) translateY(-15px); } }
        @keyframes float3 { 0%, 100% { transform: translateY(0px) scale(1); } 50% { transform: translateY(-10px) scale(1.2); } }
      `}</style>

      <div className="relative z-10 flex min-h-[calc(100dvh-3rem)] w-full max-w-md flex-col animate-in sm:min-h-0">
        {/* Branding */}
        <div className="mb-4 text-center sm:mb-6">
          <div className="flex justify-center mb-2">
            <div className="relative">
              <div className="relative p-1 sm:p-2">
                <SkyLogo size={76} light={true} className="drop-shadow-[0_0_15px_rgba(33,150,243,0.3)] sm:hidden" />
                <SkyLogo size={90} light={true} className="hidden drop-shadow-[0_0_15px_rgba(33,150,243,0.3)] sm:block" />
              </div>
            </div>
          </div>
          <p className="text-base font-medium tracking-wide mt-2" style={{ color: 'var(--sky-text-secondary)' }}>
            AI powered IRS Office of Safeguards Compliance
          </p>
        </div>

        {/* Login Card */}
        <div className="glass-strong rounded-2xl p-5 shadow-2xl shadow-black/40 sm:p-8">
          <h2 className="text-lg font-semibold text-white mb-1">
            Welcome back
          </h2>
	          <p className="text-sm mb-6" style={{ color: 'var(--sky-text-muted)' }}>
	            {mfaRequired
                ? "Enter your verification code"
                : "Sign in to access the compliance platform"}
	          </p>

          {error && (
            <div className="mb-5 p-3.5 rounded-xl border text-sm flex items-center gap-2"
              style={{ background: 'rgba(239, 68, 68, 0.1)', borderColor: 'rgba(239, 68, 68, 0.2)', color: '#fca5a5' }}
            >
              <div className="w-5 h-5 rounded-full flex items-center justify-center shrink-0"
                style={{ background: 'rgba(239, 68, 68, 0.15)' }}
              >
                <span className="text-red-400 text-xs">!</span>
              </div>
              {error}
            </div>
          )}

	          <form onSubmit={handleSubmit} className="space-y-5">
	            <div>
              <label
                htmlFor="email"
                className="block text-sm font-medium mb-2"
                style={{ color: 'var(--sky-text-secondary)' }}
              >
                Email address
              </label>
              <div className="relative">
                <Mail className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4" style={{ color: 'var(--sky-text-muted)' }} />
	                <input
	                  id="email"
	                  type="email"
	                  value={email}
	                  onChange={(e) => setEmail(e.target.value)}
	                  required
                    disabled={mfaRequired || loading}
	                  autoComplete="email"
	                  className="w-full rounded-xl py-3 pl-11 pr-4 text-base text-white placeholder-[var(--sky-text-muted)] transition-all duration-200 disabled:cursor-not-allowed disabled:opacity-70 sm:text-sm"
                  style={{
                    background: 'rgba(10, 22, 40, 0.6)',
                    border: '1px solid var(--sky-border)',
                  }}
                  onFocus={(e) => {
                    e.target.style.borderColor = 'var(--sky-blue)';
                    e.target.style.boxShadow = '0 0 0 3px rgba(33, 150, 243, 0.15)';
                  }}
                  onBlur={(e) => {
                    e.target.style.borderColor = 'var(--sky-border)';
                    e.target.style.boxShadow = 'none';
                  }}
                  placeholder="you@agency.gov"
                />
              </div>
            </div>

            <div>
              <label
                htmlFor="password"
                className="block text-sm font-medium mb-2"
                style={{ color: 'var(--sky-text-secondary)' }}
              >
                Password
              </label>
              <div className="relative">
                <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4" style={{ color: 'var(--sky-text-muted)' }} />
	                <input
	                  id="password"
	                  type={showPassword ? "text" : "password"}
	                  value={password}
	                  onChange={(e) => setPassword(e.target.value)}
	                  required
                    disabled={mfaRequired || loading}
	                  autoComplete="current-password"
	                  className="w-full rounded-xl py-3 pl-11 pr-12 text-base text-white placeholder-[var(--sky-text-muted)] transition-all duration-200 disabled:cursor-not-allowed disabled:opacity-70 sm:text-sm"
                  style={{
                    background: 'rgba(10, 22, 40, 0.6)',
                    border: '1px solid var(--sky-border)',
                  }}
                  onFocus={(e) => {
                    e.target.style.borderColor = 'var(--sky-blue)';
                    e.target.style.boxShadow = '0 0 0 3px rgba(33, 150, 243, 0.15)';
                  }}
                  onBlur={(e) => {
                    e.target.style.borderColor = 'var(--sky-border)';
                    e.target.style.boxShadow = 'none';
                  }}
                  placeholder="Enter your password"
                  />
                  <button
                  type="button"
                  onClick={() => setShowPassword((visible) => !visible)}
                  disabled={mfaRequired || loading}
                  className="absolute inset-y-0 right-0 inline-flex min-w-11 items-center justify-center rounded-r-xl text-[var(--sky-text-muted)] transition-colors hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
                  aria-label={showPassword ? "Hide password" : "Show password"}
                  >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                  </div>
	            </div>

              {mfaRequired && (
                <div className="animate-in">
                  <label
                    htmlFor="mfaCode"
                    className="block text-sm font-medium mb-2"
                    style={{ color: 'var(--sky-text-secondary)' }}
                  >
                    Verification code
                  </label>
                  <div className="relative">
                    <KeyRound className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4" style={{ color: 'var(--sky-text-muted)' }} />
                    <input
                      ref={mfaInputRef}
                      id="mfaCode"
                      type="text"
                      value={mfaCode}
                      onChange={(e) => setMfaCode(e.target.value)}
                      required
                      autoComplete="one-time-code"
                      inputMode="text"
                      className="w-full rounded-xl py-3 pl-11 pr-4 text-base text-white placeholder-[var(--sky-text-muted)] transition-all duration-200 sm:text-sm"
                      style={{
                        background: 'rgba(10, 22, 40, 0.6)',
                        border: '1px solid var(--sky-border)',
                      }}
                      onFocus={(e) => {
                        e.target.style.borderColor = 'var(--sky-blue)';
                        e.target.style.boxShadow = '0 0 0 3px rgba(33, 150, 243, 0.15)';
                      }}
                      onBlur={(e) => {
                        e.target.style.borderColor = 'var(--sky-border)';
                        e.target.style.boxShadow = 'none';
                      }}
                      placeholder="123456 or recovery code"
                    />
                  </div>
                </div>
              )}

	            <button
	              type="submit"
	              disabled={loading}
              className="w-full py-3 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold rounded-xl transition-all duration-200 flex items-center justify-center gap-2 active:scale-[0.98] glow-md hover:glow-lg"
              style={{ background: 'var(--sky-gradient-primary)' }}
	            >
	              {loading && <Loader2 className="w-4 h-4 animate-spin" />}
	              {loading
                  ? "Signing in..."
                  : mfaRequired
                    ? "Verify and sign in"
                    : "Sign in"}
	            </button>

              {mfaRequired && (
                <button
                  type="button"
                  onClick={resetMfaStep}
                  className="w-full py-2 text-sm font-medium text-[var(--sky-text-secondary)] hover:text-white transition-colors flex items-center justify-center gap-2"
                >
                  <ArrowLeft className="w-4 h-4" />
                  Use a different account
                </button>
              )}
	          </form>

	          <div className="mt-6 pt-6" style={{ borderTop: '1px solid var(--sky-border)' }}>
	            <div className="flex items-center gap-2 justify-center" style={{ color: 'var(--sky-text-muted)' }}>
	              {mfaRequired ? <ShieldCheck className="w-3 h-3" /> : <Lock className="w-3 h-3" />}
	              <p className="text-sm leading-5">
	                {mfaRequired
                    ? "Multi-factor verification is required for this account."
                    : "Authorized personnel only. All activity is logged and monitored."}
	              </p>
	            </div>
          </div>
        </div>

        {/* Footer */}
        <p className="mt-auto pb-[env(safe-area-inset-bottom)] pt-6 text-center text-sm leading-5" style={{ color: 'var(--sky-text-muted)' }}>
          IRS Office of Safeguards Compliance Platform
        </p>
      </div>
    </div>
  );
}
