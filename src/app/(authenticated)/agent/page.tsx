"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import {
  Send,
  Loader2,
  AlertTriangle,
  BookmarkPlus,
  Bookmark,
  Plus,
  MessageSquare,
  Flag,
  PanelLeftClose,
  PanelLeft,
  BookOpen,
  Check,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface Citation {
  section: string;
  text: string;
}

interface ModelSwitchOption {
  value: string;
  label: string;
}

interface ModelSwitchSuggestion {
  reason: "quota";
  options: ModelSwitchOption[];
}

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  citations?: Citation[];
  piiBlocked?: boolean;
  piiTypes?: string[];
  incidentId?: string;
  modelSwitch?: ModelSwitchSuggestion;
}

interface ConversationSummary {
  id: string;
  title: string;
  bookmarked: boolean;
  updatedAt: string;
}

/* ─────────────────── Markdown renderer ─────────────────── */
function renderMarkdown(content: string) {
  const lines = content.split("\n");
  const elements: React.ReactNode[] = [];
  let listItems: React.ReactNode[] = [];
  let listType: "ul" | "ol" | null = null;
  let key = 0;

  function flushList() {
    if (listItems.length > 0 && listType) {
      const Tag = listType;
      elements.push(
        <Tag
          key={key++}
          className={cn(
            "my-2 space-y-1 text-sm leading-relaxed text-[var(--sky-text-primary)]",
            listType === "ol" ? "list-decimal pl-5" : "list-disc pl-5"
          )}
        >
          {listItems}
        </Tag>
      );
      listItems = [];
      listType = null;
    }
  }

  function inlineFormat(text: string): React.ReactNode[] {
    const parts: React.ReactNode[] = [];
    const regex = /(\*\*(.+?)\*\*|`(.+?)`|\[((?:Section|Exhibit)\s[^\]]+)\])/g;
    let lastIndex = 0;
    let match;

    while ((match = regex.exec(text)) !== null) {
      if (match.index > lastIndex) {
        parts.push(text.slice(lastIndex, match.index));
      }
      if (match[2]) {
        parts.push(
          <strong key={`b-${match.index}`} className="font-semibold text-white">
            {match[2]}
          </strong>
        );
      } else if (match[3]) {
        parts.push(
          <code key={`c-${match.index}`} className="px-1.5 py-0.5 bg-[var(--sky-surface)] rounded text-xs font-mono text-[var(--sky-cyan)]">
            {match[3]}
          </code>
        );
      } else if (match[4]) {
        parts.push(
          <span
            key={`s-${match.index}`}
            className="inline-flex items-center px-1.5 py-0.5 bg-blue-900/30 text-[var(--sky-cyan)] rounded text-xs font-medium border border-blue-800/40"
          >
            {match[4]}
          </span>
        );
      }
      lastIndex = match.index + match[0].length;
    }
    if (lastIndex < text.length) {
      parts.push(text.slice(lastIndex));
    }
    return parts.length > 0 ? parts : [text];
  }

  for (const line of lines) {
    const trimmed = line.trim();

    const bulletMatch = trimmed.match(/^[-\u2022]\s+(.+)/);
    if (bulletMatch) {
      if (listType !== "ul") { flushList(); listType = "ul"; }
      listItems.push(<li key={key++}>{inlineFormat(bulletMatch[1])}</li>);
      continue;
    }

    const numMatch = trimmed.match(/^\d+\.\s+(.+)/);
    if (numMatch) {
      if (listType !== "ol") { flushList(); listType = "ol"; }
      listItems.push(<li key={key++}>{inlineFormat(numMatch[1])}</li>);
      continue;
    }

    flushList();

    if (!trimmed) {
      elements.push(<div key={key++} className="h-2" />);
      continue;
    }

    elements.push(
      <p key={key++} className="text-sm leading-relaxed text-[var(--sky-text-primary)]">
        {inlineFormat(trimmed)}
      </p>
    );
  }
  flushList();
  return elements;
}

