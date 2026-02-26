"use client";

import { useState, useEffect } from "react";
import { Bot, Save, Loader2, Check, Eye, EyeOff } from "lucide-react";

const AVAILABLE_MODELS = [
    { value: "claude-sonnet-4-6", label: "Claude Sonnet 4.6 (Default)" },
    { value: "claude-sonnet-4-20250514", label: "Claude Sonnet 4" },
    { value: "claude-3-5-sonnet-20241022", label: "Claude 3.5 Sonnet" },
    { value: "claude-3-haiku-20240307", label: "Claude 3 Haiku (Fast)" },
    { value: "claude-3-opus-20240229", label: "Claude 3 Opus (Most capable)" },
];

export function LLMSettings() {
    const [model, setModel] = useState("");
    const [apiKey, setApiKey] = useState("");
    const [apiKeyMasked, setApiKeyMasked] = useState("");
    const [hasApiKey, setHasApiKey] = useState(false);
    const [showApiKey, setShowApiKey] = useState(false);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);
    const [error, setError] = useState("");

    useEffect(() => {
        fetchSettings();
    }, []);

    async function fetchSettings() {
        try {
            const res = await fetch("/api/settings/llm");
            if (res.ok) {
                const data = await res.json();
                setModel(data.model || "claude-sonnet-4-6");
                setApiKeyMasked(data.apiKeyMasked || "");
                setHasApiKey(data.hasApiKey || false);
            }
        } catch {
            // ignore
        } finally {
            setLoading(false);
        }
    }

    async function handleSave() {
        setSaving(true);
        setError("");
        setSaved(false);

        try {
            const body: Record<string, string> = { model };
            if (apiKey.trim()) {
                body.apiKey = apiKey.trim();
            }

            const res = await fetch("/api/settings/llm", {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });

            if (!res.ok) {
                const data = await res.json();
                setError(data.error || "Failed to save");
                return;
            }

            setSaved(true);
            setApiKey("");
            fetchSettings();
            setTimeout(() => setSaved(false), 3000);
        } catch {
            setError("Network error. Please try again.");
        } finally {
            setSaving(false);
        }
    }

    if (loading) {
        return (
            <div className="bg-[var(--sky-surface)] border border-[var(--sky-border)] rounded-xl p-6 mb-8">
                <div className="flex items-center gap-2 mb-4">
                    <Bot className="w-5 h-5 text-gray-500" />
                    <h2 className="font-semibold text-white">AI Configuration</h2>
                </div>
                <div className="flex items-center gap-2 text-sm text-[var(--sky-text-muted)]">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Loading settings...
                </div>
            </div>
        );
    }

    return (
        <div className="bg-[var(--sky-surface)] border border-[var(--sky-border)] rounded-xl overflow-hidden mb-8">
            <div className="px-6 py-4 border-b border-[var(--sky-border)] flex items-center gap-2">
                <Bot className="w-5 h-5 text-gray-500" />
                <h2 className="font-semibold text-white">AI Configuration</h2>
            </div>
            <div className="p-6 space-y-5">
                {/* Model Selector */}
                <div>
                    <label className="block text-sm font-medium text-[var(--sky-text-secondary)] mb-1.5">
                        LLM Model
                    </label>
                    <select
                        value={model}
                        onChange={(e) => setModel(e.target.value)}
                        className="w-full max-w-md px-3 py-2.5 bg-[var(--sky-surface-overlay)] border border-[var(--sky-border)] rounded-lg text-sm text-white focus:outline-none focus:ring-2 focus:ring-[var(--sky-blue)]/50 focus:border-[var(--sky-blue)]/50"
                    >
                        {AVAILABLE_MODELS.map((m) => (
                            <option key={m.value} value={m.value}>
                                {m.label}
                            </option>
                        ))}
                    </select>
                    <p className="text-xs text-[var(--sky-text-muted)] mt-1.5">
                        Select the Anthropic model used for compliance analysis.
                    </p>
                </div>

                {/* API Key */}
                <div>
                    <label className="block text-sm font-medium text-[var(--sky-text-secondary)] mb-1.5">
                        Anthropic API Key
                    </label>
                    <div className="relative max-w-md">
                        <input
                            type={showApiKey ? "text" : "password"}
                            value={apiKey}
                            onChange={(e) => setApiKey(e.target.value)}
                            placeholder={hasApiKey ? `Current: ${apiKeyMasked}` : "sk-ant-..."}
                            className="w-full px-3 py-2.5 pr-10 bg-[var(--sky-surface-overlay)] border border-[var(--sky-border)] rounded-lg text-sm text-white placeholder-[var(--sky-text-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--sky-blue)]/50 focus:border-[var(--sky-blue)]/50"
                        />
                        <button
                            type="button"
                            onClick={() => setShowApiKey(!showApiKey)}
                            className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--sky-text-muted)] hover:text-white transition-colors"
                        >
                            {showApiKey ? (
                                <EyeOff className="w-4 h-4" />
                            ) : (
                                <Eye className="w-4 h-4" />
                            )}
                        </button>
                    </div>
                    <p className="text-xs text-[var(--sky-text-muted)] mt-1.5">
                        {hasApiKey
                            ? "Leave blank to keep the current key. Enter a new key to replace it."
                            : "Falls back to the server environment variable if not set here."}
                    </p>
                </div>

                {/* Actions */}
                <div className="flex items-center gap-3 pt-2">
                    <button
                        onClick={handleSave}
                        disabled={saving}
                        className="flex items-center gap-2 px-4 py-2.5 bg-[var(--sky-royal)] hover:bg-[var(--sky-blue)] text-white rounded-lg text-sm font-medium transition-all disabled:opacity-50 active:scale-[0.98]"
                    >
                        {saving ? (
                            <Loader2 className="w-4 h-4 animate-spin" />
                        ) : saved ? (
                            <Check className="w-4 h-4" />
                        ) : (
                            <Save className="w-4 h-4" />
                        )}
                        {saving ? "Saving..." : saved ? "Saved!" : "Save Configuration"}
                    </button>
                    {error && (
                        <p className="text-sm text-red-400">{error}</p>
                    )}
                </div>
            </div>
        </div>
    );
}
