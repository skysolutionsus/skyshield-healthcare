"use client";

import { useState, useEffect } from "react";
import { Bot, Save, Loader2, Check, Eye, EyeOff } from "lucide-react";
import { BIFROST_CHAT_MODEL_OPTIONS } from "@/lib/ai/models";

export function LLMSettings() {
    const [model, setModel] = useState("");
    const [apiKey, setApiKey] = useState("");
    const [apiKeyMasked, setApiKeyMasked] = useState("");
    const [hasApiKey, setHasApiKey] = useState(false);
    const [legacyKeyIgnored, setLegacyKeyIgnored] = useState(false);
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
                setModel(data.model || "azure/claude-sonnet-4-6");
                setApiKeyMasked(data.apiKeyMasked || "");
                setHasApiKey(data.hasApiKey || false);
                setLegacyKeyIgnored(data.legacyKeyIgnored || false);
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
                    <h2 className="font-semibold text-white">Assistant AI Configuration</h2>
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
            <div className="flex items-center gap-2 border-b border-[var(--sky-border)] px-4 py-4 sm:px-6">
                <Bot className="w-5 h-5 text-gray-500" />
                <h2 className="font-semibold text-white">Assistant AI Configuration</h2>
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
                        {BIFROST_CHAT_MODEL_OPTIONS.map((m) => (
                            <option key={m.value} value={m.value}>
                                {m.label}
                            </option>
                        ))}
                    </select>
                    <p className="text-xs text-[var(--sky-text-muted)] mt-1.5">
                        Select the Bifrost model route used by the general SkyShield Assistant.
                        The SCSEM Updater uses deployment-managed
                        <code className="mx-1">BIFROST_SCSEM_MODEL</code>
                        and <code>BIFROST_API_KEY</code> settings so a browser change cannot
                        silently alter canonical-template analysis provenance.
                    </p>
                </div>

                {/* API Key */}
                <div>
                    <label className="block text-sm font-medium text-[var(--sky-text-secondary)] mb-1.5">
                        Bifrost Virtual Key
                    </label>
                    <div className="relative max-w-md">
                        <input
                            type={showApiKey ? "text" : "password"}
                            value={apiKey}
                            onChange={(e) => setApiKey(e.target.value)}
                            placeholder={hasApiKey ? `Current: ${apiKeyMasked}` : "sk-bf-..."}
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
                            : "Used by the general Assistant and falls back to the server BIFROST_API_KEY. This form does not configure SCSEM Updater evidence analysis."}
                    </p>
                    {legacyKeyIgnored && (
                        <p className="text-xs text-amber-300 mt-1.5">
                            An older non-Bifrost key is saved here and is being ignored. Enter a Bifrost virtual key to replace it.
                        </p>
                    )}
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
