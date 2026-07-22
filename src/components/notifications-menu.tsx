"use client";

import { useState, useRef, useEffect, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { Bell, X } from "lucide-react";

interface Notification {
    id: string;
    title: string;
    description: string;
    time: string;
    icon: typeof Bell;
    color: string;
    bgColor: string;
    borderColor: string;
}

// Runtime source status must come from verified server-side checks. Do not
// present hard-coded connectivity, credential, benchmark, or corpus claims.
const defaultNotifications: Notification[] = [];
const subscribeToClient = () => () => {};

export function NotificationsMenu() {
    const [isOpen, setIsOpen] = useState(false);
    const [notifications, setNotifications] = useState<Notification[]>(defaultNotifications);
    const menuRef = useRef<HTMLDivElement>(null);
    const buttonRef = useRef<HTMLButtonElement>(null);
    const [dropdownStyles, setDropdownStyles] = useState<{ top: number; left: number; maxHeight: number }>({ top: 0, left: 16, maxHeight: 400 });
    const mounted = useSyncExternalStore(subscribeToClient, () => true, () => false);

    // Close when clicking outside
    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (menuRef.current && !menuRef.current.contains(event.target as Node) &&
                buttonRef.current && !buttonRef.current.contains(event.target as Node)) {
                setIsOpen(false);
            }
        };
        document.addEventListener("mousedown", handleClickOutside);
        return () => document.removeEventListener("mousedown", handleClickOutside);
    }, []);

    const toggleMenu = () => {
        if (!isOpen && buttonRef.current) {
            const rect = buttonRef.current.getBoundingClientRect();
            const dropdownWidth = Math.min(384, window.innerWidth - 32);
            let calculatedLeft = rect.left + (rect.width / 2) - Math.floor(dropdownWidth / 2);

            if (calculatedLeft + dropdownWidth > window.innerWidth - 16) {
                calculatedLeft = window.innerWidth - 16 - dropdownWidth;
            }
            if (calculatedLeft < 16) {
                calculatedLeft = 16;
            }

            const availableHeight = window.innerHeight - rect.bottom - 20;
            setDropdownStyles({
                top: rect.bottom + 8,
                left: calculatedLeft,
                maxHeight: Math.min(availableHeight, 600)
            });
        }
        setIsOpen(!isOpen);
    };

    const dismissNotification = (id: string) => {
        setNotifications(prev => prev.filter(n => n.id !== id));
    };

    const clearAll = () => {
        setNotifications([]);
        setIsOpen(false);
    };

    return (
        <div className="relative z-[999999]">
            <button
                ref={buttonRef}
                onClick={toggleMenu}
                className="relative p-2 rounded-full transition-colors hover:bg-slate-800/50 text-slate-400 hover:text-white"
                aria-label="View notifications"
            >
                <Bell className="w-5 h-5" />
                {notifications.length > 0 && (
                    <span className="absolute top-1.5 right-1.5 w-2 h-2 rounded-full bg-red-500 ring-2 ring-[var(--sky-navy)]" />
                )}
            </button>

            {isOpen && mounted && createPortal(
                <div
                    ref={menuRef}
                    className="fixed w-[calc(100vw-32px)] sm:w-96 bg-slate-800 rounded-xl border border-slate-600 shadow-2xl z-[999999] overflow-hidden transform transition-all animate-in fade-in slide-in-from-top-2 flex flex-col"
                    style={{
                        top: dropdownStyles.top,
                        left: dropdownStyles.left,
                        maxHeight: dropdownStyles.maxHeight
                    }}
                >
                    {/* Header */}
                    <div className="px-4 py-3 border-b border-slate-700 bg-slate-900/50 flex justify-between items-center">
                        <h3 className="font-semibold text-white">Notifications</h3>
                        {notifications.length > 0 && (
                            <span className="text-xs px-2 py-0.5 rounded-full bg-sky-500/20 text-sky-400 font-medium">
                                {notifications.length} New
                            </span>
                        )}
                    </div>

                    {/* List */}
                    <div className="overflow-y-auto flex-1 overscroll-contain">
                        {notifications.length === 0 ? (
                            <div className="p-8 text-center text-slate-500 text-sm">
                                No new notifications
                            </div>
                        ) : (
                            notifications.map((notif) => (
                                <div
                                    key={notif.id}
                                    className="p-4 border-b last:border-0 border-slate-700/30 hover:bg-slate-800/30 transition-colors flex gap-4 group"
                                >
                                    <div className={`mt-1 flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center border ${notif.bgColor} ${notif.borderColor} ${notif.color}`}>
                                        <notif.icon className="w-4 h-4" />
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        <p className="text-sm font-medium text-white mb-1">
                                            {notif.title}
                                        </p>
                                        <p className="text-xs text-slate-400 mb-2 leading-relaxed">
                                            {notif.description}
                                        </p>
                                        <p className="text-[10px] font-medium text-slate-500 uppercase tracking-wider">
                                            {notif.time}
                                        </p>
                                    </div>
                                    <button
                                        onClick={(e) => { e.stopPropagation(); dismissNotification(notif.id); }}
                                        className="opacity-0 group-hover:opacity-100 transition-opacity text-slate-500 hover:text-white p-1 self-start"
                                        aria-label="Dismiss"
                                    >
                                        <X className="w-3.5 h-3.5" />
                                    </button>
                                </div>
                            ))
                        )}
                    </div>

                    {/* Footer */}
                    {notifications.length > 0 && (
                        <div className="p-3 border-t border-slate-700 bg-slate-900/50 text-center">
                            <button
                                onClick={clearAll}
                                className="text-xs text-sky-400 hover:text-sky-300 font-medium transition-colors"
                            >
                                Clear all notifications
                            </button>
                        </div>
                    )}
                </div>,
                document.body
            )}
        </div>
    );
}
