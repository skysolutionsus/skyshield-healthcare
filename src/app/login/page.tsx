"use client";

import { useState } from "react";
import { signIn } from "next-auth/react";
import { useRouter } from "next/navigation";
import { Loader2, Lock, Mail } from "lucide-react";
import { SkyLogo } from "@/components/sky-logo";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const result = await signIn("credentials", {
        email,
        password,
        redirect: false,
      });

      if (result?.error) {
        setError("Invalid email or password");
      } else {
        router.push("/dashboard");
        router.refresh();
      }
    } catch {
      setError("An error occurred. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-4 relative overflow-hidden"
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

      <div className="w-full max-w-md relative z-10 animate-in">
        {/* Branding */}
        <div className="text-center mb-10">
          <div className="flex justify-center mb-6">
            <div className="relative">
              {/* Subtle Ambient glow behind logo */}
              <div className="absolute inset-0 rounded-3xl blur-xl opacity-20"
                style={{ background: 'radial-gradient(circle, rgba(33, 150, 243, 0.4) 0%, transparent 70%)', transform: 'scale(1.2)' }}
              />
              <div className="relative p-2">
                <SkyLogo size={240} className="drop-shadow-[0_0_15px_rgba(33,150,243,0.2)]" />
              </div>
            </div>
          </div>
          <p className="text-base font-medium tracking-wide" style={{ color: 'var(--sky-text-secondary)' }}>
            AI-Powered Publication 1075 Compliance
          </p>
        </div>

        {/* Login Card */}
        <div className="glass-strong rounded-2xl p-8 shadow-2xl shadow-black/40">
          <h2 className="text-lg font-semibold text-white mb-1">
            Welcome back
          </h2>
          <p className="text-sm mb-6" style={{ color: 'var(--sky-text-muted)' }}>
            Sign in to access the compliance platform
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
                  autoComplete="email"
                  className="w-full pl-11 pr-4 py-3 rounded-xl text-white placeholder-[var(--sky-text-muted)] text-sm transition-all duration-200"
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
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  autoComplete="current-password"
                  className="w-full pl-11 pr-4 py-3 rounded-xl text-white placeholder-[var(--sky-text-muted)] text-sm transition-all duration-200"
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
              </div>
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full py-3 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold rounded-xl transition-all duration-200 flex items-center justify-center gap-2 active:scale-[0.98] glow-md hover:glow-lg"
              style={{ background: 'var(--sky-gradient-primary)' }}
            >
              {loading && <Loader2 className="w-4 h-4 animate-spin" />}
              {loading ? "Signing in..." : "Sign in"}
            </button>
          </form>

          <div className="mt-6 pt-6" style={{ borderTop: '1px solid var(--sky-border)' }}>
            <div className="flex items-center gap-2 justify-center" style={{ color: 'var(--sky-text-muted)' }}>
              <Lock className="w-3 h-3" />
              <p className="text-xs">
                Authorized personnel only. All activity is logged and monitored.
              </p>
            </div>
          </div>
        </div>

        {/* Footer */}
        <p className="text-center text-xs mt-6" style={{ color: 'var(--sky-text-muted)' }}>
          IRS Publication 1075 Compliance Platform
        </p>
      </div>
    </div>
  );
}
