"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowRight,
  CheckCircle2,
  KeyRound,
  Loader2,
  Lock,
  Mail,
  ShieldCheck,
  UserRound,
} from "lucide-react";
import { SkyLogo } from "@/components/sky-logo";
import { strongPasswordValidationError } from "@/lib/password-policy";

const inputClassName =
  "w-full rounded-xl border border-[var(--sky-border)] bg-[rgba(10,22,40,0.72)] py-3 pl-11 pr-4 text-sm text-white placeholder:text-[var(--sky-text-muted)] transition focus:border-[var(--sky-blue)] focus:outline-none focus:ring-4 focus:ring-sky-500/10 disabled:cursor-not-allowed disabled:opacity-60";

export function RegistrationForm() {
  const router = useRouter();
  const [inviteToken, setInviteToken] = useState("");
  const [tokenReady, setTokenReady] = useState(false);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [passwordConfirmation, setPasswordConfirmation] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const hash = new URLSearchParams(window.location.hash.slice(1));
    setInviteToken(hash.get("token")?.trim() || "");
    setTokenReady(true);

    // Keep the bearer token out of browser history, screenshots of the address
    // bar, and any later same-page navigation after it has been captured in memory.
    if (window.location.hash) {
      window.history.replaceState(null, "", "/register");
    }
  }, []);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");

    if (!inviteToken) {
      setError("This invitation link is incomplete or no longer available.");
      return;
    }
    if (password !== passwordConfirmation) {
      setError("Passwords do not match.");
      return;
    }
    const passwordError = strongPasswordValidationError(password);
    if (passwordError) {
      setError(passwordError);
      return;
    }

    setLoading(true);
    try {
      const response = await fetch("/api/register", {
        method: "POST",
        credentials: "omit",
        cache: "no-store",
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        },
        body: JSON.stringify({
          inviteToken,
          email,
          name,
          password,
        }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(data?.error || "Unable to create the account.");
      }

      // Remove secrets from component state before leaving the public form.
      setInviteToken("");
      setPassword("");
      setPasswordConfirmation("");
      router.replace("/login");
    } catch (registrationError) {
      setError(
        registrationError instanceof Error
          ? registrationError.message
          : "Unable to create the account."
      );
    } finally {
      setLoading(false);
    }
  }

  const tokenMissing = tokenReady && !inviteToken;

  return (
    <main
      className="relative min-h-dvh overflow-x-hidden overflow-y-auto bg-[var(--sky-navy)] px-4 py-6 sm:px-6 sm:py-10 lg:flex lg:items-center lg:py-16"
      style={{ background: "var(--sky-gradient-surface)" }}
    >
      <div className="pointer-events-none absolute inset-0" aria-hidden="true">
        <div className="absolute left-1/2 top-[-24rem] h-[44rem] w-[56rem] -translate-x-1/2 rounded-full bg-sky-400/[0.12] blur-3xl" />
        <div className="absolute bottom-[-18rem] right-[-12rem] h-[34rem] w-[34rem] rounded-full bg-cyan-300/[0.08] blur-3xl" />
        <div className="absolute inset-y-0 left-[8%] w-px bg-gradient-to-b from-transparent via-sky-300/10 to-transparent" />
        <div className="absolute inset-y-0 right-[8%] w-px bg-gradient-to-b from-transparent via-sky-300/10 to-transparent" />
      </div>

      <div className="relative z-10 mx-auto grid w-full max-w-5xl overflow-hidden rounded-3xl border border-[var(--sky-border-bright)] bg-[rgba(8,20,36,0.82)] shadow-2xl shadow-black/40 backdrop-blur-2xl lg:grid-cols-[0.82fr_1.18fr]">
        <section className="relative overflow-hidden border-b border-[var(--sky-border)] p-7 sm:p-10 lg:border-b-0 lg:border-r">
          <div className="absolute -left-24 -top-24 h-56 w-56 rounded-full border border-sky-300/10" />
          <div className="absolute -left-12 -top-12 h-56 w-56 rounded-full border border-sky-300/[0.06]" />

          <div className="relative">
            <SkyLogo
              size={82}
              light
              className="drop-shadow-[0_0_18px_rgba(33,150,243,0.28)]"
            />
            <div className="mt-10 inline-flex items-center gap-2 rounded-full border border-sky-300/15 bg-sky-300/[0.06] px-3 py-1.5 text-xs font-medium tracking-wide text-sky-200">
              <ShieldCheck className="h-3.5 w-3.5" />
              Invitation-gated access
            </div>
            <h1 className="mt-5 text-3xl font-semibold leading-tight text-white sm:text-4xl">
              Join the SCSEM stewardship workspace.
            </h1>
            <p className="mt-4 max-w-sm text-sm leading-6 text-[var(--sky-text-secondary)]">
              Create your individual SkyShield account using the exact email
              address your administrator approved. Multi-factor enrollment is
              required when you first sign in.
            </p>

            <div className="mt-9 space-y-4 text-sm text-[var(--sky-text-secondary)]">
              {[
                "The invitation can be redeemed only once.",
                "Your password is sent only to this SkyShield instance.",
                "Account creation and its audit record are committed together.",
              ].map((item) => (
                <div key={item} className="flex items-start gap-3">
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-sky-300" />
                  <span>{item}</span>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="p-7 sm:p-10">
          <div className="mx-auto max-w-md">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-sky-300">
              Account registration
            </p>
            <h2 className="mt-2 text-2xl font-semibold text-white">
              Confirm your identity
            </h2>
            <p className="mt-2 text-sm leading-6 text-[var(--sky-text-muted)]">
              Enter the invited email exactly. The link does not reveal which
              address or role was approved.
            </p>

            {!tokenReady ? (
              <div className="mt-10 flex items-center justify-center gap-2 py-16 text-sm text-[var(--sky-text-secondary)]">
                <Loader2 className="h-4 w-4 animate-spin" />
                Reading invitation…
              </div>
            ) : tokenMissing ? (
              <div className="mt-8 rounded-2xl border border-amber-400/20 bg-amber-400/[0.07] p-5">
                <div className="flex items-start gap-3">
                  <KeyRound className="mt-0.5 h-5 w-5 shrink-0 text-amber-300" />
                  <div>
                    <h3 className="font-semibold text-amber-100">
                      Invitation token missing
                    </h3>
                    <p className="mt-1 text-sm leading-6 text-amber-100/65">
                      Open the complete link supplied by your administrator. If
                      it was already used or lost, request a new invitation.
                    </p>
                  </div>
                </div>
                <Link
                  href="/login"
                  className="mt-5 inline-flex items-center gap-2 text-sm font-medium text-sky-300 hover:text-sky-200"
                >
                  Return to sign in
                  <ArrowRight className="h-4 w-4" />
                </Link>
              </div>
            ) : (
              <form onSubmit={handleSubmit} className="mt-7 space-y-4">
                <div>
                  <label
                    htmlFor="registration-email"
                    className="mb-2 block text-sm font-medium text-[var(--sky-text-secondary)]"
                  >
                    Invited email address
                  </label>
                  <div className="relative">
                    <Mail className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--sky-text-muted)]" />
                    <input
                      id="registration-email"
                      type="email"
                      value={email}
                      onChange={(event) => setEmail(event.target.value)}
                      required
                      maxLength={254}
                      autoComplete="email"
                      disabled={loading}
                      className={inputClassName}
                      placeholder="you@agency.gov"
                    />
                  </div>
                </div>

                <div>
                  <label
                    htmlFor="registration-name"
                    className="mb-2 block text-sm font-medium text-[var(--sky-text-secondary)]"
                  >
                    Full name
                  </label>
                  <div className="relative">
                    <UserRound className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--sky-text-muted)]" />
                    <input
                      id="registration-name"
                      type="text"
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                      required
                      maxLength={120}
                      autoComplete="name"
                      disabled={loading}
                      className={inputClassName}
                      placeholder="Your full name"
                    />
                  </div>
                </div>

                <div className="grid gap-4 sm:grid-cols-2">
                  <div>
                    <label
                      htmlFor="registration-password"
                      className="mb-2 block text-sm font-medium text-[var(--sky-text-secondary)]"
                    >
                      Password
                    </label>
                    <div className="relative">
                      <Lock className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--sky-text-muted)]" />
                      <input
                        id="registration-password"
                        type="password"
                        value={password}
                        onChange={(event) => setPassword(event.target.value)}
                        required
                        minLength={16}
                        autoComplete="new-password"
                        disabled={loading}
                        className={inputClassName}
                        placeholder="16+ characters"
                      />
                    </div>
                  </div>

                  <div>
                    <label
                      htmlFor="registration-password-confirmation"
                      className="mb-2 block text-sm font-medium text-[var(--sky-text-secondary)]"
                    >
                      Confirm password
                    </label>
                    <div className="relative">
                      <Lock className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--sky-text-muted)]" />
                      <input
                        id="registration-password-confirmation"
                        type="password"
                        value={passwordConfirmation}
                        onChange={(event) =>
                          setPasswordConfirmation(event.target.value)
                        }
                        required
                        minLength={16}
                        autoComplete="new-password"
                        disabled={loading}
                        className={inputClassName}
                        placeholder="Repeat password"
                      />
                    </div>
                  </div>
                </div>

                <p className="text-xs leading-5 text-[var(--sky-text-muted)]">
                  Use 16–72 UTF-8 bytes with upper- and lowercase letters, a
                  number, and a symbol.
                </p>

                {error && (
                  <div
                    role="alert"
                    className="rounded-xl border border-red-400/20 bg-red-400/[0.08] px-3.5 py-3 text-sm text-red-200"
                  >
                    {error}
                  </div>
                )}

                <button
                  type="submit"
                  disabled={loading}
                  className="flex w-full items-center justify-center gap-2 rounded-xl bg-[var(--sky-gradient-primary)] px-4 py-3 text-sm font-semibold text-white shadow-lg shadow-sky-950/30 transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {loading ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <ShieldCheck className="h-4 w-4" />
                  )}
                  {loading ? "Creating account…" : "Create account"}
                </button>

                <p className="text-center text-xs text-[var(--sky-text-muted)]">
                  Already registered?{" "}
                  <Link
                    href="/login"
                    className="font-medium text-sky-300 hover:text-sky-200"
                  >
                    Sign in
                  </Link>
                </p>
              </form>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}
