import type { Metadata } from "next";
import { PasswordResetForm } from "@/components/password-reset-form";

export const metadata: Metadata = {
  title: "Reset password — SkyShield",
  description: "Redeem an approved one-time SkyShield password reset link.",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default function ResetPasswordPage() {
  return <PasswordResetForm />;
}
