import type { Metadata } from "next";
import { RegistrationForm } from "@/components/registration-form";

export const metadata: Metadata = {
  title: "Accept invitation — SkyShield",
  description: "Create an individual SkyShield account from an approved invitation.",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default function RegisterPage() {
  return <RegistrationForm />;
}
