import { AuthForm } from "@/components/auth/auth-form";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Create an account",
  description: "Start photographing your clothes and seeing yourself in them.",
};

export default function SignUpPage() {
  return <AuthForm mode="sign-up" />;
}