/* ─────────────────── IRS Agent Avatar ─────────────────── */
function AgentAvatar({ size = "md" }: { size?: "sm" | "md" | "lg" }) {
  const sizeClasses = {
    sm: "w-7 h-7",
    md: "w-8 h-8",
    lg: "w-16 h-16",
  };
  return (
    <div
      className={cn(
        sizeClasses[size],
        "rounded-xl bg-white flex items-center justify-center shrink-0 shadow-sm overflow-hidden p-1"
      )}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/irs-logo.png" alt="IRS" className="w-full h-full object-contain" />
    </div>
  );
}

/* ─────────────────── Typing indicator ─────────────────── */
function TypingIndicator() {
  return (
    <div className="flex gap-3 max-w-3xl">
      <AgentAvatar />
      <div className="bg-[var(--sky-surface-overlay)] rounded-2xl rounded-tl-md px-5 py-3 border border-[var(--sky-border)]/50">
        <div className="flex items-center gap-3">
          <div className="flex gap-1">
            <span className="w-1.5 h-1.5 bg-[var(--sky-cyan)] rounded-full animate-bounce" style={{ animationDelay: "0ms" }} />
            <span className="w-1.5 h-1.5 bg-[var(--sky-cyan)] rounded-full animate-bounce" style={{ animationDelay: "150ms" }} />
            <span className="w-1.5 h-1.5 bg-[var(--sky-cyan)] rounded-full animate-bounce" style={{ animationDelay: "300ms" }} />
          </div>
          <span className="text-sm text-[var(--sky-text-secondary)]">
            Analyzing Office of Safeguards guidelines...
          </span>
        </div>
      </div>
    </div>
  );
}

