import { Shield } from "lucide-react";
import Link from "next/link";

export default function NotFound() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-950 p-6">
      <div className="text-center max-w-md">
        <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-blue-900/20 mb-6">
          <Shield className="w-8 h-8 text-blue-400" />
        </div>
        <h2 className="text-4xl font-bold text-white mb-2">404</h2>
        <p className="text-lg text-gray-400 mb-6">
          The page you&apos;re looking for doesn&apos;t exist.
        </p>
        <Link
          href="/dashboard"
          className="inline-flex items-center gap-2 px-5 py-2.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-xl transition-colors"
        >
          Back to Dashboard
        </Link>
      </div>
    </div>
  );
}
