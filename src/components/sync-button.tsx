"use client";

import { useState } from "react";
import { RefreshCw, Play } from "lucide-react";
import { useRouter } from "next/navigation";

export function SyncButton() {
    const router = useRouter();
    const [syncing, setSyncing] = useState(false);
    const [message, setMessage] = useState<string | null>(null);

    const handleSync = async () => {
        setSyncing(true);
        setMessage(null);
        try {
            const res = await fetch("/api/scsems/sync", {
                method: "POST",
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || "Failed to sync");

            setMessage(data.message || "Sync successful");
            router.refresh();

            // Clear message after 3 seconds
            setTimeout(() => setMessage(null), 3000);
        } catch (err: any) {
            console.error(err);
            setMessage(err.message || "An error occurred");
        } finally {
            setSyncing(false);
        }
    };

    return (
        <div className="flex items-center gap-3">
            {message && (
                <span className={`text-sm ${message.includes("Failed") || message.includes("error") ? "text-red-400" : "text-emerald-400"}`}>
                    {message}
                </span>
            )}
            <button
                onClick={handleSync}
                disabled={syncing}
                className="inline-flex items-center gap-2 px-4 py-2 bg-[var(--sky-royal)] hover:bg-[var(--sky-blue)] disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors border border-blue-500/50"
            >
                <RefreshCw className={`w-4 h-4 ${syncing ? "animate-spin" : ""}`} />
                {syncing ? "Syncing..." : "Sync CIS Benchmarks"}
            </button>
        </div>
    );
}
