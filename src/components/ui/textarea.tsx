"use client";

import * as React from "react";

import { cn } from "@/lib/utils";

const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className, ...props }, ref) => {
  return (
    <textarea
      className={cn(
        "flex min-h-[80px] w-full rounded-md border border-[var(--sky-border)] bg-white px-3 py-2 text-sm text-gray-900 ring-offset-white placeholder:text-[var(--sky-text-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 dark:border-[var(--sky-border)] bg-[var(--sky-navy)] dark:text-gray-50 dark:ring-offset-gray-950 dark:placeholder:text-[var(--sky-text-muted)] dark:focus-visible:ring-blue-400",
        className
      )}
      ref={ref}
      {...props}
    />
  );
});
Textarea.displayName = "Textarea";

export { Textarea };

