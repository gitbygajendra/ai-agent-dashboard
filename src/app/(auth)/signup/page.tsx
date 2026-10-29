import { Suspense } from "react";
import { AuthForm } from "../auth-form";

export const metadata = { title: "Create account" };

export default function SignupPage() {
  return (
    <div className="space-y-5">
      <div className="space-y-1">
        <h1 className="text-lg font-semibold">Create your workspace</h1>
        <p className="text-sm text-muted-foreground">Your data stays in your own workspace.</p>
      </div>
      <Suspense>
        <AuthForm mode="signup" />
      </Suspense>
    </div>
  );
}
