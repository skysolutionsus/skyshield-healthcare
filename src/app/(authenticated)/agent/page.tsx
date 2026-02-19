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
} from "lucide-react";
import { cn } from "@/lib/utils";

interface Citation {
  section: string;
  text: string;
}

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  citations?: Citation[];
  piiBlocked?: boolean;
  piiTypes?: string[];
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
            "my-2 space-y-1 text-sm leading-relaxed",
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
    // Bold, inline code, section refs
    const parts: React.ReactNode[] = [];
    const regex = /(\*\*(.+?)\*\*|`(.+?)`|\[(Section\s[\d.]+(?:\.\d+)*(?:,\s*Page\s+\d+)?|Exhibit\s+\d+)\])/g;
    let lastIndex = 0;
    let match;

    while ((match = regex.exec(text)) !== null) {
      if (match.index > lastIndex) {
        parts.push(text.slice(lastIndex, match.index));
      }
      if (match[2]) {
        // Bold
        parts.push(
          <strong key={`b-${match.index}`} className="font-semibold text-slate-900">
            {match[2]}
          </strong>
        );
      } else if (match[3]) {
        // Inline code
        parts.push(
          <code key={`c-${match.index}`} className="px-1.5 py-0.5 bg-slate-100 rounded text-xs font-mono text-slate-700">
            {match[3]}
          </code>
        );
      } else if (match[4]) {
        // Section ref
        parts.push(
          <span
            key={`s-${match.index}`}
            className="inline-flex items-center px-1.5 py-0.5 bg-blue-50 text-blue-700 rounded text-xs font-medium"
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

    // Bullet list
    const bulletMatch = trimmed.match(/^[-•]\s+(.+)/);
    if (bulletMatch) {
      if (listType !== "ul") {
        flushList();
        listType = "ul";
      }
      listItems.push(<li key={key++}>{inlineFormat(bulletMatch[1])}</li>);
      continue;
    }

    // Numbered list
    const numMatch = trimmed.match(/^\d+\.\s+(.+)/);
    if (numMatch) {
      if (listType !== "ol") {
        flushList();
        listType = "ol";
      }
      listItems.push(<li key={key++}>{inlineFormat(numMatch[1])}</li>);
      continue;
    }

    // If we were in a list and hit a non-list line, flush
    flushList();

    // Empty line = spacer
    if (!trimmed) {
      elements.push(<div key={key++} className="h-2" />);
      continue;
    }

    // Regular paragraph
    elements.push(
      <p key={key++} className="text-sm leading-relaxed text-slate-700">
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
        "rounded-xl bg-white border border-slate-200 flex items-center justify-center shrink-0 shadow-sm overflow-hidden p-1"
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
      <div className="bg-white rounded-2xl rounded-tl-md px-5 py-3 border border-slate-200 shadow-sm">
        <div className="flex items-center gap-3">
          <div className="flex gap-1">
            <span className="w-1.5 h-1.5 bg-blue-500 rounded-full animate-bounce" style={{ animationDelay: "0ms" }} />
            <span className="w-1.5 h-1.5 bg-blue-500 rounded-full animate-bounce" style={{ animationDelay: "150ms" }} />
            <span className="w-1.5 h-1.5 bg-blue-500 rounded-full animate-bounce" style={{ animationDelay: "300ms" }} />
          </div>
          <span className="text-sm text-slate-400">
            Analyzing Publication 1075...
          </span>
        </div>
      </div>
    </div>
  );
}

/* ─────────────────── Message bubble ─────────────────── */
function MessageBubble({ msg }: { msg: Message }) {
  if (msg.piiBlocked) {
    return (
      <div className="flex gap-3 max-w-3xl animate-in slide-in-from-bottom-2 duration-300">
        <div className="w-8 h-8 rounded-xl bg-red-100 flex items-center justify-center shrink-0 mt-0.5">
          <AlertTriangle className="w-4 h-4 text-red-600" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="bg-red-50 border border-red-200 rounded-2xl rounded-tl-md p-5">
            <div className="flex items-center gap-2 mb-2">
              <AlertTriangle className="w-4 h-4 text-red-500" />
              <span className="text-sm font-semibold text-red-800">
                FTI/PII Detected — Message Blocked
              </span>
            </div>
            <p className="text-sm text-red-700">
              {msg.content}
            </p>
            {msg.piiTypes && msg.piiTypes.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-1.5">
                {msg.piiTypes.map((t) => (
                  <span
                    key={t}
                    className="px-2.5 py-1 text-xs font-medium rounded-full bg-red-100 text-red-700 border border-red-200"
                  >
                    {t}
                  </span>
                ))}
              </div>
            )}
            <p className="text-xs text-red-500 mt-3">
              An incident has been auto-created. If this was a false positive,
              you can report it.
            </p>
            <button className="mt-2 flex items-center gap-1.5 text-xs text-red-500 hover:text-red-700 transition-colors">
              <Flag className="w-3.5 h-3.5" />
              Report False Positive
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (msg.role === "user") {
    return (
      <div className="flex gap-3 max-w-3xl ml-auto flex-row-reverse animate-in slide-in-from-bottom-2 duration-200">
        <div className="w-8 h-8 rounded-xl bg-blue-600 flex items-center justify-center shrink-0 mt-0.5 shadow-sm">
          <span className="text-xs font-bold text-white">You</span>
        </div>
        <div className="flex-1 min-w-0 text-right">
          <div className="inline-block text-left bg-blue-600 text-white rounded-2xl rounded-tr-md px-5 py-3 shadow-sm">
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
        <div className="bg-white rounded-2xl rounded-tl-md px-5 py-4 border border-slate-200 shadow-sm">
          <div className="prose-compact">
            {renderMarkdown(msg.content)}
          </div>
        </div>

        {msg.citations && msg.citations.length > 0 && (
          <div className="mt-2.5 px-1">
            <p className="text-[11px] font-medium text-slate-400 uppercase tracking-wider mb-1.5">
              References
            </p>
            <div className="flex flex-wrap gap-1.5">
              {msg.citations.map((cite, i) => (
                <span
                  key={i}
                  className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-lg bg-blue-50 text-blue-700 border border-blue-100 cursor-default"
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
          },
        ]);
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
          "border-r border-slate-200 bg-slate-50 flex flex-col transition-all duration-200",
          showSidebar ? "w-72" : "w-0 overflow-hidden"
        )}
      >
        <div className="p-4 border-b border-slate-200">
          <button
            onClick={startNewConversation}
            className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-xl text-sm font-medium transition-all active:scale-[0.98] shadow-sm"
          >
            <Plus className="w-4 h-4" />
            New Conversation
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
          {conversations.length === 0 && (
            <p className="text-sm text-slate-400 text-center py-8">
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
                  ? "bg-blue-50 text-blue-700 shadow-sm border border-blue-100"
                  : "text-slate-600 hover:bg-slate-100"
              )}
            >
              <div className="flex items-center gap-2">
                {conv.bookmarked ? (
                  <Bookmark className="w-3.5 h-3.5 text-amber-500 shrink-0 fill-amber-500" />
                ) : (
                  <MessageSquare className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                )}
                <span className="truncate">{conv.title}</span>
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Chat Area */}
      <div className="flex-1 flex flex-col min-w-0 bg-slate-100">
        {/* Chat Header */}
        <div className="flex items-center justify-between px-6 py-3 border-b border-slate-200 bg-white">
          <div className="flex items-center gap-3">
            <button
              onClick={() => setShowSidebar(!showSidebar)}
              className="text-slate-400 hover:text-slate-600 transition-colors"
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
                <h2 className="text-sm font-semibold text-slate-900">
                  Pub 1075 AI Agent
                </h2>
                <p className="text-xs text-slate-400">
                  Powered by Claude — All responses cite Pub 1075 sections
                </p>
              </div>
            </div>
          </div>
          {conversationId && (
            <button
              onClick={toggleBookmark}
              className="text-slate-400 hover:text-amber-500 transition-colors p-1.5 rounded-lg hover:bg-slate-50"
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
              <h3 className="text-xl font-bold text-slate-900 mt-5 mb-2">
                Publication 1075 AI Agent
              </h3>
              <p className="text-sm text-slate-500 mb-8 leading-relaxed">
                Ask any question about IRS Publication 1075 compliance
                requirements. Responses are direct, structured, and cite specific sections.
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 w-full text-left">
                {SUGGESTED_QUESTIONS.map((q) => (
                  <button
                    key={q}
                    onClick={() => handleSuggestedQuestion(q)}
                    className="px-4 py-3 text-sm text-slate-600 bg-white rounded-xl hover:bg-white transition-all text-left border border-slate-200 hover:border-blue-300 hover:shadow-sm active:scale-[0.98]"
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
        <div className="border-t border-slate-200 bg-white p-4">
          <form onSubmit={handleSubmit} className="max-w-3xl mx-auto">
            <div className="flex gap-3 items-end">
              <div className="flex-1 relative">
                <textarea
                  ref={inputRef}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="Ask about Publication 1075 compliance..."
                  rows={1}
                  className="w-full resize-none px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-sm text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400 transition-all"
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
                    ? "bg-blue-600 hover:bg-blue-700 text-white active:scale-95"
                    : "bg-slate-100 text-slate-400 cursor-not-allowed"
                )}
              >
                {loading ? (
                  <Loader2 className="w-5 h-5 animate-spin" />
                ) : (
                  <Send className="w-5 h-5" />
                )}
              </button>
            </div>
            <p className="text-xs text-slate-400 mt-2 text-center">
              Never enter FTI/PII data. All inputs are scanned and blocked if
              sensitive data is detected.
            </p>
          </form>
        </div>
      </div>
    </div>
  );
}
