import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-[var(--sky-blue)] focus:ring-offset-2",
  {
    variants: {
      variant: {
        default:
          "border-transparent bg-[var(--sky-royal)] text-white hover:bg-[var(--sky-blue)] dark:bg-[var(--sky-royal)] dark:hover:bg-[var(--sky-blue)]",
        secondary:
          "border-transparent bg-[var(--sky-surface-overlay)] text-gray-900 hover:bg-[var(--sky-surface-overlay)] bg-[var(--sky-surface-overlay)] dark:text-gray-50 dark:hover:bg-gray-700",
        destructive:
          "border-transparent bg-red-600 text-white hover:bg-red-700 dark:bg-red-600 dark:hover:bg-red-700",
        outline:
          "text-gray-900 border-[var(--sky-border)] dark:text-gray-50 dark:border-[var(--sky-border)]",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <div className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}

export { Badge, badgeVariants };