/* ─────────────────── Message bubble ─────────────────── */
function MessageBubble({ msg }: { msg: Message }) {
  const [showFPForm, setShowFPForm] = useState(false);
  const [fpReason, setFpReason] = useState("");
  const [fpSubmitting, setFpSubmitting] = useState(false);
  const [fpResult, setFpResult] = useState<"success" | "error" | null>(null);
  const [fpError, setFpError] = useState("");
  const [switchingModel, setSwitchingModel] = useState<string | null>(null);
  const [switchedModel, setSwitchedModel] = useState<string | null>(null);
  const [modelSwitchError, setModelSwitchError] = useState("");

  async function handleModelSwitch(model: string) {
    setSwitchingModel(model);
    setModelSwitchError("");

    try {
      const res = await fetch("/api/settings/llm/switch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model }),
      });
      const data = await res.json();
      if (!res.ok) {
        setModelSwitchError(data.error || "Failed to switch the model.");
        return;
      }
      setSwitchedModel(data.model);
    } catch {
      setModelSwitchError("Network error. Please try again.");
    } finally {
      setSwitchingModel(null);
    }
  }

  async function handleFalsePositive() {
    if (!msg.incidentId || !fpReason.trim()) return;
    setFpSubmitting(true);
    setFpResult(null);
    setFpError("");
    try {
      const res = await fetch(`/api/incidents/${msg.incidentId}/false-positive`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: fpReason.trim() }),
      });
      if (res.ok) {
        setFpResult("success");
        setShowFPForm(false);
        setFpReason("");
      } else {
        const data = await res.json();
        setFpError(data.error || "Failed to submit");
        setFpResult("error");
      }
    } catch {
      setFpError("Network error");
      setFpResult("error");
    } finally {
      setFpSubmitting(false);
    }
  }

  if (msg.piiBlocked) {
    return (
      <div className="flex gap-3 max-w-3xl animate-in slide-in-from-bottom-2 duration-300">
        <div className="w-8 h-8 rounded-xl bg-red-900/30 flex items-center justify-center shrink-0 mt-0.5">
          <AlertTriangle className="w-4 h-4 text-red-400" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="bg-red-900/20 border border-red-800 rounded-2xl rounded-tl-md p-5">
            <div className="flex items-center gap-2 mb-2">
              <AlertTriangle className="w-4 h-4 text-red-400" />
              <span className="text-sm font-semibold text-red-300">
                FTI/PII Detected &mdash; Message Blocked
              </span>
            </div>
            <p className="text-sm text-red-400">
              {msg.content}
            </p>
            {msg.piiTypes && msg.piiTypes.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-1.5">
                {msg.piiTypes.map((t) => (
                  <span
                    key={t}
                    className="px-2.5 py-1 text-xs font-medium rounded-full bg-red-900/40 text-red-300"
                  >
                    {t}
                  </span>
                ))}
              </div>
            )}
            <p className="text-xs text-red-500 mt-3">
              An incident has been auto-created. If this was a false positive,
              you can report it for admin review.
            </p>

            {/* False Positive Reporting */}
            {fpResult === "success" ? (
              <div className="mt-3 flex items-center gap-1.5 text-xs text-emerald-400">
                <Check className="w-3.5 h-3.5" />
                False positive reported. An admin will review it.
              </div>
            ) : msg.incidentId ? (
              <div className="mt-2">
                {!showFPForm ? (
                  <button
                    onClick={() => setShowFPForm(true)}
                    className="flex items-center gap-1.5 text-xs text-red-400 hover:text-red-300 transition-colors"
                  >
                    <Flag className="w-3.5 h-3.5" />
                    Report False Positive
                  </button>
                ) : (
                  <div className="space-y-2">
                    <textarea
                      value={fpReason}
                      onChange={(e) => setFpReason(e.target.value)}
                      placeholder="Why is this a false positive? (e.g., 'This is a sample name used for testing')"
                      rows={2}
                      className="w-full px-3 py-2 bg-red-900/10 border border-red-800/50 rounded-lg text-xs text-red-300 placeholder-red-600 focus:outline-none focus:ring-1 focus:ring-red-500/50 resize-none"
                    />
                    <div className="flex items-center gap-2">
                      <button
                        onClick={handleFalsePositive}
                        disabled={fpSubmitting || fpReason.trim().length < 5}
                        className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-red-800/30 hover:bg-red-800/50 text-red-300 rounded-lg transition-colors disabled:opacity-50"
                      >
                        {fpSubmitting ? (
                          <Loader2 className="w-3 h-3 animate-spin" />
                        ) : (
                          <Flag className="w-3 h-3" />
                        )}
                        Submit Report
                      </button>
                      <button
                        onClick={() => { setShowFPForm(false); setFpReason(""); }}
                        className="text-xs text-red-500 hover:text-red-400 transition-colors"
                      >
                        Cancel
                      </button>
                    </div>
                    {fpResult === "error" && (
                      <p className="text-xs text-red-500">{fpError}</p>
                    )}
                  </div>
                )}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    );
  }

  if (msg.role === "user") {
    return (
      <div className="flex gap-3 max-w-3xl ml-auto flex-row-reverse animate-in slide-in-from-bottom-2 duration-200">
        <div className="w-8 h-8 rounded-xl bg-[var(--sky-royal)] flex items-center justify-center shrink-0 mt-0.5 shadow-sm">
          <span className="text-xs font-bold text-white">You</span>
        </div>
        <div className="flex-1 min-w-0 text-right">
          <div className="inline-block text-left bg-[var(--sky-royal)] text-white rounded-2xl rounded-tr-md px-5 py-3 shadow-sm">
            <div className="text-sm whitespace-pre-wrap leading-relaxed">
              {msg.content}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex gap-3 max-w-3xl animate-in slide-in-from-bottom-2 duration-300">
      <AgentAvatar />
      <div className="flex-1 min-w-0">
        <div className="bg-[var(--sky-surface-overlay)] rounded-2xl rounded-tl-md px-5 py-4 border border-[var(--sky-border)]/50">
          <div className="space-y-1">
            {renderMarkdown(msg.content)}
          </div>
          {msg.modelSwitch && (
            <div className="mt-4 border-t border-[var(--sky-border)] pt-4">
              <p className="text-xs font-medium text-[var(--sky-text-secondary)] mb-2">
                Switch the model saved in Settings:
              </p>
              <div className="flex flex-wrap gap-2">
                {msg.modelSwitch.options.map((option) => {
                  const isSwitching = switchingModel === option.value;
                  const isSelected = switchedModel === option.value;
                  return (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => handleModelSwitch(option.value)}
                      disabled={Boolean(switchingModel) || Boolean(switchedModel)}
                      className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-[var(--sky-royal)] hover:bg-[var(--sky-blue)] text-white text-xs font-medium transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
                    >
                      {isSwitching ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : isSelected ? (
                        <Check className="w-3.5 h-3.5" />
                      ) : null}
                      {isSelected ? `Using ${option.label}` : `Switch to ${option.label}`}
                    </button>
                  );
                })}
              </div>
              {switchedModel && (
                <p className="text-xs text-emerald-400 mt-2">
                  Model changed in Settings. You can send your question again now.
                </p>
              )}
              {modelSwitchError && (
                <p className="text-xs text-red-400 mt-2">{modelSwitchError}</p>
              )}
            </div>
          )}
        </div>

        {msg.citations && msg.citations.length > 0 && (
          <div className="mt-2.5 px-1">
            <p className="text-[11px] font-medium text-[var(--sky-text-muted)] uppercase tracking-wider mb-1.5">
              References
            </p>
            <div className="flex flex-wrap gap-1.5">
              {msg.citations.map((cite, i) => (
                <span
                  key={i}
                  className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-lg bg-blue-900/20 text-[var(--sky-cyan)] border border-blue-800/40 cursor-default"
                  title={cite.text || cite.section}
                >
                  <BookOpen className="w-3 h-3" />
                  {cite.section}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ─────────────────── Suggested questions ─────────────────── */
const SUGGESTED_QUESTIONS = [
  "What are the requirements for FTI data encryption at rest?",
  "Explain the incident reporting timeline requirements",
  "What access controls are required for systems handling FTI?",
  "What are the physical security requirements for FTI?",
];

/* ─────────────────── Main page ─────────────────── */
export default function AgentPage() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [showSidebar, setShowSidebar] = useState(true);
  const [bookmarked, setBookmarked] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    loadConversations();
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const loadConversations = useCallback(async () => {
    try {
      const res = await fetch("/api/chat?list=true");
      if (res.ok) {
        const data = await res.json();
        setConversations(data.conversations || []);
      }
    } catch {
      // ignore
    }
  }, []);

  async function loadConversation(id: string) {
    try {
      const res = await fetch(`/api/chat?conversationId=${id}`);
      if (res.ok) {
        const data = await res.json();
        setConversationId(id);
        setMessages(data.messages || []);
        setBookmarked(data.bookmarked || false);
      }
    } catch {
      // ignore
    }
  }

  function startNewConversation() {
    setConversationId(null);
    setMessages([]);
    setBookmarked(false);
    inputRef.current?.focus();
  }

  async function toggleBookmark() {
    if (!conversationId) return;
    try {
      const res = await fetch("/api/chat", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversationId,
          bookmarked: !bookmarked,
        }),
      });
      if (res.ok) {
        setBookmarked(!bookmarked);
        loadConversations();
      }
    } catch {
      // ignore
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!input.trim() || loading) return;

    const userMessage: Message = {
      id: Date.now().toString(),
      role: "user",
      content: input.trim(),
    };

    setMessages((prev) => [...prev, userMessage]);
    setInput("");
    setLoading(true);

    if (inputRef.current) {
      inputRef.current.style.height = "auto";
    }

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: userMessage.content,
          conversationId,
        }),
      });

      const data = await res.json();

      if (data.piiBlocked) {
        setMessages((prev) => [
          ...prev,
          {
            id: Date.now().toString(),
            role: "assistant",
            content: data.message,
            piiBlocked: true,
            piiTypes: data.piiTypes,
            incidentId: data.incidentId,
          },
        ]);
      } else if (data.modelSwitch) {
        if (data.conversationId) {
          setConversationId(data.conversationId);
        }
        setMessages((prev) => [
          ...prev,
          {
            id: Date.now().toString(),
            role: "assistant",
            content: data.error,
            modelSwitch: data.modelSwitch,
          },
        ]);
        loadConversations();
      } else if (data.error) {
        setMessages((prev) => [
          ...prev,
          {
            id: Date.now().toString(),
            role: "assistant",
            content: data.error,
          },
        ]);
      } else {
        if (data.conversationId) {
          setConversationId(data.conversationId);
        }
        setMessages((prev) => [
          ...prev,
          {
            id: Date.now().toString(),
            role: "assistant",
            content: data.response,
            citations: data.citations,
          },
        ]);
        loadConversations();
      }
    } catch {
      setMessages((prev) => [
        ...prev,
        {
          id: Date.now().toString(),
          role: "assistant",
          content: "Failed to get response. Please try again.",
        },
      ]);
    } finally {
      setLoading(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  }

  function handleSuggestedQuestion(q: string) {
    setInput(q);
    inputRef.current?.focus();
  }

  return (
    <div className="flex h-[calc(100vh-3.5rem)] lg:h-screen">
      {/* Conversation Sidebar */}
      <div
        className={cn(
          "border-r border-[var(--sky-border)] bg-[var(--sky-navy)] flex flex-col transition-all duration-200",
          showSidebar ? "w-72" : "w-0 overflow-hidden"
        )}
      >
        <div className="p-4 border-b border-[var(--sky-border)]">
          <button
            onClick={startNewConversation}
            className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-[var(--sky-royal)] hover:bg-[var(--sky-blue)] text-white rounded-xl text-sm font-medium transition-all active:scale-[0.98] shadow-sm"
          >
            <Plus className="w-4 h-4" />
            New Conversation
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
          {conversations.length === 0 && (
            <p className="text-sm text-[var(--sky-text-muted)] text-center py-8">
              No conversations yet
            </p>
          )}
          {conversations.map((conv) => (
            <button
              key={conv.id}
              onClick={() => loadConversation(conv.id)}
              className={cn(
                "w-full text-left px-3 py-2.5 rounded-lg text-sm transition-all",
                conversationId === conv.id
                  ? "bg-blue-900/20 text-[var(--sky-cyan)] shadow-sm"
                  : "text-[var(--sky-text-secondary)] hover:bg-[var(--sky-surface-overlay)]"
              )}
            >
              <div className="flex items-center gap-2">
                {conv.bookmarked ? (
                  <Bookmark className="w-3.5 h-3.5 text-amber-500 shrink-0 fill-amber-500" />
                ) : (
                  <MessageSquare className="w-3.5 h-3.5 text-[var(--sky-text-muted)] shrink-0" />
                )}
                <span className="truncate">{conv.title}</span>
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Chat Area */}
      <div className="flex-1 flex flex-col min-w-0" style={{ background: 'var(--sky-surface)' }}>
        {/* Chat Header */}
        <div className="flex items-center justify-between px-6 py-3 border-b border-[var(--sky-border)] bg-[var(--sky-navy)]">
          <div className="flex items-center gap-3">
            <button
              onClick={() => setShowSidebar(!showSidebar)}
              className="text-[var(--sky-text-muted)] hover:text-white transition-colors"
            >
              {showSidebar ? (
                <PanelLeftClose className="w-5 h-5" />
              ) : (
                <PanelLeft className="w-5 h-5" />
              )}
            </button>
            <div className="flex items-center gap-2.5">
              <AgentAvatar size="sm" />
              <div>
                <h2 className="text-sm font-semibold text-white">
                  Office of Safeguards AI Agent
                </h2>
                <p className="text-xs text-[var(--sky-text-muted)]">
                  Responses follow the Safeguards inquiry format
                </p>
              </div>
            </div>
          </div>
          {conversationId && (
            <button
              onClick={toggleBookmark}
              className="text-[var(--sky-text-muted)] hover:text-amber-500 transition-colors p-1.5 rounded-lg hover:bg-[var(--sky-surface-overlay)]"
              title={bookmarked ? "Remove bookmark" : "Bookmark conversation"}
            >
              {bookmarked ? (
                <Bookmark className="w-5 h-5 fill-amber-500 text-amber-500" />
              ) : (
                <BookmarkPlus className="w-5 h-5" />
              )}
            </button>
          )}
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto p-6 space-y-5">
          {messages.length === 0 && (
            <div className="flex flex-col items-center justify-center h-full text-center max-w-lg mx-auto">
              <AgentAvatar size="lg" />
              <h3 className="text-xl font-bold text-white mt-5 mb-2">
                Office of Safeguards AI Agent
              </h3>
              <p className="text-sm text-[var(--sky-text-secondary)] mb-8 leading-relaxed">
                Ask any question about IRS Office of Safeguards compliance
                requirements. Responses are structured by inquiry with a clear response,
                support, and references.
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 w-full text-left">
                {SUGGESTED_QUESTIONS.map((q) => (
                  <button
                    key={q}
                    onClick={() => handleSuggestedQuestion(q)}
                    className="px-4 py-3 text-sm text-[var(--sky-text-secondary)] bg-[var(--sky-surface-overlay)] rounded-xl transition-all text-left border border-[var(--sky-border)] hover:border-[var(--sky-border-bright)] hover:text-white active:scale-[0.98]"
                  >
                    {q}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((msg) => (
            <MessageBubble key={msg.id} msg={msg} />
          ))}

          {loading && <TypingIndicator />}

          <div ref={messagesEndRef} />
        </div>

        {/* Input */}
        <div className="border-t border-[var(--sky-border)] bg-[var(--sky-navy)] p-4">
          <form onSubmit={handleSubmit} className="max-w-3xl mx-auto">
            <div className="flex gap-3 items-end">
              <div className="flex-1 relative">
                <textarea
                  ref={inputRef}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="Ask about Office of Safeguards compliance..."
                  rows={1}
                  className="w-full resize-none px-4 py-3 bg-[var(--sky-surface-overlay)] border border-[var(--sky-border)] rounded-xl text-sm text-white placeholder-[var(--sky-text-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--sky-blue)]/50 focus:border-[var(--sky-blue)]/50 transition-all"
                  style={{ minHeight: "48px", maxHeight: "200px" }}
                  onInput={(e) => {
                    const target = e.target as HTMLTextAreaElement;
                    target.style.height = "auto";
                    target.style.height =
                      Math.min(target.scrollHeight, 200) + "px";
                  }}
                />
              </div>
              <button
                type="submit"
                disabled={!input.trim() || loading}
                className={cn(
                  "px-4 py-3 rounded-xl transition-all shadow-sm",
                  input.trim() && !loading
                    ? "bg-[var(--sky-royal)] hover:bg-[var(--sky-blue)] text-white active:scale-95"
                    : "bg-[var(--sky-surface-overlay)] text-[var(--sky-text-muted)] cursor-not-allowed"
                )}
              >
                {loading ? (
                  <Loader2 className="w-5 h-5 animate-spin" />
                ) : (
                  <Send className="w-5 h-5" />
                )}
              </button>
            </div>
            <p className="text-xs text-[var(--sky-text-muted)] mt-2 text-center">
              Never enter FTI/PII data. All inputs are scanned and blocked if
              sensitive data is detected.
            </p>
          </form>
        </div>
      </div>
    </div>
  );
}
