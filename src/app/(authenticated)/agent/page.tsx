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
  Shield,
  Flag,
  PanelLeftClose,
  PanelLeft,
  Sparkles,
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

function TypingIndicator() {
  return (
    <div className="flex gap-4 max-w-3xl">
      <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-blue-600 to-blue-700 flex items-center justify-center shrink-0 shadow-sm">
        <Shield className="w-4 h-4 text-white" />
      </div>
      <div className="bg-gray-100 dark:bg-gray-800/80 rounded-2xl rounded-tl-md p-4 border border-gray-200 dark:border-gray-700/50">
        <div className="flex items-center gap-3">
          <div className="flex gap-1">
            <span className="w-2 h-2 bg-blue-500 rounded-full animate-bounce" style={{ animationDelay: "0ms" }} />
            <span className="w-2 h-2 bg-blue-500 rounded-full animate-bounce" style={{ animationDelay: "150ms" }} />
            <span className="w-2 h-2 bg-blue-500 rounded-full animate-bounce" style={{ animationDelay: "300ms" }} />
          </div>
          <span className="text-sm text-gray-500 dark:text-gray-400">
            Analyzing Publication 1075...
          </span>
        </div>
      </div>
    </div>
  );
}

function MessageBubble({ msg }: { msg: Message }) {
  // Simple markdown-like rendering for bold and bullet points
  function renderContent(content: string) {
    const lines = content.split("\n");
    return lines.map((line, i) => {
      // Bold text
      let processed = line.replace(
        /\*\*(.+?)\*\*/g,
        '<strong class="font-semibold">$1</strong>'
      );
      // Inline code
      processed = processed.replace(
        /`(.+?)`/g,
        '<code class="px-1.5 py-0.5 bg-gray-200 dark:bg-gray-700 rounded text-xs font-mono">$1</code>'
      );

      const isBullet = /^[-•]\s/.test(line) || /^\d+\.\s/.test(line);

      return (
        <span
          key={i}
          className={cn(isBullet && "block ml-2")}
          dangerouslySetInnerHTML={{ __html: processed || "&nbsp;" }}
        />
      );
    });
  }

  if (msg.piiBlocked) {
    return (
      <div className="flex gap-4 max-w-3xl animate-in slide-in-from-bottom-2 duration-300">
        <div className="w-8 h-8 rounded-lg bg-red-600 flex items-center justify-center shrink-0 mt-1 shadow-sm">
          <AlertTriangle className="w-4 h-4 text-white" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-2xl rounded-tl-md p-5">
            <div className="flex items-center gap-2 mb-2">
              <AlertTriangle className="w-4 h-4 text-red-600 dark:text-red-400" />
              <span className="text-sm font-semibold text-red-700 dark:text-red-300">
                FTI/PII Detected — Message Blocked
              </span>
            </div>
            <p className="text-sm text-red-600 dark:text-red-400">
              {msg.content}
            </p>
            {msg.piiTypes && msg.piiTypes.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-1.5">
                {msg.piiTypes.map((t) => (
                  <span
                    key={t}
                    className="px-2.5 py-1 text-xs font-medium rounded-full bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300"
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
            <button className="mt-2 flex items-center gap-1.5 text-xs text-red-600 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300 transition-colors">
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
      <div className="flex gap-4 max-w-3xl ml-auto flex-row-reverse animate-in slide-in-from-bottom-2 duration-200">
        <div className="w-8 h-8 rounded-lg bg-blue-600 flex items-center justify-center shrink-0 mt-1 shadow-sm">
          <span className="text-xs font-medium text-white">You</span>
        </div>
        <div className="flex-1 min-w-0 text-right">
          <div className="inline-block text-left bg-blue-600 text-white rounded-2xl rounded-tr-md p-4 shadow-sm">
            <div className="text-sm whitespace-pre-wrap leading-relaxed">
              {msg.content}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex gap-4 max-w-3xl animate-in slide-in-from-bottom-2 duration-300">
      <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-blue-600 to-blue-700 flex items-center justify-center shrink-0 mt-1 shadow-sm">
        <Shield className="w-4 h-4 text-white" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="bg-gray-100 dark:bg-gray-800/80 rounded-2xl rounded-tl-md p-4 border border-gray-200 dark:border-gray-700/50">
          <div className="text-sm whitespace-pre-wrap leading-relaxed text-gray-900 dark:text-gray-100">
            {renderContent(msg.content)}
          </div>
        </div>

        {msg.citations && msg.citations.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {msg.citations.map((cite, i) => (
              <span
                key={i}
                className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-lg bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-800 cursor-default"
                title={cite.text || cite.section}
              >
                <Shield className="w-3 h-3" />
                {cite.section}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

const SUGGESTED_QUESTIONS = [
  "What are the requirements for FTI data encryption at rest?",
  "Explain the incident reporting timeline requirements",
  "What access controls are required for systems handling FTI?",
  "What are the physical security requirements for FTI?",
];

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

    // Reset textarea height
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
          "border-r border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 flex flex-col transition-all duration-200",
          showSidebar ? "w-72" : "w-0 overflow-hidden"
        )}
      >
        <div className="p-4 border-b border-gray-200 dark:border-gray-800">
          <button
            onClick={startNewConversation}
            className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-blue-600 hover:bg-blue-500 text-white rounded-xl text-sm font-medium transition-all active:scale-[0.98] shadow-sm"
          >
            <Plus className="w-4 h-4" />
            New Conversation
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
          {conversations.length === 0 && (
            <p className="text-sm text-gray-400 text-center py-8">
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
                  ? "bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300 shadow-sm"
                  : "text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800"
              )}
            >
              <div className="flex items-center gap-2">
                {conv.bookmarked ? (
                  <Bookmark className="w-3.5 h-3.5 text-amber-500 shrink-0 fill-amber-500" />
                ) : (
                  <MessageSquare className="w-3.5 h-3.5 text-gray-400 shrink-0" />
                )}
                <span className="truncate">{conv.title}</span>
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Chat Area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Chat Header */}
        <div className="flex items-center justify-between px-6 py-3 border-b border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950">
          <div className="flex items-center gap-3">
            <button
              onClick={() => setShowSidebar(!showSidebar)}
              className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 transition-colors"
            >
              {showSidebar ? (
                <PanelLeftClose className="w-5 h-5" />
              ) : (
                <PanelLeft className="w-5 h-5" />
              )}
            </button>
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-blue-600 to-blue-700 flex items-center justify-center">
                <Sparkles className="w-3.5 h-3.5 text-white" />
              </div>
              <div>
                <h2 className="text-sm font-semibold text-gray-900 dark:text-white">
                  Pub 1075 AI Agent
                </h2>
                <p className="text-xs text-gray-500">
                  Powered by Claude — All responses cite Pub 1075 sections
                </p>
              </div>
            </div>
          </div>
          {conversationId && (
            <button
              onClick={toggleBookmark}
              className="text-gray-400 hover:text-amber-500 transition-colors p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800"
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
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {messages.length === 0 && (
            <div className="flex flex-col items-center justify-center h-full text-center max-w-lg mx-auto">
              <div className="w-20 h-20 rounded-2xl bg-gradient-to-br from-blue-600 to-blue-700 flex items-center justify-center mb-5 shadow-lg shadow-blue-600/20">
                <Shield className="w-10 h-10 text-white" />
              </div>
              <h3 className="text-xl font-bold text-gray-900 dark:text-white mb-2">
                Publication 1075 AI Agent
              </h3>
              <p className="text-sm text-gray-500 dark:text-gray-400 mb-8 leading-relaxed">
                Ask any question about IRS Publication 1075 compliance
                requirements. All responses include specific section citations.
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 w-full text-left">
                {SUGGESTED_QUESTIONS.map((q) => (
                  <button
                    key={q}
                    onClick={() => handleSuggestedQuestion(q)}
                    className="px-4 py-3 text-sm text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-800 rounded-xl hover:bg-gray-200 dark:hover:bg-gray-700 transition-all text-left border border-transparent hover:border-blue-200 dark:hover:border-blue-800 active:scale-[0.98]"
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
        <div className="border-t border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 p-4">
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
                  className="w-full resize-none px-4 py-3 bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl text-sm text-gray-900 dark:text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500/50 transition-all"
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
                    ? "bg-blue-600 hover:bg-blue-500 text-white active:scale-95"
                    : "bg-gray-200 dark:bg-gray-800 text-gray-400 cursor-not-allowed"
                )}
              >
                {loading ? (
                  <Loader2 className="w-5 h-5 animate-spin" />
                ) : (
                  <Send className="w-5 h-5" />
                )}
              </button>
            </div>
            <p className="text-xs text-gray-400 mt-2 text-center">
              Never enter FTI/PII data. All inputs are scanned and blocked if
              sensitive data is detected.
            </p>
          </form>
        </div>
      </div>
    </div>
  );
}
